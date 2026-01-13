/**
 * Launch SGLang on MareNostrum 5 and wait for it to be ready
 * Usage: bun run mn5:launch [--force] [--model <id>]
 */

import {$, spawn} from 'bun'

const MN5_ROOT = '/gpfs/projects/ehpc482/dev'
const TLOG = 'tlog' // Transfer login
const GLOG = 'glog' // General login (for sbatch)
const ALOG = 'alog' // ACC login (for tunnel)
// Port scheme: Local Caddy (:30002) -> SSH tunnel (:40002+) -> HPC Caddy (:30002) -> SGLang (:30001)
// Multi-node: Each node gets its own tunnel port (40002, 40003, ...)
const CADDY_PORT = 30002 // Remote Caddy H2 port (what we tunnel to on each node)
const DEFAULT_LOCAL_PORT = 30002 // Local port exposed to app (Caddy listens here)
const TUNNEL_PORT_BASE = 40002 // Local tunnel endpoint base (Caddy proxies to these via H2)
const SBATCH_FILE = 'forska-mn5-sglang.sbatch'
const DOCKER_CONTAINER_NAME = 'forska-caddy'

// Track the active job ID and tunnels for cleanup
let activeJobId: string | null = null
const activeTunnelProcs: ReturnType<typeof spawn>[] = []
let isShuttingDown = false

const log = (m: string): void => {
  console.log(`[mn5] ${m}`)
}

const cancelJob = async (jobId: string): Promise<void> => {
  log(`Cancelling job ${jobId}...`)
  try {
    await $`ssh ${GLOG} "scancel ${jobId} 2>/dev/null || true"`.quiet()
    log('Job cancelled')
  } catch {
    // Ignore errors - job may already be gone
  }
}

const setupSignalHandler = (): void => {
  const cleanup = async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true
    console.log('') // New line after ^C
    // Stop Docker Caddy
    await stopDockerCaddy()
    // Kill all tunnel processes
    for (const proc of activeTunnelProcs) {
      try {
        proc.kill()
      } catch {
        // Ignore
      }
    }
    if (activeJobId) {
      await cancelJob(activeJobId)
    }
    log(`Exiting (${signal})`)
    process.exit(0)
  }

  process.on('SIGINT', () => {
    return void cleanup('SIGINT')
  })
  process.on('SIGTERM', () => {
    return void cleanup('SIGTERM')
  })
}

// Docker Caddy management
const stopDockerCaddy = async (): Promise<void> => {
  try {
    await $`docker rm -f ${DOCKER_CONTAINER_NAME} 2>/dev/null || true`.quiet()
  } catch {
    // Ignore
  }
}

const generateCaddyfile = (localPort: number, tunnelPorts: number[]): string => {
  // Build upstream list for round-robin load balancing across all nodes
  const upstreams = tunnelPorts
    .map((port) => {
      return `host.docker.internal:${port}`
    })
    .join(' ')
  return `{
  auto_https off
}
:${localPort} {
  reverse_proxy ${upstreams} {
    lb_policy round_robin
    transport http {
      versions h2c
    }
  }
}
`
}

const startDockerCaddy = async (localPort: number, tunnelPorts: number[]): Promise<void> => {
  log(`Starting local Docker Caddy for H2 multiplexing (${tunnelPorts.length} backend(s))...`)

  // Stop any existing container
  await stopDockerCaddy()

  // Generate Caddyfile with all tunnel ports as upstreams
  const caddyfile = generateCaddyfile(localPort, tunnelPorts)
  const caddyfilePath = '/tmp/forska-Caddyfile'
  await Bun.write(caddyfilePath, caddyfile)
  const upstreamsList = tunnelPorts
    .map((p) => {
      return `host.docker.internal:${p}`
    })
    .join(', ')
  log(`Generated Caddyfile: localhost:${localPort} -> H2c round-robin -> [${upstreamsList}]`)

  // Start Docker container
  const result = await $`docker run -d --name ${DOCKER_CONTAINER_NAME} \
    -p ${localPort}:${localPort} \
    -v ${caddyfilePath}:/etc/caddy/Caddyfile:ro \
    caddy:2`.text()

  const containerId = result.trim().substring(0, 12)
  log(`Docker Caddy started (container: ${containerId})`)

  // Give it a moment to start
  await sleep(1000)

  // Verify it's running
  const status = await $`docker inspect -f '{{.State.Running}}' ${DOCKER_CONTAINER_NAME}`.text()
  if (!status.trim().includes('true')) {
    const logs = await $`docker logs ${DOCKER_CONTAINER_NAME} 2>&1 || true`.text()
    throw new Error(`Docker Caddy failed to start: ${logs}`)
  }
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => {
    setTimeout(r, ms)
  })
}

type SqueueJob = {jobId: string; state: string; nodeList: string}

const parseSqueueJobLine = (line: string): SqueueJob | undefined => {
  const [jobId, state, nodeList] = line.split('|').map((part) => {
    return part.trim()
  })

  return jobId && state ? {jobId, state, nodeList: nodeList ?? ''} : undefined
}

const getFirstNodeFromNodeList = async (nodeList: string): Promise<string | undefined> => {
  const nodes = await getAllNodesFromNodeList(nodeList)
  return nodes.length > 0 ? nodes[0] : undefined
}

const getAllNodesFromNodeList = async (nodeList: string): Promise<string[]> => {
  const trimmed = nodeList.trim()
  if (!trimmed || trimmed === '(null)' || trimmed === 'n/a') return []

  // If no brackets, it's a simple comma-separated list
  if (!trimmed.includes('[')) {
    return trimmed
      .split(',')
      .map((n) => {
        return n.trim()
      })
      .filter((n) => {
        return n.length > 0
      })
  }

  // Use scontrol to expand compressed node list (e.g., "as02r3b[05,16]" -> "as02r3b05\nas02r3b16")
  const expanded = await $`ssh ${GLOG} "scontrol show hostnames '${trimmed}' 2>/dev/null || echo ''"`.text()
  return expanded
    .trim()
    .split('\n')
    .map((n) => {
      return n.trim()
    })
    .filter((n) => {
      return n.length > 0
    })
}

const getJobStatus = async (jobId: string): Promise<{state: string; nodeList: string}> => {
  const result = await $`ssh ${GLOG} "squeue -j ${jobId} -h -o '%T|%.200N' 2>/dev/null || echo 'UNKNOWN|'"`.text()
  const [state, nodeList] = result
    .trim()
    .split('|')
    .map((part) => {
      return part.trim()
    })

  return {state: state || 'UNKNOWN', nodeList: nodeList || ''}
}

type LocalPortListener = {command: string; pid: number}

const parseLsofListenerLine = (line: string): LocalPortListener | undefined => {
  const [command, pidRaw] = line
    .trim()
    .split(/\s+/)
    .map((part) => {
      return part.trim()
    })

  const pid = Number(pidRaw)
  return command && Number.isFinite(pid) ? {command, pid} : undefined
}

const getLocalListenersOnPort = async (port: number): Promise<LocalPortListener[]> => {
  const raw = await $`lsof -n -P -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`.text()
  const lines = raw
    .trim()
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.length > 0
    })

  return lines.length <= 1
    ? []
    : lines
        .slice(1)
        .map(parseLsofListenerLine)
        .filter((row): row is LocalPortListener => {
          return Boolean(row)
        })
}

const isLocalSGLangResponding = async (localPort: number): Promise<boolean> => {
  const result =
    await $`curl -sf --connect-timeout 2 --max-time 3 http://localhost:${localPort}/v1/models 2>/dev/null || echo ''`.text()
  const trimmed = result.trim()
  return trimmed.includes('"data"') || trimmed.includes('"object"') || trimmed.includes('"id"')
}

const killSshListenersOnPort = async (port: number): Promise<void> => {
  const listeners = await getLocalListenersOnPort(port)
  const sshPids = listeners
    .filter((l) => {
      return l.command === 'ssh' || l.command === 'autossh'
    })
    .map((l) => {
      return l.pid
    })

  return sshPids.length === 0 ? undefined : void (await $`kill ${sshPids.join(' ')} 2>/dev/null || true`)
}

const interpretExitCode = (code: number): string => {
  const exitCodes: Record<number, string> = {
    0: 'Normal exit',
    1: 'General error (local issue or remote command failed)',
    255: 'SSH connection failed (network/auth/remote issue)',
    130: 'Interrupted (Ctrl+C)',
    137: 'Killed (SIGKILL)',
    143: 'Terminated (SIGTERM)',
  }
  return exitCodes[code] || `Unknown exit code ${code}`
}

const ensureLocalPortReadyForTunnel = async (localPort: number): Promise<'ready' | 'in_use'> => {
  const alreadyOk = await isLocalSGLangResponding(localPort)
  if (alreadyOk) return 'ready'

  const listeners = await getLocalListenersOnPort(localPort)
  if (listeners.length === 0) return 'ready'

  const onlySsh = listeners.every((l) => {
    return l.command === 'ssh' || l.command === 'autossh'
  })

  if (!onlySsh) {
    log(
      `Local port ${localPort} already in use: ${listeners
        .map((l) => {
          return `${l.command}:${l.pid}`
        })
        .join(', ')}`,
    )
    return 'in_use'
  }

  log(`Killing existing SSH tunnel(s) on port ${localPort}...`)
  await killSshListenersOnPort(localPort)
  await sleep(500)
  return 'ready'
}

const spawnTunnelProcess = (computeNode: string, localTunnelPort: number, remoteCaddyPort: number) => {
  const logFile = Bun.file('mn5-tunnel-debug.txt')
  const proc = spawn(
    [
      'ssh',
      '-C', // Compression
      '-vv', // Verbose logging
      '-N',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'ServerAliveInterval=60', // Relaxed keepalive (was 30)
      '-o',
      'ServerAliveCountMax=10', // Relaxed keepalive (was 3)
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `${localTunnelPort}:${computeNode}:${remoteCaddyPort}`,
      ALOG,
    ],
    {stdout: 'inherit', stderr: 'pipe', stdin: 'inherit'},
  )

  // Stream stderr to file only (verbose logging is too noisy for console)
  Bun.write(logFile, proc.stderr).catch((err) => {
    console.error('Failed to write tunnel logs:', err)
  })

  return proc
}

const monitorTunnelHealth = async (jobId: string, allNodes: string[], localPort: number): Promise<void> => {
  if (isShuttingDown) return

  // Check if the local Caddy endpoint is responding
  const localOk = await isLocalSGLangResponding(localPort)
  if (localOk) {
    await sleep(10_000)
    return monitorTunnelHealth(jobId, allNodes, localPort)
  }

  log(`Local SGLang not responding on :${localPort}, checking tunnels...`)

  // Check job is still running
  const {state, nodeList} = await getJobStatus(jobId)
  if (state !== 'RUNNING') {
    log(`Job ${jobId} is ${state}; exiting`)
    process.exit(0)
  }

  // Get updated node list
  const refreshedNodes = await getAllNodesFromNodeList(nodeList)
  const nodesToUse = refreshedNodes.length > 0 ? refreshedNodes : allNodes

  // Restart all tunnels with the current node list
  await startMultiNodeTunnels(nodesToUse, jobId, localPort, 1)
}

/**
 * Start SSH tunnels to all nodes and monitor them
 */
const startMultiNodeTunnels = async (
  allNodes: string[],
  jobId: string,
  localPort: number,
  restartCount: number,
): Promise<void> => {
  if (isShuttingDown) return

  // Set active job for signal handler
  activeJobId = jobId
  const restartSuffix = restartCount > 0 ? ` (restart #${restartCount})` : ''
  log(`Starting SSH tunnels to ${allNodes.length} node(s)${restartSuffix}`)

  // Kill any existing tunnels
  for (const proc of activeTunnelProcs) {
    try {
      proc.kill()
    } catch {
      // Ignore
    }
  }
  activeTunnelProcs.length = 0 // Clear array

  // Calculate tunnel ports for each node
  const tunnelPorts: number[] = []
  for (let i = 0; i < allNodes.length; i++) {
    const tunnelPort = TUNNEL_PORT_BASE + i
    tunnelPorts.push(tunnelPort)

    // Ensure port is ready
    const portStatus = await ensureLocalPortReadyForTunnel(tunnelPort)
    if (portStatus === 'in_use') {
      console.error(`[mn5] Tunnel port ${tunnelPort} is in use by a non-SSH process`)
      console.error(`      Stop that process first`)
      process.exit(1)
    }
  }

  // Start tunnel to each node
  for (let i = 0; i < allNodes.length; i++) {
    const node = allNodes[i]
    const tunnelPort = tunnelPorts[i]
    log(`  Tunnel ${i + 1}/${allNodes.length}: localhost:${tunnelPort} -> ${node}:${CADDY_PORT}`)

    const proc = spawnTunnelProcess(node, tunnelPort, CADDY_PORT)
    activeTunnelProcs.push(proc)

    // Set up exit handler for this tunnel
    proc.exited
      .then((exitCode) => {
        if (isShuttingDown) return
        const interpretation = interpretExitCode(exitCode)
        log(`🔴 Tunnel to ${node} exited (code=${exitCode}): ${interpretation}`)
      })
      .catch(() => {})
  }

  // Wait for tunnels to establish
  await sleep(2000)

  // Start Docker Caddy with all tunnel ports
  await startDockerCaddy(localPort, tunnelPorts)

  // Wait a bit more and check health
  await sleep(1000)
  const ok = await isLocalSGLangResponding(localPort)
  log(
    ok
      ? `✓ All ${allNodes.length} tunnel(s) connected and SGLang responding`
      : '⚠ Tunnels started but SGLang health check failed (may still be starting)',
  )
  log(`SGLang API available at http://localhost:${localPort}/v1`)
  log(`Press Ctrl+C to disconnect and cancel job ${jobId}`)

  // Monitor tunnel health
  await monitorTunnelHealth(jobId, allNodes, localPort)
}

/**
 * Wait for SGLang to be ready on all nodes (via Caddy proxy)
 */
const waitForSGLangReady = async (allNodes: string[]): Promise<boolean> => {
  // Wait for SGLang to be ready on all nodes (can take 10-20 min for large models)
  log(`Waiting for SGLang to start on ${allNodes.length} node(s) (this can take 10-20 minutes for large models)...`)

  for (let i = 0; i < 240; i++) {
    // Wait up to 40 minutes
    let allReady = true
    const readyNodes: string[] = []

    for (const node of allNodes) {
      // Check via Caddy port (30002) which proxies to SGLang (30001)
      const checkWorker =
        await $`ssh ${ALOG} "curl -sf --connect-timeout 2 --max-time 3 http://${node}:${CADDY_PORT}/v1/models 2>/dev/null && echo OK || echo NOTREADY"`.text()
      if (checkWorker.includes('OK') && checkWorker.includes('data')) {
        readyNodes.push(node)
      } else {
        allReady = false
      }
    }

    if (allReady) {
      log(`All ${allNodes.length} SGLang worker(s) are ready!`)
      return true
    }

    if (i % 30 === 0 && i > 0) {
      log(
        `Still loading model... (${Math.floor((i * 10) / 60)} min elapsed, ${readyNodes.length}/${allNodes.length} ready)`,
      )
    }
    await sleep(10000)
  }

  log('Timed out waiting for SGLang readiness (it may still be starting)')
  return false
}

const main = async () => {
  setupSignalHandler()

  const args = process.argv.slice(2)
  let model: string | undefined
  let force = false
  let localPort = DEFAULT_LOCAL_PORT

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') force = true
    else if (args[i] === '--model') model = args[++i]
    else if (args[i] === '--local-port') localPort = Number(args[++i] ?? DEFAULT_LOCAL_PORT)
  }

  // 1. Check for existing pending/running jobs
  log('Checking for existing jobs...')
  const existingJobsOutput =
    await $`ssh ${GLOG} "squeue -u \\$USER -n forska-mn5-sglang -h -o '%i|%T|%.200N' 2>/dev/null || echo ''"`.text()
  const existingJobs = existingJobsOutput
    .trim()
    .split('\n')
    .map(parseSqueueJobLine)
    .filter((job): job is SqueueJob => {
      return Boolean(job)
    })

  const existingRunningJob = existingJobs.find((job) => {
    return job.state === 'RUNNING'
  })

  if (existingRunningJob && !force) {
    const allNodes = await getAllNodesFromNodeList(existingRunningJob.nodeList)
    if (allNodes.length > 0) {
      log(`Found running job: ${existingRunningJob.jobId} on ${allNodes.length} node(s): ${allNodes.join(', ')}`)
      log('Reusing existing job (use --force to submit a new one)')
      await waitForSGLangReady(allNodes)
      // Start tunnels to all nodes
      await startMultiNodeTunnels(allNodes, existingRunningJob.jobId, localPort, 0)
      return
    }
  }

  const existingPendingJob = existingJobs.find((job) => {
    return job.state === 'PENDING'
  })

  if (existingPendingJob && !force) {
    log(`Found pending job: ${existingPendingJob.jobId}`)
    log('Waiting for existing job to start (use --force to submit a new one)')

    let allNodes: string[] = []
    for (let i = 0; i < 720; i++) {
      const {state, nodeList} = await getJobStatus(existingPendingJob.jobId)

      if (state === 'RUNNING') {
        allNodes = await getAllNodesFromNodeList(nodeList)
        if (allNodes.length > 0) {
          log(`Job running on ${allNodes.length} node(s): ${allNodes.join(', ')}`)
          break
        }
      } else if (state === 'FAILED' || state === 'CANCELLED' || state === 'UNKNOWN' || !state) {
        log('Existing job ended, will submit a new one')
        break
      }

      if (i % 12 === 0) log(`Still pending... (${i * 5}s)`)
      await sleep(5000)
    }

    if (allNodes.length > 0) {
      await waitForSGLangReady(allNodes)
      // Start tunnels to all nodes
      await startMultiNodeTunnels(allNodes, existingPendingJob.jobId, localPort, 0)
      return
    }
  }

  // 2. Copy sbatch file to MN5
  log('Deploying sbatch file...')
  await $`scp ${SBATCH_FILE} ${TLOG}:${MN5_ROOT}/`

  // 3. Submit job
  log('Submitting job...')
  const exportVars = model ? `ALL,SGLANG_MODEL=${model}` : 'ALL'
  const result = await $`ssh ${GLOG} "cd ${MN5_ROOT} && sbatch --export=${exportVars} ${SBATCH_FILE}"`.text()
  const jobIdMatch = result.match(/Submitted batch job (\d+)/)
  if (!jobIdMatch) {
    console.error('Failed to submit job:', result)
    process.exit(1)
  }
  const jobId = jobIdMatch[1]
  activeJobId = jobId // Set for cleanup
  log(`Job submitted: ${jobId}`)

  // 4. Wait for job to start running (HPC queues can be slow)
  log('Waiting for job to start (this may take a while in the queue)...')
  let allNodes: string[] = []
  for (let i = 0; i < 720; i++) {
    // Wait up to 60 minutes
    const {state, nodeList} = await getJobStatus(jobId)

    if (state === 'RUNNING') {
      allNodes = await getAllNodesFromNodeList(nodeList)
      if (allNodes.length > 0) {
        log(`Job running on ${allNodes.length} node(s): ${allNodes.join(', ')}`)
        break
      }
    } else if (state === 'PENDING') {
      if (i % 12 === 0) log(`Still pending... (${i * 5}s)`)
    } else if (state === 'FAILED' || state === 'CANCELLED' || state === 'UNKNOWN') {
      console.error(`Job ${jobId} failed or was cancelled`)
      process.exit(1)
    }
    await sleep(5000)
  }

  if (allNodes.length === 0) {
    console.error('Timeout waiting for job to start')
    process.exit(1)
  }

  // 5. Wait for SGLang on all nodes, then start tunnels with H2 proxy
  await waitForSGLangReady(allNodes)
  await startMultiNodeTunnels(allNodes, jobId, localPort, 0)
}

void main()
