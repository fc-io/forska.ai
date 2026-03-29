/**
 * Launch SGLang on MareNostrum 5 and wait for it to be ready
 * Usage: bun run mn5:launch [--force] [--model <id>] [--large-context]
 */

import {resolve} from 'path'

import {$, spawn} from 'bun'

import {
  createProviderRuntimeRecord,
  markProviderRuntimeRecordStopped,
  writeProviderRuntimeRecord,
} from '../src/utils/providerRuntimeRecords.ts'

const MN5_ROOT = '/gpfs/projects/ehpc482/dev'
const TLOG = 'tlog' // Transfer login
const GLOG = 'glog' // General login (for sbatch)
const ALOG = 'alog' // ACC login (for tunnel)
// Port scheme: Local Caddy -> SSH tunnel -> remote Caddy -> SGLang
// localhost:30001 -> local Caddy -> localhost:40001 -> node1:30002 -> SGLang:30001
// localhost:30002 -> local Caddy -> localhost:40002 -> node2:30002 -> SGLang:30001
// Local ports match what sbatch outputs in WORKER_URLS_LOCAL
const REMOTE_CADDY_PORT = 30002 // Remote Caddy H2 port on each HPC node
const LOCAL_PORT_BASE = 30001 // Local Caddy ports start here (30001, 30002, ...)
const LOCAL_TUNNEL_PORT_OFFSET = 10000
const LOCAL_CADDY_CONTAINER_NAME = 'forska-caddy'
const LOCAL_CADDY_IMAGE = 'caddy:2.8.4-alpine'
const LOCAL_CADDYFILE_PATH = 'cache/mn5Local.Caddyfile'
const DEFAULT_SBATCH_FILE = 'forska-mn5-sglang.sbatch'
const LARGE_CONTEXT_SATCH_FILE = 'forska-mn5-sglang-largre-context.sbatch'
const DEFAULT_JOB_NAME = 'forska-mn5-sglang'
const LARGE_CONTEXT_JOB_NAME = 'forska-mn5-sglang-large-context'

// Track the active job ID and tunnels for cleanup
let activeJobId: string | null = null
let activeJobName: string | null = null
const activeTunnelProcs: ReturnType<typeof spawn>[] = []
let isShuttingDown = false

type MN5RuntimeConfig = {
  DP_SIZE: string
  GPUS_PER_NODE: string
  NNODES: string
  SGLANG_API_MAX_BURST_REQUESTS: string
  SGLANG_API_MAX_INFLIGHT_REQUESTS: string
  SGLANG_LOCAL_PORT_BASE: string
  SGLANG_MAX_RUNNING_REQUESTS: string
  SGLANG_MODEL: string
  TP_SIZE: string
  WORKER_URLS: string
  WORKER_URLS_LOCAL: string
}

const log = (m: string): void => {
  console.log(`[mn5] ${m}`)
}

const splitCsv = (value: string | null | undefined): string[] => {
  return String(value ?? '')
    .split(',')
    .map((part) => {
      return part.trim()
    })
    .filter((part) => {
      return part.length > 0
    })
}

const readMn5RuntimeConfig = async (jobId: string): Promise<MN5RuntimeConfig | null> => {
  if (!activeJobName) return null

  const logPath = `${MN5_ROOT}/${activeJobName}-${jobId}.log`
  const logContent = await $`ssh ${ALOG} "cat ${logPath} 2>/dev/null || echo ''"`.text()
  const startMarker = '[mn5:config:start]'
  const endMarker = '[mn5:config:end]'
  const startIndex = logContent.indexOf(startMarker)
  const endIndex = logContent.indexOf(endMarker)

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) return null

  const configBlock = logContent.slice(startIndex + startMarker.length, endIndex)
  const config = configBlock.split('\n').reduce<Partial<MN5RuntimeConfig>>((accumulator, line) => {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.includes('=')) return accumulator

    const [key, ...valueParts] = trimmed.split('=')
    return key ? {...accumulator, [key.trim()]: valueParts.join('=').trim()} : accumulator
  }, {})

  return config.SGLANG_MODEL ? (config as MN5RuntimeConfig) : null
}

const writeMn5RuntimeRecord = async ({
  allNodes,
  jobId,
  localPortBase,
}: {
  allNodes: string[]
  jobId: string
  localPortBase: number
}): Promise<void> => {
  const config = await readMn5RuntimeConfig(jobId)
  const localWorkerUrls = splitCsv(config?.WORKER_URLS_LOCAL)
  const remoteWorkerUrls = splitCsv(config?.WORKER_URLS)

  await writeProviderRuntimeRecord(
    createProviderRuntimeRecord({
      activeModelNames: splitCsv(config?.SGLANG_MODEL),
      dpSize: Number(config?.DP_SIZE ?? '0'),
      gpuGpusPerNode: Number(config?.GPUS_PER_NODE ?? '0'),
      gpuNnodes: Number(config?.NNODES ?? String(allNodes.length)),
      gpuShape: null,
      jobId,
      localWorkerUrls:
        localWorkerUrls.length > 0
          ? localWorkerUrls
          : allNodes.map((_, index) => {
              return `http://localhost:${localPortBase + index}`
            }),
      ppSize: 1,
      providerKind: 'sglang',
      remoteWorkerUrls:
        remoteWorkerUrls.length > 0
          ? remoteWorkerUrls
          : allNodes.map((node) => {
              return `http://${node}:${REMOTE_CADDY_PORT}`
            }),
      sglangApiMaxBurstRequests: Number(config?.SGLANG_API_MAX_BURST_REQUESTS ?? '0'),
      sglangApiMaxInflightRequests: Number(config?.SGLANG_API_MAX_INFLIGHT_REQUESTS ?? '0'),
      sglangMaxRunningRequests: Number(config?.SGLANG_MAX_RUNNING_REQUESTS ?? '0'),
      sourceCluster: 'mn5',
      sshJumpHost: ALOG,
      status: 'active',
      stoppedAt: null,
      tpSize: Number(config?.TP_SIZE ?? '0'),
      updatedAt: Date.now(),
    }),
  )
}

const markMn5RuntimeRecordStopped = async (jobId: string | null): Promise<void> => {
  if (!jobId) return

  await markProviderRuntimeRecordStopped({jobId, sourceCluster: 'mn5'})
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

const buildLocalCaddyfile = (localPorts: number[], tunnelPorts: number[]): string => {
  const siteBlocks = localPorts
    .map((localPort, index) => {
      const tunnelPort = tunnelPorts[index]
      return `:${localPort} {\n  reverse_proxy host.docker.internal:${tunnelPort} {\n    transport http {\n      versions h2c\n    }\n  }\n}`
    })
    .join('\n\n')

  return `{\n  auto_https off\n  servers {\n    protocols h1 h2c\n  }\n}\n${siteBlocks}\n`
}

const writeLocalCaddyfile = async (contents: string): Promise<string> => {
  await Bun.write(LOCAL_CADDYFILE_PATH, contents)
  return LOCAL_CADDYFILE_PATH
}

const stopLocalCaddyContainer = async (): Promise<void> => {
  await $`docker rm -f ${LOCAL_CADDY_CONTAINER_NAME}`.quiet().nothrow()
}

const startLocalCaddyContainer = async (localPorts: number[], tunnelPorts: number[]): Promise<void> => {
  const caddyfilePath = resolve(await writeLocalCaddyfile(buildLocalCaddyfile(localPorts, tunnelPorts)))
  const portArgs = localPorts.flatMap((port) => {
    return ['-p', `${port}:${port}`]
  })
  await stopLocalCaddyContainer()
  const result =
    await $`docker run -d --rm --name ${LOCAL_CADDY_CONTAINER_NAME} ${portArgs} --add-host=host.docker.internal:host-gateway -v ${caddyfilePath}:/etc/caddy/Caddyfile:ro ${LOCAL_CADDY_IMAGE}`.nothrow()
  if (result.exitCode !== 0) {
    console.error('[mn5] Failed to start local Caddy container')
    process.exit(1)
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
    await markMn5RuntimeRecordStopped(activeJobId)
    if (activeJobId) {
      await cancelJob(activeJobId)
    }
    await stopLocalCaddyContainer()
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
  const parts = line.split('|').map((part) => {
    return part.trim()
  })
  const jobId = parts[0]
  const state = parts[1]
  const nodeList = parts[2]

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
  const parts = result
    .trim()
    .split('|')
    .map((part) => {
      return part.trim()
    })
  const state = parts[0]
  const nodeList = parts[1]

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

/**
 * Kill all SSH/autossh processes listening on a port with retry and SIGKILL escalation
 */
const killSshListenersOnPort = async (port: number, maxRetries = 5): Promise<boolean> => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const listeners = await getLocalListenersOnPort(port)
    // Deduplicate PIDs (lsof shows same PID twice for IPv4/IPv6)
    const sshPids = [
      ...new Set(
        listeners
          .filter((l) => {
            return l.command === 'ssh' || l.command === 'autossh'
          })
          .map((l) => {
            return String(l.pid)
          }),
      ),
    ]

    if (sshPids.length === 0) {
      return true // Port is free
    }

    // Use SIGKILL after first attempt to force cleanup
    const signal = attempt > 0 ? '-9' : '-15'
    // Use array spread to pass PIDs as separate arguments
    await $`kill ${signal} ${sshPids}`.nothrow().quiet()

    // Wait progressively longer for process to release port
    await sleep(300 + attempt * 200)
  }

  // Final check
  const finalListeners = await getLocalListenersOnPort(port)
  const sshRemaining = finalListeners.filter((l) => {
    return l.command === 'ssh' || l.command === 'autossh'
  })
  return sshRemaining.length === 0
}

/**
 * Kill ALL processes on a port (not just SSH) - use with caution
 */
const killAllListenersOnPort = async (port: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const listeners = await getLocalListenersOnPort(port)
    if (listeners.length === 0) return true

    // Deduplicate PIDs (lsof shows same PID twice for IPv4/IPv6)
    const pids = [
      ...new Set(
        listeners.map((l) => {
          return String(l.pid)
        }),
      ),
    ]
    const signal = attempt > 0 ? '-9' : '-15'
    // Use array spread to pass PIDs as separate arguments
    await $`kill ${signal} ${pids}`.nothrow().quiet()
    await sleep(500)
  }

  const finalListeners = await getLocalListenersOnPort(port)
  return finalListeners.length === 0
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
    const processInfo = listeners
      .map((l) => {
        return `${l.command} (PID ${l.pid})`
      })
      .join(', ')
    log(`Local port ${localPort} already in use by: ${processInfo}`)
    log('')
    log('To inspect the process(es):')
    log(`  lsof -n -P -iTCP:${localPort} -sTCP:LISTEN`)
    log('')
    log('To kill if safe:')
    const pids = listeners
      .map((l) => {
        return l.pid
      })
      .join(' ')
    log(`  kill ${pids}`)
    log('')
    return 'in_use'
  }

  log(`Killing existing SSH tunnel(s) on port ${localPort}...`)
  const killed = await killSshListenersOnPort(localPort)

  if (!killed) {
    // SSH cleanup failed, try force-killing all listeners
    log(`SSH cleanup failed, force-killing all listeners on port ${localPort}...`)
    const forceKilled = await killAllListenersOnPort(localPort)
    if (!forceKilled) {
      log(`ERROR: Could not free port ${localPort}`)
      return 'in_use'
    }
  }

  // Verify port is actually free before returning
  await sleep(200)
  const verifyListeners = await getLocalListenersOnPort(localPort)
  if (verifyListeners.length > 0) {
    log(
      `ERROR: Port ${localPort} still in use after cleanup: ${verifyListeners
        .map((l) => {
          return `${l.command}:${l.pid}`
        })
        .join(', ')}`,
    )
    return 'in_use'
  }

  return 'ready'
}

const getLocalTunnelPortBase = (localPortBase: number): number => {
  return localPortBase + LOCAL_TUNNEL_PORT_OFFSET
}

const spawnTunnelProcess = (
  computeNode: string,
  localTunnelPort: number,
  remoteCaddyPort: number,
): ReturnType<typeof spawn> => {
  const logFile = Bun.file(`mn5-tunnel-${computeNode}.log`)
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
  const pipeLog = async () => {
    try {
      const reader = proc.stderr.getReader()
      const writer = logFile.writer()
      while (true) {
        const {done, value} = await reader.read()
        if (done) break
        writer.write(value)
        await writer.flush()
      }
      writer.end()
    } catch (err) {
      console.error(`Failed to write tunnel logs for ${computeNode}:`, err)
    }
  }
  void pipeLog()

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
    await writeMn5RuntimeRecord({allNodes, jobId, localPortBase: localPorts[0] ?? LOCAL_PORT_BASE})
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
    await markMn5RuntimeRecordStopped(jobId)
    log(`Job ${jobId} is ${state}; exiting`)
    await stopLocalCaddyContainer()
    process.exit(0)
  }

  // Get updated node list
  const refreshedNodes = await getAllNodesFromNodeList(nodeList)
  const nodesToUse = refreshedNodes.length > 0 ? refreshedNodes : allNodes
  const firstPort = localPorts[0] ?? LOCAL_PORT_BASE

  // Restart all tunnels with the current node list
  await startMultiNodeTunnels(nodesToUse, jobId, firstPort, 1)
}

/**
 * Start SSH tunnels to all nodes and monitor them
 * Local Caddy ports match WORKER_URLS_LOCAL from sbatch:
 * - localhost:30001 -> local Caddy -> localhost:40001 -> node1:30002
 * - localhost:30002 -> local Caddy -> localhost:40002 -> node2:30002
 */
const startMultiNodeTunnels = async (
  allNodes: string[],
  jobId: string,
  localPortBase: number,
  restartCount: number,
): Promise<void> => {
  if (isShuttingDown) return

  // Set active job for signal handler
  activeJobId = jobId
  const restartSuffix = restartCount > 0 ? ` (restart #${restartCount})` : ''
  log(`Starting SSH tunnels to ${allNodes.length} node(s)${restartSuffix}`)

  // Kill any managed tunnel processes from previous attempts
  // This handles tunnels spawned by THIS process; orphaned tunnels from
  // previous script runs are cleaned up by ensureLocalPortReadyForTunnel
  if (activeTunnelProcs.length > 0) {
    log(`Cleaning up ${activeTunnelProcs.length} existing managed tunnel(s)...`)
    for (const proc of activeTunnelProcs) {
      try {
        proc.kill('SIGTERM')
      } catch {
        // Ignore - process may already be dead
      }
    }
    activeTunnelProcs.length = 0 // Clear array
    // Wait for processes to fully terminate and release ports
    await sleep(1000)
  }

  const localTunnelPortBase = getLocalTunnelPortBase(localPortBase)
  const localCaddyPorts: number[] = []
  const localTunnelPorts: number[] = []
  for (let i = 0; i < allNodes.length; i++) {
    const localCaddyPort = localPortBase + i
    const localTunnelPort = localTunnelPortBase + i
    localCaddyPorts.push(localCaddyPort)
    localTunnelPorts.push(localTunnelPort)

    // Ensure port is ready
    const portStatus = await ensureLocalPortReadyForTunnel(localTunnelPort)
    if (portStatus === 'in_use') {
      console.error(`[mn5] Local port ${localTunnelPort} is in use by a non-SSH process`)
      console.error(`      Stop that process first`)
      process.exit(1)
    }
  }

  await startLocalCaddyContainer(localCaddyPorts, localTunnelPorts)
  await sleep(1000)

  for (let i = 0; i < allNodes.length; i++) {
    const node = allNodes[i]
    const localTunnelPort = localTunnelPorts[i]
    if (!node || localTunnelPort === undefined) continue
    log(`  Tunnel ${i + 1}/${allNodes.length}: localhost:${localTunnelPort} -> ${node}:${REMOTE_CADDY_PORT}`)

    const proc = spawnTunnelProcess(node, localTunnelPort, REMOTE_CADDY_PORT)
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
    localCaddyPorts.map(async (port) => {
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

  if (okCount === localCaddyPorts.length) {
    log(`✓ All ${allNodes.length} tunnel(s) connected and SGLang responding`)
  } else if (okCount > 0) {
    log(`⚠ ${okCount}/${localCaddyPorts.length} tunnels responding, failed ports: ${failedPorts.join(', ')}`)
  } else {
    log('⚠ Tunnels started but no SGLang health checks passed (may still be starting)')
  }

  // Show all worker URLs
  const workerUrls = localCaddyPorts
    .map((p) => {
      return `http://localhost:${p}`
    })
    .join(', ')
  log(`SGLang workers available at: ${workerUrls}`)
  await writeMn5RuntimeRecord({allNodes, jobId, localPortBase})
  log(`Press Ctrl+C to disconnect and cancel job ${jobId}`)

  // Monitor tunnel health on ALL ports (not just the first one)
  await monitorTunnelHealth(jobId, allNodes, localCaddyPorts)
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
  let largeContext = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--force') force = true
    else if (arg === '--model') model = args[++i]
    else if (arg === '--local-port') localPort = Number(args[++i] ?? LOCAL_PORT_BASE)
    else if (arg === '--large-context') largeContext = true
  }

  const sbatchFile = largeContext ? LARGE_CONTEXT_SATCH_FILE : DEFAULT_SBATCH_FILE
  const jobName = largeContext ? LARGE_CONTEXT_JOB_NAME : DEFAULT_JOB_NAME
  activeJobName = jobName

  // 1. Check for existing pending/running jobs
  log('Checking for existing jobs...')
  const existingJobsOutput =
    await $`ssh ${GLOG} "squeue -u \\$USER -n ${jobName} -h -o '%i|%T|%.200N' 2>/dev/null || echo ''"`.text()
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
  await $`scp ${sbatchFile} ${TLOG}:${MN5_ROOT}/`

  // 3. Submit job
  log('Submitting job...')
  const exportVars = model
    ? `ALL,SGLANG_MODEL=${model},SGLANG_LOCAL_PORT_BASE=${localPort}`
    : `ALL,SGLANG_LOCAL_PORT_BASE=${localPort}`
  const result = await $`ssh ${GLOG} "cd ${MN5_ROOT} && sbatch --export=${exportVars} ${sbatchFile}"`.text()
  const jobIdMatch = result.match(/Submitted batch job (\d+)/)
  const jobId = jobIdMatch?.[1]
  if (!jobId) {
    console.error('Failed to submit job:', result)
    process.exit(1)
  }
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
