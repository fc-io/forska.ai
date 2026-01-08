/**
 * Launch SGLang on MareNostrum 5 and wait for it to be ready
 * Usage: bun run mn5:launch [--force] [--model <id>]
 */

import {$, spawn} from 'bun'

const MN5_ROOT = '/gpfs/projects/ehpc482/dev'
const TLOG = 'tlog' // Transfer login
const GLOG = 'glog' // General login (for sbatch)
const ALOG = 'alog' // ACC login (for tunnel)
const SGLANG_PORT = 30000 // Remote OpenAI-compatible API port (router or worker)
const DEFAULT_LOCAL_PORT = 30000
const SBATCH_FILE = 'forska-mn5-sglang.sbatch'

// Track the active job ID for cleanup
let activeJobId: string | null = null
let activeTunnelProc: ReturnType<typeof spawn> | null = null
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
    if (activeTunnelProc) {
      try {
        activeTunnelProc.kill()
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
  const trimmed = nodeList.trim()
  if (!trimmed || trimmed === '(null)' || trimmed === 'n/a') return undefined

  if (!trimmed.includes('[')) return trimmed.split(',')[0]

  const expanded = await $`ssh ${GLOG} "scontrol show hostnames '${trimmed}' 2>/dev/null | head -1 || echo ''"`.text()
  const firstNode = expanded.trim()
  return firstNode ? firstNode : undefined
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
    log(`Local port ${localPort} already in use: ${listeners.map((l) => `${l.command}:${l.pid}`).join(', ')}`)
    return 'in_use'
  }

  log(`Killing existing SSH tunnel(s) on port ${localPort}...`)
  await killSshListenersOnPort(localPort)
  await sleep(500)
  return 'ready'
}

const spawnTunnelProcess = (computeNode: string, localPort: number) => {
  return spawn(
    [
      'ssh',
      '-N',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `${localPort}:${computeNode}:${SGLANG_PORT}`,
      ALOG,
    ],
    {stdout: 'inherit', stderr: 'inherit', stdin: 'inherit'},
  )
}

const waitForExistingTunnel = async (jobId: string, computeNode: string, localPort: number): Promise<void> => {
  if (isShuttingDown) return

  const localOk = await isLocalSGLangResponding(localPort)
  if (localOk) {
    await sleep(10_000)
    return waitForExistingTunnel(jobId, computeNode, localPort)
  }

  log(`Local SGLang not responding on :${localPort}, attempting to re-establish tunnel...`)
  return startTunnelSupervisor(computeNode, jobId, localPort, 0)
}

const startTunnelSupervisor = async (
  computeNode: string,
  jobId: string,
  localPort: number,
  restartCount: number,
): Promise<void> => {
  if (isShuttingDown) return

  // Set active job for signal handler if not already set
  activeJobId = jobId
  const restartSuffix = restartCount > 0 ? ` (restart #${restartCount})` : ''
  log(`Starting SSH tunnel: localhost:${localPort} -> ${computeNode}:${SGLANG_PORT} via ${ALOG}${restartSuffix}`)

  const portStatus = await ensureLocalPortReadyForTunnel(localPort)
  if (portStatus === 'in_use') {
    console.error(`[mn5] Port ${localPort} is in use by a non-SSH process`)
    console.error(`      Stop that process or use: bun run mn5:launch -- --local-port ${localPort + 1}`)
    process.exit(1)
  }

  const localAlreadyOk = await isLocalSGLangResponding(localPort)
  if (localAlreadyOk) {
    log(`✓ Reusing existing tunnel on localhost:${localPort}`)
    log(`SGLang API available at http://localhost:${localPort}/v1`)
    log(`Press Ctrl+C to disconnect and cancel job ${jobId}`)
    return waitForExistingTunnel(jobId, computeNode, localPort)
  }

  const proc = spawnTunnelProcess(computeNode, localPort)
  activeTunnelProc = proc

  await sleep(2000)

  const ok = await isLocalSGLangResponding(localPort)
  log(ok ? '✓ Tunnel connected and SGLang responding' : '⚠ Tunnel started but SGLang health check failed (may still be starting)')
  log(`SGLang API available at http://localhost:${localPort}/v1`)
  log(`Press Ctrl+C to disconnect and cancel job ${jobId}`)

  const exitCode = await proc.exited
  activeTunnelProc = null

  if (isShuttingDown) return

  const interpretation = interpretExitCode(exitCode)
  log(`🔴 Tunnel exited (code=${exitCode}): ${interpretation}`)

  await sleep(1500)
  const replaced = await isLocalSGLangResponding(localPort)
  if (replaced) {
    log(`✓ Tunnel on localhost:${localPort} appears to be handled by another process; keeping job watcher alive`)
    return waitForExistingTunnel(jobId, computeNode, localPort)
  }

  const {state, nodeList} = await getJobStatus(jobId)
  if (state !== 'RUNNING') {
    log(`Job ${jobId} is ${state}; exiting`)
    process.exit(0)
  }

  const refreshedNode = await getFirstNodeFromNodeList(nodeList)
  const nextNode = refreshedNode ?? computeNode
  return startTunnelSupervisor(nextNode, jobId, localPort, restartCount + 1)
}

/**
 * Wait for SGLang to be ready
 */
const waitForSGLangReady = async (computeNode: string): Promise<boolean> => {
  // Wait for SGLang to be ready (can take 10-20 min for large models)
  log('Waiting for SGLang to start (this can take 10-20 minutes for large models)...')
  for (let i = 0; i < 240; i++) {
    // Wait up to 40 minutes
    const checkWorker =
      await $`ssh ${ALOG} "curl -sf --connect-timeout 2 --max-time 3 http://${computeNode}:${SGLANG_PORT}/v1/models 2>/dev/null && echo OK || echo NOTREADY"`.text()
    if (checkWorker.includes('OK') && checkWorker.includes('data')) {
      log('SGLang worker is ready!')
      return true
    }

    if (i % 30 === 0 && i > 0) {
      log(`Still loading model... (${Math.floor((i * 10) / 60)} min elapsed)`)
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
    const computeNode = await getFirstNodeFromNodeList(existingRunningJob.nodeList)
    if (computeNode) {
      log(`Found running job: ${existingRunningJob.jobId} on ${computeNode}`)
      log('Reusing existing job (use --force to submit a new one)')
      await waitForSGLangReady(computeNode)
      await startTunnelSupervisor(computeNode, existingRunningJob.jobId, localPort, 0)
      return
    }
  }

  const existingPendingJob = existingJobs.find((job) => {
    return job.state === 'PENDING'
  })

  if (existingPendingJob && !force) {
    log(`Found pending job: ${existingPendingJob.jobId}`)
    log('Waiting for existing job to start (use --force to submit a new one)')

    let computeNode: string | undefined
    for (let i = 0; i < 720; i++) {
      const {state, nodeList} = await getJobStatus(existingPendingJob.jobId)

      if (state === 'RUNNING') {
        computeNode = await getFirstNodeFromNodeList(nodeList)
        if (computeNode) {
          log(`Job running on: ${computeNode}`)
          break
        }
      } else if (state === 'FAILED' || state === 'CANCELLED' || state === 'UNKNOWN' || !state) {
        log('Existing job ended, will submit a new one')
        break
      }

      if (i % 12 === 0) log(`Still pending... (${i * 5}s)`)
      await sleep(5000)
    }

    if (computeNode) {
      await waitForSGLangReady(computeNode)
      await startTunnelSupervisor(computeNode, existingPendingJob.jobId, localPort, 0)
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
  let computeNode: string | undefined
  for (let i = 0; i < 720; i++) {
    // Wait up to 60 minutes
    const {state, nodeList} = await getJobStatus(jobId)

    if (state === 'RUNNING') {
      computeNode = await getFirstNodeFromNodeList(nodeList)
      if (computeNode) {
        log(`Job running on: ${computeNode}`)
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

  if (!computeNode) {
    console.error('Timeout waiting for job to start')
    process.exit(1)
  }

  // 5. Wait for SGLang and start tunnel
  await waitForSGLangReady(computeNode)
  await startTunnelSupervisor(computeNode, jobId, localPort, 0)
}

void main()
