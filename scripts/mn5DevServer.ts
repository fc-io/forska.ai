/**
 * MN5 Dev Server Script
 *
 * Connects to a running SGLang job on MareNostrum 5 and starts the local dev server
 * with correct WORKER_URLS.
 *
 * SSH tunnels are handled by `bun run mn5:launch` (this script does not create tunnels).
 *
 * Usage: bun run mn5:dev:server
 *
 * What it does:
 * 1. Finds the latest running sbatch job log on MN5
 * 2. Parses the [mn5:config:start]...[mn5:config:end] block for config
 * 3. Starts the API dev server with WORKER_URLS from the config
 */

import {$, spawn} from 'bun'

const MN5_ROOT = '/gpfs/projects/ehpc482/dev'
const SSH_HOST = 'alog' // ACC login node for tunneling
const GLOG = 'glog' // General login for squeue

const JOB_NAMES = ['forska-mn5-sglang-large-context', 'forska-mn5-sglang']

interface MN5Config {
  SGLANG_HOST: string
  SGLANG_PORT: string
  SGLANG_WORKER_PORT: string
  SGLANG_MODEL: string
  WORKER_URLS: string
  WORKER_URLS_LOCAL: string
  NNODES: string
  GPUS_PER_NODE: string
  TP_SIZE: string
  DP_SIZE: string
  SGLANG_ENABLE_ROUTER: string
  SGLANG_MAX_RUNNING_REQUESTS: string
  SGLANG_API_MAX_INFLIGHT_REQUESTS: string
  SGLANG_API_MAX_BURST_REQUESTS: string
  SGLANG_CONTEXT_LENGTH: string
  SGLANG_LOCAL_PORT_BASE: string
}

const log = (m: string): void => {
  console.log(`[mn5:dev] ${m}`)
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => {
    setTimeout(r, ms)
  })
}

/**
 * Run SSH command and return just stdout (ignoring stderr module loading messages)
 */
const sshCommand = async (host: string, cmd: string): Promise<string> => {
  const proc = spawn(['ssh', host, cmd], {stdout: 'pipe', stderr: 'pipe'})
  const stdout = await new Response(proc.stdout).text()
  return stdout.trim()
}

/**
 * Find the most recent running job and its log file
 */
const findLatestJob = async (): Promise<{jobId: string; jobName: string; computeNode: string} | null> => {
  try {
    const result = await sshCommand(GLOG, 'squeue -u $USER -h -o "%i|%j|%N" -t RUNNING')
    log(`squeue result: "${result}"`)

    const jobs = result
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line.length > 0
      })
      .map((line) => {
        const [jobId, jobName, nodeList] = line.split('|').map((part) => {
          return part.trim()
        })
        return jobId && jobName && nodeList ? {jobId, jobName, nodeList} : undefined
      })
      .filter((row): row is {jobId: string; jobName: string; nodeList: string} => {
        return Boolean(row)
      })
      .filter((row) => {
        return JOB_NAMES.includes(row.jobName)
      })

    const bestJob = jobs.sort((a, b) => {
      const aPref = JOB_NAMES.indexOf(a.jobName)
      const bPref = JOB_NAMES.indexOf(b.jobName)
      if (aPref !== bPref) return aPref - bPref
      return Number(b.jobId) - Number(a.jobId)
    })[0]

    if (!bestJob) return null

    const jobId = bestJob.jobId
    const jobName = bestJob.jobName
    const nodeList = bestJob.nodeList

    // The node list might be in compressed format like "as02r3b[05,16]"
    // Use scontrol to expand it
    let computeNode: string
    if (nodeList.includes('[')) {
      const expanded = await sshCommand(GLOG, `scontrol show hostnames '${nodeList}' | head -1`)
      computeNode = expanded.trim()
    } else {
      computeNode = nodeList.split(',')[0] ?? ''
    }

    if (jobId && jobName && computeNode) return {jobId, jobName, computeNode}
  } catch (e) {
    log(`Error finding job: ${e}`)
  }
  return null
}

/**
 * Parse the [mn5:config:start]...[mn5:config:end] block from log file
 */
const parseConfigFromLog = async (jobId: string, jobName: string): Promise<MN5Config | null> => {
  try {
    // Read the log file from the remote
    const logPath = `${MN5_ROOT}/${jobName}-${jobId}.log`
    log(`Reading config from: ${logPath}`)

    const logContent = await $`ssh ${SSH_HOST} "cat ${logPath} 2>/dev/null || echo ''"`.text()

    // Find the config block
    const startMarker = '[mn5:config:start]'
    const endMarker = '[mn5:config:end]'
    const startIdx = logContent.indexOf(startMarker)
    const endIdx = logContent.indexOf(endMarker)

    if (startIdx === -1 || endIdx === -1) {
      log('Config block not found in log file (job may still be starting)')
      return null
    }

    const configBlock = logContent.slice(startIdx + startMarker.length, endIdx)
    const config: Partial<MN5Config> = {}

    for (const line of configBlock.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.includes('=')) continue
      const [key, ...valueParts] = trimmed.split('=')
      if (key) {
        config[key.trim() as keyof MN5Config] = valueParts.join('=').trim()
      }
    }

    // Validate required fields
    if (!config.SGLANG_HOST || !config.SGLANG_PORT) {
      log('Config block incomplete')
      return null
    }

    // Backwards-compat defaults for newer keys (older logs won't have them)
    if (!config.SGLANG_API_MAX_INFLIGHT_REQUESTS) config.SGLANG_API_MAX_INFLIGHT_REQUESTS = '0'
    if (!config.SGLANG_API_MAX_BURST_REQUESTS) config.SGLANG_API_MAX_BURST_REQUESTS = '0'

    return config as MN5Config
  } catch (e) {
    log(`Failed to parse config: ${e}`)
    return null
  }
}

/**
 * Kill existing SSH tunnels on the given port
 */
const killExistingTunnels = async (port: string): Promise<void> => {
  try {
    // Find processes with SSH tunnel on this port
    const result = await $`lsof -i :${port} -t 2>/dev/null || true`.text()
    const pids = result
      .trim()
      .split('\n')
      .filter((p) => {
        return p
      })

    if (pids.length > 0) {
      log(`Killing ${pids.length} existing process(es) on port ${port}`)
      for (const pid of pids) {
        try {
          await $`kill ${pid} 2>/dev/null || true`
        } catch {
          // Ignore
        }
      }
      await sleep(500) // Give time for port to be released
    }
  } catch {
    // No existing processes
  }
}

// Track all tunnel processes for cleanup and monitoring
interface TunnelInfo {
  proc: ReturnType<typeof spawn>
  localPort: string
  remoteHost: string
  remotePort: string
  testEndpoint: boolean
  stderrBuffer: string[]
  startTime: Date
  restartCount: number
}
const tunnelInfos: TunnelInfo[] = []

// For backwards compat with cleanup handler
const tunnelProcesses: ReturnType<typeof spawn>[] = []

/**
 * Interpret SSH exit code to help diagnose issues
 */
const interpretExitCode = (code: number): string => {
  const exitCodes: Record<number, string> = {
    0: 'Normal exit',
    1: 'General error (local issue or remote command failed)',
    2: 'Misuse of shell command',
    255: 'SSH connection failed (could be network, auth, or remote server issue)',
    // Signal-based exits (128 + signal number)
    130: 'Interrupted (Ctrl+C)',
    137: 'Killed (SIGKILL)',
    143: 'Terminated (SIGTERM)',
  }
  return exitCodes[code] || `Unknown exit code ${code}`
}

/**
 * Start SSH tunnel in background with stderr capture for diagnostics
 * Maps localPort on localhost to remotePort on remoteHost via SSH_HOST
 */
const startTunnel = async (
  localPort: string,
  remoteHost: string,
  remotePort: string,
  testEndpoint = true,
  restartCount = 0,
): Promise<TunnelInfo> => {
  log(
    `Starting SSH tunnel: localhost:${localPort} -> ${remoteHost}:${remotePort}${restartCount > 0 ? ` (restart #${restartCount})` : ''}`,
  )

  // Kill any existing process on this port first
  try {
    const existing = await $`lsof -i :${localPort} -t 2>/dev/null || true`.text()
    const pids = existing
      .trim()
      .split('\n')
      .filter((p) => {
        return p
      })
    for (const pid of pids) {
      try {
        await $`kill ${pid} 2>/dev/null || true`
      } catch {
        /* ignore */
      }
    }
    if (pids.length > 0) await sleep(300)
  } catch {
    /* ignore */
  }

  // Start SSH tunnel in background using spawn with verbose mode for diagnostics
  // Important: Disable ControlMaster so we can monitor the tunnel process directly
  const proc = spawn(
    [
      'ssh',
      '-v', // Verbose mode for diagnostics
      '-N',
      '-o',
      'ControlMaster=no', // Don't use/create control master - we need to monitor this process
      '-o',
      'ControlPath=none', // Ignore any existing control sockets
      '-o',
      'ServerAliveInterval=5', // Send keepalive every 5 seconds (more frequent)
      '-o',
      'ServerAliveCountMax=2', // Disconnect after 2 missed keepalives (fail fast to restart)
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'TCPKeepAlive=yes',
      '-o',
      'IPQoS=throughput', // Optimize for throughput over interactive latency
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ConnectionAttempts=5',
      '-o',
      'Compression=no', // Disable compression for better performance with binary/encrypted data
      '-o',
      'Ciphers=aes128-gcm@openssh.com', // Enforce fastest cipher
      '-L',
      `${localPort}:${remoteHost}:${remotePort}`,
      SSH_HOST,
    ],
    {stdout: 'ignore', stderr: 'pipe'},
  )

  // Track for monitoring and cleanup
  const info: TunnelInfo = {
    proc,
    localPort,
    remoteHost,
    remotePort,
    testEndpoint,
    stderrBuffer: [],
    startTime: new Date(),
    restartCount,
  }
  tunnelInfos.push(info)
  tunnelProcesses.push(proc)

  // Capture stderr in background for diagnostics (keep last 20 lines)
  ;(async () => {
    try {
      const reader = proc.stderr.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const {done, value} = await reader.read()
        if (done) break
        const text = decoder.decode(value)
        const lines = text.split('\n').filter((l) => {
          return l.trim()
        })
        info.stderrBuffer.push(...lines)
        // Keep only last 20 lines
        if (info.stderrBuffer.length > 20) {
          info.stderrBuffer.splice(0, info.stderrBuffer.length - 20)
        }
      }
    } catch {
      /* stream closed */
    }
  })()

  // Watch for process exit and log diagnostics
  proc.exited
    .then((exitCode) => {
      const runtime = Math.round((Date.now() - info.startTime.getTime()) / 1000)
      const interpretation = interpretExitCode(exitCode)

      log(`🔴 Tunnel port ${localPort} exited after ${runtime}s`)
      log(`   Exit code: ${exitCode} (${interpretation})`)

      // Parse transfer stats if available
      const transferLine = info.stderrBuffer.find((l) => {
        return l.includes('Transferred:')
      })
      if (transferLine) {
        const match = transferLine.match(/sent (\d+), received (\d+).*?(\d+\.?\d*) seconds/)
        const sentStr = match?.[1]
        const receivedStr = match?.[2]
        const secondsStr = match?.[3]
        if (sentStr && receivedStr && secondsStr) {
          const sent = parseInt(sentStr) / 1024 / 1024
          const received = parseInt(receivedStr) / 1024 / 1024
          const seconds = parseFloat(secondsStr)
          const sentRate = sent / seconds
          const receivedRate = received / seconds
          log(
            `   📊 Throughput: sent ${sent.toFixed(1)}MB (${sentRate.toFixed(1)}MB/s), received ${received.toFixed(1)}MB (${receivedRate.toFixed(1)}MB/s)`,
          )
          if (receivedRate > 0.5) {
            log(`   ⚠️  High receive rate detected - possible bandwidth throttling`)
          }
        }
      }

      // Log last few stderr lines for debugging
      const relevantStderr = info.stderrBuffer
        .filter((l) => {
          return (
            (!l.includes('debug1:') || l.includes('disconnect') || l.includes('error') || l.includes('Connection'))
            && !l.includes('Transferred:')
            && !l.includes('Bytes per second')
          )
        })
        .slice(-5)
      if (relevantStderr.length > 0) {
        log(`   Last SSH messages:`)
        for (const line of relevantStderr) {
          log(`     ${line}`)
        }
      }

      // Diagnose likely cause
      if (exitCode === 255) {
        if (
          info.stderrBuffer.some((l) => {
            return l.includes('Connection refused')
          })
        ) {
          log(`   ⚡ Diagnosis: REMOTE - Login node refused connection (possibly overloaded or restarted)`)
        } else if (
          info.stderrBuffer.some((l) => {
            return l.includes('Connection reset')
          })
        ) {
          log(`   ⚡ Diagnosis: NETWORK - Connection was reset (network interruption)`)
        } else if (
          info.stderrBuffer.some((l) => {
            return l.includes('connect to host') && l.includes('port 22')
          })
        ) {
          log(`   ⚡ Diagnosis: LOCAL - Cannot reach SSH server (network/DNS issue on your machine)`)
        } else if (
          info.stderrBuffer.some((l) => {
            return l.includes('channel') && l.includes('open failed')
          })
        ) {
          log(`   ⚡ Diagnosis: REMOTE - Compute node ${remoteHost} unreachable from login node (job may have ended)`)
        } else if (
          info.stderrBuffer.some((l) => {
            return l.includes('Timeout')
          })
        ) {
          log(`   ⚡ Diagnosis: NETWORK - Connection timed out (network congestion or server busy)`)
        } else {
          log(`   ⚡ Diagnosis: UNKNOWN - Check if the SGLang job is still running on MN5`)
        }
      } else if (exitCode === 1) {
        log(`   ⚡ Diagnosis: Likely a local configuration or authentication issue`)
      }

      // Trigger immediate restart (don't wait for monitor interval)
      void checkAndRestartTunnel(info)
    })
    .catch(() => {})

  // Wait a moment and check if tunnel started successfully
  await sleep(2000)

  // Test the connection if requested
  if (testEndpoint) {
    try {
      const check =
        await $`curl -sf --connect-timeout 5 http://localhost:${localPort}/v1/models 2>/dev/null && echo OK || echo FAIL`.text()
      if (check.includes('OK')) {
        log(`  ✓ Tunnel localhost:${localPort} connected`)
      } else {
        log(`  ? Tunnel localhost:${localPort} started (endpoint not responding yet)`)
      }
    } catch {
      log(`  ? Tunnel localhost:${localPort} started`)
    }
  }

  return info
}

/**
 * Check if a tunnel is still alive and restart if needed
 */
const checkAndRestartTunnel = async (info: TunnelInfo): Promise<void> => {
  // Check if process is still running
  const exitCode = info.proc.exitCode
  if (exitCode !== null) {
    // Process has exited - diagnostics were already logged by the exited handler

    // Remove old entry
    const idx = tunnelInfos.indexOf(info)
    if (idx >= 0) tunnelInfos.splice(idx, 1)
    const procIdx = tunnelProcesses.indexOf(info.proc)
    if (procIdx >= 0) tunnelProcesses.splice(procIdx, 1)

    // Less aggressive backoff for transient network issues (max 5s)
    // Only apply backoff if tunnel died very quickly (within 10s of starting)
    const runtime = Date.now() - info.startTime.getTime()
    const diedQuickly = runtime < 10_000
    const backoffMs = diedQuickly ? Math.min(1000 * (info.restartCount + 1), 5000) : 500

    // Reset restart counter if tunnel ran successfully for at least 30s
    const resetRestartCount = runtime > 30_000

    if (backoffMs > 500) {
      log(`  Waiting ${backoffMs / 1000}s before restart...`)
      await sleep(backoffMs)
    }

    // Restart tunnel
    const newRestartCount = resetRestartCount ? 0 : info.restartCount + 1
    await startTunnel(info.localPort, info.remoteHost, info.remotePort, info.testEndpoint, newRestartCount)
    return
  }

  // Also verify the port is actually listening (process might be zombie)
  try {
    const listening = await $`lsof -i :${info.localPort} -t 2>/dev/null || true`.text()
    if (!listening.trim()) {
      log(`⚠️  Port ${info.localPort} not listening (zombie process?), restarting tunnel...`)
      try {
        info.proc.kill()
      } catch {
        /* ignore */
      }

      const idx = tunnelInfos.indexOf(info)
      if (idx >= 0) tunnelInfos.splice(idx, 1)
      const procIdx = tunnelProcesses.indexOf(info.proc)
      if (procIdx >= 0) tunnelProcesses.splice(procIdx, 1)

      await startTunnel(info.localPort, info.remoteHost, info.remotePort, info.testEndpoint, info.restartCount + 1)
    }
  } catch {
    /* ignore check failures */
  }
}

/**
 * Start monitoring tunnels and restart if they die
 */
const startTunnelMonitoring = (): void => {
  const MONITOR_INTERVAL_MS = 10_000 // Check every 10 seconds (more aggressive)

  setInterval(async () => {
    // Copy array since it may be modified during iteration
    const currentTunnels = [...tunnelInfos]
    for (const info of currentTunnels) {
      await checkAndRestartTunnel(info)
    }
  }, MONITOR_INTERVAL_MS)

  log(`Tunnel health monitor started (checking every ${MONITOR_INTERVAL_MS / 1000}s)`)
}

/**
 * Install cleanup handler for all tunnels
 */
const installTunnelCleanup = (): void => {
  const cleanup = (): void => {
    log('Shutting down tunnels...')
    for (const proc of tunnelProcesses) {
      try {
        proc.kill()
      } catch {
        // Ignore
      }
    }
  }

  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
}

/**
 * Start the dev server with WORKER_URLS
 */
const startDevServer = async (config: MN5Config): Promise<void> => {
  log('Starting dev server...')
  log(`  WORKER_URLS: ${config.WORKER_URLS_LOCAL}`)
  log(`  SGLANG_MODEL: ${config.SGLANG_MODEL}`)
  log(`  SGLANG_MAX_RUNNING_REQUESTS: ${config.SGLANG_MAX_RUNNING_REQUESTS}`)
  log(`  SGLANG_API_MAX_INFLIGHT_REQUESTS: ${config.SGLANG_API_MAX_INFLIGHT_REQUESTS}`)
  log(`  SGLANG_API_MAX_BURST_REQUESTS: ${config.SGLANG_API_MAX_BURST_REQUESTS}`)
  log(`  SGLANG_CONTEXT_LENGTH: ${config.SGLANG_CONTEXT_LENGTH}`)

  const env = {
    ...process.env,
    // Enable server-side judging when running with MN5
    RUN_SERVER_JUDGING: 'true',
    // Worker URLs for LLM requests and metrics (using local ports via tunnel)
    WORKER_URLS: config.WORKER_URLS_LOCAL,
    // Router mode flag
    SGLANG_ENABLE_ROUTER: config.SGLANG_ENABLE_ROUTER,
    // Pass GPU/topology info for the admin UI
    GPU_TOTAL_GPUS: String(Number(config.NNODES) * Number(config.GPUS_PER_NODE)),
    GPU_NNODES: config.NNODES,
    GPU_GPUS_PER_NODE: config.GPUS_PER_NODE,
    TP_SIZE: config.TP_SIZE,
    DP_SIZE: config.DP_SIZE,
    SGLANG_MAX_RUNNING_REQUESTS: config.SGLANG_MAX_RUNNING_REQUESTS,
    SGLANG_API_MAX_INFLIGHT_REQUESTS: config.SGLANG_API_MAX_INFLIGHT_REQUESTS,
    SGLANG_API_MAX_BURST_REQUESTS: config.SGLANG_API_MAX_BURST_REQUESTS,
    SGLANG_CONTEXT_LENGTH: config.SGLANG_CONTEXT_LENGTH,
    SGLANG_MODEL: config.SGLANG_MODEL,
    BUN_CONFIG_MAX_HTTP_REQUESTS: '2048',
    // For nvidia-smi polling: use the remote worker URLs (actual IPs, not localhost tunnels)
    // Also pass local URLs for display purposes (mapping remote -> local)
    NVIDIA_SMI_WORKER_URLS: config.WORKER_URLS,
    NVIDIA_SMI_WORKER_URLS_LOCAL: config.WORKER_URLS_LOCAL,
    NVIDIA_SMI_SSH_JUMP_HOST: SSH_HOST,
  }

  // Start the server (blocking, no watch mode for stability during long inference runs)
  const proc = spawn(['bun', '--env-file=.env.local', 'run', 'src/server/index.ts'], {
    cwd: process.cwd(),
    env,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })

  const exitCode = await proc.exited
  process.exit(exitCode)
}

const main = async () => {
  log('Looking for running MN5 job...')

  // 1. Find running job
  const job = await findLatestJob()
  if (!job) {
    console.error('[mn5:dev] No running SGLang job found on MN5')
    console.error('         Submit a job first: bun run mn5:launch')
    console.error('         Or check status: bun run mn5:status')
    process.exit(1)
  }

  log(`Found job ${job.jobId} on ${job.computeNode}`)

  // 2. Parse config from log
  let config: MN5Config | null = null
  for (let i = 0; i < 10; i++) {
    config = await parseConfigFromLog(job.jobId)
    if (config) break
    log('Waiting for config block in log file...')
    await sleep(5000)
  }

  if (!config) {
    console.error('[mn5:dev] Could not find config block in log file')
    console.error('         The job may still be starting up. Try again in a few minutes.')
    process.exit(1)
  }

  log('Parsed config:')
  log(`  Host: ${config.SGLANG_HOST}`)
  log(`  Port: ${config.SGLANG_PORT}`)
  log(`  Model: ${config.SGLANG_MODEL}`)
  log(`  Workers (remote): ${config.WORKER_URLS}`)
  log(`  Workers (local):  ${config.WORKER_URLS_LOCAL}`)

  log('Using SSH tunnels from `bun run mn5:launch` (this script does not create tunnels)')
  log(`Expected local endpoints: ${config.WORKER_URLS_LOCAL}`)

  // 3. Start dev server
  await startDevServer(config)
}

void main()
