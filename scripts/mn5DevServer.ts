/**
 * MN5 Dev Server Script
 *
 * Connects to a running SGLang job on MareNostrum 5, sets up SSH tunnels,
 * and starts the local dev server with correct WORKER_URLS for metrics.
 *
 * Usage: bun run mn5:dev:server
 *
 * What it does:
 * 1. Finds the latest running sbatch job log on MN5
 * 2. Parses the [mn5:config:start]...[mn5:config:end] block for config
 * 3. Kills any existing SSH tunnels on the SGLANG_PORT
 * 4. Starts SSH tunnels to the compute node(s)
 * 5. Starts the API dev server with WORKER_URLS set for metrics collection
 */

import {$, spawn} from 'bun'

const MN5_ROOT = '/gpfs/projects/ehpc482/dev'
const SSH_HOST = 'alog' // ACC login node for tunneling
const GLOG = 'glog' // General login for squeue

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
const findLatestJob = async (): Promise<{jobId: string; computeNode: string} | null> => {
  try {
    // Look specifically for forska-mn5-sglang jobs
    const result = await sshCommand(GLOG, 'squeue -u $USER -n forska-mn5-sglang -h -o "%i %N" -t RUNNING | head -1')
    log(`squeue result: "${result}"`)

    const parts = result.split(/\s+/)
    const jobId = parts[0]
    const nodeList = parts[1]

    if (!jobId || !nodeList) {
      return null
    }

    // The node list might be in compressed format like "as02r3b[05,16]"
    // Use scontrol to expand it
    let computeNode: string
    if (nodeList.includes('[')) {
      const expanded = await sshCommand(GLOG, `scontrol show hostnames '${nodeList}' | head -1`)
      computeNode = expanded.trim()
    } else {
      computeNode = nodeList.split(',')[0]
    }

    if (jobId && computeNode) {
      return {jobId, computeNode}
    }
  } catch (e) {
    log(`Error finding job: ${e}`)
  }
  return null
}

/**
 * Parse the [mn5:config:start]...[mn5:config:end] block from log file
 */
const parseConfigFromLog = async (jobId: string): Promise<MN5Config | null> => {
  try {
    // Read the log file from the remote
    const logPath = `${MN5_ROOT}/forska-mn5-sglang-${jobId}.log`
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
      config[key.trim() as keyof MN5Config] = valueParts.join('=').trim()
    }

    // Validate required fields
    if (!config.SGLANG_HOST || !config.SGLANG_PORT) {
      log('Config block incomplete')
      return null
    }

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

// Track all tunnel processes for cleanup
const tunnelProcesses: ReturnType<typeof spawn>[] = []

/**
 * Start SSH tunnel in background
 * Maps localPort on localhost to remotePort on remoteHost via SSH_HOST
 */
const startTunnel = async (
  localPort: string,
  remoteHost: string,
  remotePort: string,
  testEndpoint = true,
): Promise<void> => {
  log(`Starting SSH tunnel: localhost:${localPort} -> ${remoteHost}:${remotePort}`)

  // Start SSH tunnel in background using spawn
  const proc = spawn(
    [
      'ssh',
      '-N',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `${localPort}:${remoteHost}:${remotePort}`,
      SSH_HOST,
    ],
    {stdout: 'ignore', stderr: 'pipe'},
  )

  tunnelProcesses.push(proc)

  // Wait a moment and check if tunnel started successfully
  await sleep(1500)

  // Test the connection if requested
  if (testEndpoint) {
    try {
      const check =
        await $`curl -sf --connect-timeout 3 http://localhost:${localPort}/v1/models 2>/dev/null && echo OK || echo FAIL`.text()
      if (check.includes('OK')) {
        log(`  ✓ Tunnel localhost:${localPort} connected`)
      } else {
        log(`  ? Tunnel localhost:${localPort} started (endpoint not responding yet)`)
      }
    } catch {
      log(`  ? Tunnel localhost:${localPort} started`)
    }
  }
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

  const env = {
    ...process.env,
    // Override LLM endpoint to use local tunnel
    VITE_LLM_SERVER_URL: `http://localhost:${config.SGLANG_PORT}/v1`,
    // Pass worker URLs for metrics collection (using local ports via tunnel)
    WORKER_URLS: config.WORKER_URLS_LOCAL,
    // Pass GPU/topology info for the admin UI
    GPU_TOTAL_GPUS: String(Number(config.NNODES) * Number(config.GPUS_PER_NODE)),
    GPU_NNODES: config.NNODES,
    GPU_GPUS_PER_NODE: config.GPUS_PER_NODE,
    TP_SIZE: config.TP_SIZE,
    DP_SIZE: config.DP_SIZE,
    SGLANG_MAX_RUNNING_REQUESTS: config.SGLANG_MAX_RUNNING_REQUESTS,
    SGLANG_MODEL: config.SGLANG_MODEL,
    BUN_CONFIG_MAX_HTTP_REQUESTS: '2048',
  }

  // Start the dev server (blocking)
  const proc = spawn(['bun', '--env-file=.env.local', 'run', '--watch', 'src/server/index.ts'], {
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

  // Install cleanup handlers
  installTunnelCleanup()

  // 3. Kill existing tunnels on router port and worker ports
  await killExistingTunnels(config.SGLANG_PORT)

  // Parse worker URLs to get host:port pairs
  const remoteWorkers = config.WORKER_URLS.split(',')
    .map((url) => {
      const match = url.match(/http:\/\/([^:]+):(\d+)/)
      return match ? {host: match[1], port: match[2]} : null
    })
    .filter(Boolean) as {host: string; port: string}[]

  const localWorkers = config.WORKER_URLS_LOCAL.split(',')
    .map((url) => {
      const match = url.match(/http:\/\/[^:]+:(\d+)/)
      return match ? match[1] : null
    })
    .filter(Boolean) as string[]

  // Kill tunnels on worker ports too
  for (const localPort of localWorkers) {
    await killExistingTunnels(localPort)
  }

  // 4. Start tunnels
  log('Setting up SSH tunnels...')

  // Router tunnel (main endpoint)
  await startTunnel(config.SGLANG_PORT, config.SGLANG_HOST, config.SGLANG_PORT)

  // Worker tunnels (for metrics collection)
  for (let i = 0; i < remoteWorkers.length; i++) {
    const remote = remoteWorkers[i]
    const localPort = localWorkers[i]
    if (remote && localPort && localPort !== config.SGLANG_PORT) {
      await startTunnel(localPort, remote.host, remote.port, false) // Don't test workers
    }
  }

  log('All tunnels established')

  // 5. Start dev server
  await startDevServer(config)
}

void main()
