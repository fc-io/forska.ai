/**
 * Launch SGLang on MareNostrum 5 and wait for it to be ready
 * Usage: bun run mn5:launch [--force] [--model <id>]
 */

import {$, spawn} from 'bun'

const MN5_ROOT = '/gpfs/projects/ehpc482/dev'
const TLOG = 'tlog' // Transfer login
const GLOG = 'glog' // General login (for sbatch)
const ALOG = 'alog' // ACC login (for tunnel)
// Port scheme: Direct per-node tunnels
// localhost:30001 -> node1:30002 (Caddy) -> SGLang:30001
// localhost:30002 -> node2:30002 (Caddy) -> SGLang:30001
// This matches what sbatch outputs in WORKER_URLS_LOCAL
const REMOTE_CADDY_PORT = 30002 // Remote Caddy H2 port on each HPC node
const LOCAL_PORT_BASE = 30001 // Local tunnel ports start here (30001, 30002, ...)
const SBATCH_FILE = 'forska-mn5-sglang.sbatch'

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

const monitorTunnelHealth = async (jobId: string, allNodes: string[], localPorts: number[]): Promise<void> => {
  if (isShuttingDown) return

  // Check if ALL local worker endpoints are responding
  const portHealthResults = await Promise.all(
    localPorts.map(async (port) => {
      const isOk = await isLocalSGLangResponding(port)
      return {port, isOk}
    }),
  )

  const failedPorts = portHealthResults.filter((r) => {
    return !r.isOk
  })
  const allOk = failedPorts.length === 0

  if (allOk) {
    await sleep(10_000)
    return monitorTunnelHealth(jobId, allNodes, localPorts)
  }

  // Log which specific ports are failing
  const failedPortList = failedPorts
    .map((r) => {
      return r.port
    })
    .join(', ')
  log(`⚠ ${failedPorts.length}/${localPorts.length} worker(s) not responding (ports: ${failedPortList})`)

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
  await startMultiNodeTunnels(nodesToUse, jobId, localPorts[0], 1)
}

/**
 * Start SSH tunnels to all nodes and monitor them
 * Creates direct per-node tunnels matching WORKER_URLS_LOCAL from sbatch:
 * - localhost:30001 -> node1:30002 (Caddy)
 * - localhost:30002 -> node2:30002 (Caddy)
 */
const startMultiNodeTunnels = async (
  allNodes: string[],
  jobId: string,
  _localPort: number, // Unused - we use LOCAL_PORT_BASE + i for each node
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

  // Calculate local ports for each node (30001, 30002, etc. to match sbatch WORKER_URLS_LOCAL)
  const localPorts: number[] = []
  for (let i = 0; i < allNodes.length; i++) {
    const localPort = LOCAL_PORT_BASE + i
    localPorts.push(localPort)

    // Ensure port is ready
    const portStatus = await ensureLocalPortReadyForTunnel(localPort)
    if (portStatus === 'in_use') {
      console.error(`[mn5] Local port ${localPort} is in use by a non-SSH process`)
      console.error(`      Stop that process first`)
      process.exit(1)
    }
  }

  // Start tunnel to each node: localhost:3000X -> nodeX:30002 (Caddy)
  for (let i = 0; i < allNodes.length; i++) {
    const node = allNodes[i]
    const localPort = localPorts[i]
    log(`  Tunnel ${i + 1}/${allNodes.length}: localhost:${localPort} -> ${node}:${REMOTE_CADDY_PORT}`)

    const proc = spawnTunnelProcess(node, localPort, REMOTE_CADDY_PORT)
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

  // Check health on ALL local ports (not just the first one)
  const healthResults = await Promise.all(
    localPorts.map(async (port) => {
      const isOk = await isLocalSGLangResponding(port)
      return {port, isOk}
    }),
  )
  const okCount = healthResults.filter((r) => {
    return r.isOk
  }).length
  const failedPorts = healthResults
    .filter((r) => {
      return !r.isOk
    })
    .map((r) => {
      return r.port
    })

  if (okCount === localPorts.length) {
    log(`✓ All ${allNodes.length} tunnel(s) connected and SGLang responding`)
  } else if (okCount > 0) {
    log(`⚠ ${okCount}/${localPorts.length} tunnels responding, failed ports: ${failedPorts.join(', ')}`)
  } else {
    log('⚠ Tunnels started but no SGLang health checks passed (may still be starting)')
  }

  // Show all worker URLs
  const workerUrls = localPorts
    .map((p) => {
      return `http://localhost:${p}`
    })
    .join(', ')
  log(`SGLang workers available at: ${workerUrls}`)
  log(`Press Ctrl+C to disconnect and cancel job ${jobId}`)

  // Monitor tunnel health on ALL ports (not just the first one)
  await monitorTunnelHealth(jobId, allNodes, localPorts)
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
        await $`ssh ${ALOG} "curl -sf --connect-timeout 2 --max-time 3 http://${node}:${REMOTE_CADDY_PORT}/v1/models 2>/dev/null && echo OK || echo NOTREADY"`.text()
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
  let localPort = LOCAL_PORT_BASE

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') force = true
    else if (args[i] === '--model') model = args[++i]
    else if (args[i] === '--local-port') localPort = Number(args[++i] ?? LOCAL_PORT_BASE)
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
