import {$, spawn} from 'bun'

import {
  ALVIS_HOST,
  ALVIS_JOB_NAME,
  ALVIS_ROOT,
  ALVIS_SBATCH_FILE,
  type AlvisConfig,
  type AlvisJobRequest,
  getAlvisJobRequest,
  getJobStatus,
  getLatestAlvisJob,
  getWorkerTunnels,
  sleep,
  splitCsv,
  waitForAlvisConfig,
  type WorkerTunnel,
} from './alvisCommon.ts'

const log = (message: string): void => {
  console.log(`[alvis] ${message}`)
}

type LocalPortListener = {command: string; pid: number}
type LaunchPreset = {
  label: string
  sbatchArgs: string[]
  exportVars: string[]
  matchesConfig: (config: AlvisConfig) => boolean
  matchesRequest: (request: AlvisJobRequest) => boolean
}

let activeJobId: string | null = null
const activeTunnelProcs: ReturnType<typeof spawn>[] = []
let isShuttingDown = false

const getWorkerCount = (config: AlvisConfig): number => {
  return splitCsv(config.WORKER_URLS).length
}

const a100FatLaunchPreset: LaunchPreset = {
  label: '1 node, 2x A100fat, single instance',
  sbatchArgs: ['--nodes=1', '--gpus-per-node=A100fat:2'],
  exportVars: ['SGLANG_ONE_WORKER_PER_GPU=0', 'TP_SIZE=2', 'DP_SIZE=1'],
  matchesConfig: (config) => {
    return (
      config.GPUS_PER_NODE === '2'
      && config.TP_SIZE === '2'
      && config.DP_SIZE === '1'
      && config.SGLANG_ONE_WORKER_PER_GPU === '0'
      && getWorkerCount(config) === 1
    )
  },
  matchesRequest: (request) => {
    return request.gresPerNode === 'gres/gpu:A100fat:2' && request.numNodes === '1'
  },
}

const defaultLaunchPreset = a100FatLaunchPreset

const a1004LaunchPreset: LaunchPreset = {
  label: '1 node, 4x A100, single instance',
  sbatchArgs: ['--nodes=1', '--gpus-per-node=A100:4'],
  exportVars: ['SGLANG_ONE_WORKER_PER_GPU=0', 'TP_SIZE=4', 'DP_SIZE=1'],
  matchesConfig: (config) => {
    return (
      config.GPUS_PER_NODE === '4'
      && config.TP_SIZE === '4'
      && config.DP_SIZE === '1'
      && config.SGLANG_ONE_WORKER_PER_GPU === '0'
      && getWorkerCount(config) === 1
    )
  },
  matchesRequest: (request) => {
    return request.gresPerNode === 'gres/gpu:A100:4' && request.numNodes === '1'
  },
}

const getExportVars = (preset: LaunchPreset, model: string | undefined, localPortBase: number): string => {
  const modelVars = model ? [`SGLANG_MODEL=${model}`] : []
  return ['ALL', ...preset.exportVars, `SGLANG_LOCAL_PORT_BASE=${localPortBase}`, ...modelVars].join(',')
}

const getSubmitCommand = (preset: LaunchPreset, exportVars: string): string => {
  const sbatchArgs = preset.sbatchArgs.join(' ')
  const sbatchArgsPrefix = sbatchArgs ? `${sbatchArgs} ` : ''
  return `cd ${ALVIS_ROOT} && sbatch ${sbatchArgsPrefix}--export=${exportVars} ${ALVIS_SBATCH_FILE}`
}

const cancelJob = async (jobId: string): Promise<void> => {
  log(`Cancelling job ${jobId}...`)
  await $`ssh ${ALVIS_HOST} "scancel ${jobId} 2>/dev/null || true"`.quiet().nothrow()
}

const setupSignalHandler = (): void => {
  const cleanup = async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true
    console.log('')

    for (const proc of activeTunnelProcs) {
      try {
        proc.kill()
      } catch (_error) {
        continue
      }
    }

    if (activeJobId) await cancelJob(activeJobId)

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
        .filter((listener): listener is LocalPortListener => {
          return Boolean(listener)
        })
}

const isLocalSGLangResponding = async (localPort: number): Promise<boolean> => {
  const result =
    await $`curl -sf --connect-timeout 2 --max-time 3 http://localhost:${localPort}/v1/models 2>/dev/null || echo ''`.text()
  const trimmed = result.trim()

  return trimmed.includes('"data"') || trimmed.includes('"object"') || trimmed.includes('"id"')
}

const killSshListenersOnPort = async (port: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const listeners = await getLocalListenersOnPort(port)
    const sshPids = [
      ...new Set(
        listeners
          .filter((listener) => {
            return listener.command === 'ssh' || listener.command === 'autossh'
          })
          .map((listener) => {
            return String(listener.pid)
          }),
      ),
    ]

    if (sshPids.length === 0) return true

    await $`kill ${attempt > 0 ? '-9' : '-15'} ${sshPids}`.quiet().nothrow()
    await sleep(300 + attempt * 200)
  }

  const remaining = await getLocalListenersOnPort(port)
  return remaining.every((listener) => {
    return listener.command !== 'ssh' && listener.command !== 'autossh'
  })
}

const ensureLocalPortReadyForTunnel = async (localPort: number): Promise<'ready' | 'in_use'> => {
  if (await isLocalSGLangResponding(localPort)) return 'ready'

  const listeners = await getLocalListenersOnPort(localPort)
  if (listeners.length === 0) return 'ready'

  const onlySsh = listeners.every((listener) => {
    return listener.command === 'ssh' || listener.command === 'autossh'
  })

  if (!onlySsh) {
    const processInfo = listeners
      .map((listener) => {
        return `${listener.command} (PID ${listener.pid})`
      })
      .join(', ')
    log(`Local port ${localPort} already in use by: ${processInfo}`)
    return 'in_use'
  }

  log(`Killing existing SSH tunnel(s) on port ${localPort}...`)
  return (await killSshListenersOnPort(localPort)) ? 'ready' : 'in_use'
}

const interpretExitCode = (code: number): string => {
  const exitCodes: Record<number, string> = {
    0: 'Normal exit',
    1: 'General error',
    130: 'Interrupted',
    137: 'Killed',
    143: 'Terminated',
    255: 'SSH connection failed',
  }

  return exitCodes[code] || `Unknown exit code ${code}`
}

const spawnTunnelProcess = (worker: WorkerTunnel): ReturnType<typeof spawn> => {
  return spawn(
    [
      'ssh',
      '-C',
      '-vv',
      '-N',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'ServerAliveInterval=60',
      '-o',
      'ServerAliveCountMax=10',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `${worker.localPort}:${worker.remoteHost}:${worker.remotePort}`,
      ALVIS_HOST,
    ],
    {stdout: 'inherit', stderr: 'ignore', stdin: 'inherit'},
  )
}

const monitorTunnelHealth = async (jobId: string): Promise<void> => {
  if (isShuttingDown) return

  const config = await waitForAlvisConfig(jobId, log)
  if (!config) {
    const status = await getJobStatus(jobId)
    if (status.state !== 'RUNNING') {
      log(`Job ${jobId} is ${status.state}; exiting`)
      process.exit(0)
    }
    await sleep(10_000)
    return monitorTunnelHealth(jobId)
  }

  const workers = getWorkerTunnels(config)
  const healthResults = await Promise.all(
    workers.map(async (worker) => {
      const isOk = await isLocalSGLangResponding(worker.localPort)
      return {worker, isOk}
    }),
  )
  const failedWorkers = healthResults.filter((result) => {
    return !result.isOk
  })

  if (failedWorkers.length === 0) {
    await sleep(10_000)
    return monitorTunnelHealth(jobId)
  }

  log(
    `Restarting tunnel set after health check failure on: ${failedWorkers
      .map((result) => {
        return result.worker.localUrl
      })
      .join(', ')}`,
  )

  const status = await getJobStatus(jobId)
  if (status.state !== 'RUNNING') {
    log(`Job ${jobId} is ${status.state}; exiting`)
    process.exit(0)
  }

  await startWorkerTunnels(config, jobId, 1)
}

const startWorkerTunnels = async (config: AlvisConfig, jobId: string, restartCount: number): Promise<void> => {
  if (isShuttingDown) return

  const workers = getWorkerTunnels(config)
  if (workers.length === 0) {
    console.error('[alvis] No worker URLs found in startup config')
    process.exit(1)
  }

  activeJobId = jobId
  const restartSuffix = restartCount > 0 ? ` (restart #${restartCount})` : ''
  log(`Starting SSH tunnels to ${workers.length} worker(s)${restartSuffix}`)

  if (activeTunnelProcs.length > 0) {
    for (const proc of activeTunnelProcs) {
      try {
        proc.kill('SIGTERM')
      } catch (_error) {
        continue
      }
    }
    activeTunnelProcs.length = 0
    await sleep(1000)
  }

  for (const worker of workers) {
    const portStatus = await ensureLocalPortReadyForTunnel(worker.localPort)
    if (portStatus === 'in_use') {
      console.error(`[alvis] Local port ${worker.localPort} is in use by a non-SSH process`)
      process.exit(1)
    }
  }

  for (const worker of workers) {
    log(`  Tunnel: localhost:${worker.localPort} -> ${worker.remoteHost}:${worker.remotePort}`)
    const proc = spawnTunnelProcess(worker)
    activeTunnelProcs.push(proc)

    proc.exited
      .then((exitCode) => {
        if (isShuttingDown) return
        log(
          `Tunnel to ${worker.remoteHost}:${worker.remotePort} exited (code=${exitCode}): ${interpretExitCode(exitCode)}`,
        )
      })
      .catch(() => {})
  }

  await sleep(2000)

  const readyCount = (
    await Promise.all(
      workers.map(async (worker) => {
        return isLocalSGLangResponding(worker.localPort)
      }),
    )
  ).filter(Boolean).length

  if (readyCount === workers.length) {
    log(`All ${workers.length} tunnel(s) connected and SGLang is responding`)
  } else if (readyCount > 0) {
    log(`${readyCount}/${workers.length} tunnel(s) are responding; the rest may still be starting`)
  } else {
    log('Tunnels started but no SGLang health checks passed yet')
  }

  log(
    `SGLang workers available at: ${workers
      .map((worker) => {
        return worker.localUrl
      })
      .join(', ')}`,
  )
  log(`Press Ctrl+C to disconnect and cancel job ${jobId}`)

  await monitorTunnelHealth(jobId)
}

const waitForPendingJobToBeReusable = async (jobId: string): Promise<boolean> => {
  const config = await waitForAlvisConfig(jobId, log)
  if (!config) return false

  await startWorkerTunnels(config, jobId, 0)
  return true
}

const waitForRequestedPendingJob = async (jobId: string, preset: LaunchPreset): Promise<boolean> => {
  const jobRequest = await getAlvisJobRequest(jobId)

  if (!jobRequest || !preset.matchesRequest(jobRequest)) return false

  log(`Found matching pending job: ${jobId} (${preset.label})`)
  return waitForPendingJobToBeReusable(jobId)
}

const main = async () => {
  setupSignalHandler()

  const args = process.argv.slice(2)
  let model: string | undefined
  let force = false
  let localPortBase = 30001
  let requestedPreset: LaunchPreset | undefined

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--force') force = true
    else if (arg === '--a100-fat') requestedPreset = a100FatLaunchPreset
    else if (arg === '--a100-4') requestedPreset = a1004LaunchPreset
    else if (arg === '--model') model = args[index + 1]
    else if (arg === '--local-port') localPortBase = Number(args[index + 1] ?? '30001')
    if (arg === '--model' || arg === '--local-port') index += 1
  }

  const launchPreset = requestedPreset ?? defaultLaunchPreset

  const existingRunningJob = await getLatestAlvisJob('RUNNING')
  if (existingRunningJob && !force) {
    log(`Found running job: ${existingRunningJob.jobId}`)
    const config = await waitForAlvisConfig(existingRunningJob.jobId, log, existingRunningJob.jobName)
    if (!config) {
      console.error('[alvis] Running job does not expose startup config yet')
      process.exit(1)
    }

    if (!requestedPreset || requestedPreset.matchesConfig(config)) {
      await startWorkerTunnels(config, existingRunningJob.jobId, 0)
      return
    }

    log(`Running job ${existingRunningJob.jobId} does not match requested preset: ${requestedPreset.label}`)
  }

  const existingPendingJob = await getLatestAlvisJob('PENDING')
  if (existingPendingJob && !force && !requestedPreset) {
    log(`Found pending job: ${existingPendingJob.jobId}`)
    if (await waitForPendingJobToBeReusable(existingPendingJob.jobId)) return
  }

  if (existingPendingJob && !force && requestedPreset) {
    if (await waitForRequestedPendingJob(existingPendingJob.jobId, requestedPreset)) return
    log(`Skipping pending job ${existingPendingJob.jobId}; requested preset needs a fresh submission`)
  }

  log('Deploying sbatch file...')
  await $`scp ${ALVIS_SBATCH_FILE} ${ALVIS_HOST}:${ALVIS_ROOT}/`

  log(`Submitting job (${launchPreset.label})...`)
  const exportVars = getExportVars(launchPreset, model, localPortBase)
  const submitCommand = getSubmitCommand(launchPreset, exportVars)
  const result = await $`ssh ${ALVIS_HOST} ${submitCommand}`.text()
  const jobId = result.match(/Submitted batch job (\d+)/)?.[1]

  if (!jobId) {
    console.error('[alvis] Failed to submit job:', result)
    process.exit(1)
  }

  activeJobId = jobId
  log(`Job submitted: ${jobId}`)

  const config = await waitForAlvisConfig(jobId, log)
  if (!config) {
    console.error(
      `[alvis] Timed out waiting for ${ALVIS_JOB_NAME} startup config (set ALVIS_CONFIG_WAIT_SECONDS to override)`,
    )
    process.exit(1)
  }

  await startWorkerTunnels(config, jobId, 0)
}

void main()
