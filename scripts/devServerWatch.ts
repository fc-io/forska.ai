import {existsSync, realpathSync, watch} from 'node:fs'
import {mkdir, readdir, readFile, unlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {stdin as input, stdout as output} from 'node:process'
import readline from 'node:readline/promises'

import {spawn, type Subprocess} from 'bun'
import {Effect} from 'effect'

import {
  isJudgmentJobLeaseProcessAlive,
  isJudgmentJobLeaseStale,
  type JudgmentJobLeaseMetadata,
} from '../src/server/cron/judgmentsJobs/judgmentJobLease.ts'
import {getJudgmentJobsRootDirectory} from '../src/server/cron/judgmentsJobs/judgmentJobPaths.ts'
import {getBackgroundServerStackConfig} from '../src/server/utils/backgroundServerStack.ts'
import {
  type DuckdbOwnerLeaseMetadata,
  isDuckdbOwnerLeaseProcessAlive,
  isDuckdbOwnerLeaseStale,
  readDuckdbOwnerLease,
} from '../src/server/utils/duckdbOwnerLease.ts'
import {loadEnv} from '../src/server/utils/env.ts'
import {runtimeReadyPath, runtimeStatePath} from '../src/server/utils/runtimeReadyContract.ts'

const watchedPaths = ['src', 'package.json', 'tsconfig.json']
const restartDelayMs = 150
const stackShutdownTimeoutMs = 20_000
const forcedKillTimeoutMs = 5_000
const healthProbeTimeoutMs = 1_500
const parentMonitorIntervalMs = 1_000
const devWatcherLockHeartbeatIntervalMs = 1_000

type ServerProcess = Subprocess<'inherit', 'inherit', 'inherit'>
type DevWatcherLockMetadata = {
  apiPort: number
  judgePort: number
  maintenancePort: number
  pid: number
  startedAt: string
}
type ServerStackLockMetadata = {
  apiPort: number
  cwd: string
  judgePort?: number
  maintenancePort: number
  pid: number
  startedAt: string
}
type ExistingAction = 'attach' | 'cancel' | 'restart' | 'stop'
type ExistingStackState = {
  apiHealth: {counts: null | Record<string, number>; reachable: boolean}
  duckdbLease: null | {alive: boolean; metadata: DuckdbOwnerLeaseMetadata; stale: boolean}
  judgeHealth: {reachable: boolean}
  runtimePids: {api: number | null; judge: number | null; maintenance: number | null}
  sqliteHealth: {
    jobCounts: null | Record<string, number>
    leasesAlive: number
    leasesStale: number
    leasesTotal: number
  }
  stackLock: ServerStackLockMetadata
  maintenanceHealth: {martRefresh: null | {articleQueued: number; projectQueued: number}; reachable: boolean}
}
type RuntimeStateResponse = {data?: {pid?: number}}
type ProcessInfo = {command: string; parentPid: number}

let restartTimer: ReturnType<typeof setTimeout> | null = null
let serverProcess: ServerProcess | null = null
let shuttingDown = false
let attachedToExistingStack = false
let parentMonitor: ReturnType<typeof setInterval> | null = null
let devWatcherLockHeartbeat: ReturnType<typeof setInterval> | null = null

const parentPid = process.ppid
const bunExecutablePath = realpathSync(process.execPath)
const devWatcherStartedAt = new Date().toISOString()

const stackConfig = getBackgroundServerStackConfig(process.env)
const serverStackLockPath = join(
  tmpdir(),
  'forska-server-stack',
  `${stackConfig.apiPort}-${stackConfig.maintenancePort}-${stackConfig.judgePort}.lock.json`,
)
const devWatcherLockPath = join(
  tmpdir(),
  'forska-dev-server-watch',
  `${stackConfig.apiPort}-${stackConfig.maintenancePort}-${stackConfig.judgePort}.lock.json`,
)

const log = (message: string) => {
  console.log(`[dev:server] ${message}`)
}

const formatIso = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

const formatBool = (value: boolean) => {
  return value ? 'yes' : 'no'
}

const isMissingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (ms: number) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const waitForProcessExit = async (pid: number, deadlineMs = Date.now() + stackShutdownTimeoutMs): Promise<boolean> => {
  if (!isProcessAlive(pid)) {
    return true
  }

  if (Date.now() >= deadlineMs) {
    return false
  }

  await waitFor(250)
  return waitForProcessExit(pid, deadlineMs)
}

const readServerStackLock = async () => {
  try {
    return JSON.parse(await readFile(serverStackLockPath, 'utf8')) as ServerStackLockMetadata
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }

    throw error
  }
}

const readDevWatcherLock = async () => {
  try {
    return JSON.parse(await readFile(devWatcherLockPath, 'utf8')) as DevWatcherLockMetadata
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }

    throw error
  }
}

const getDevWatcherLockMetadata = (): DevWatcherLockMetadata => {
  return {
    apiPort: stackConfig.apiPort,
    judgePort: stackConfig.judgePort,
    maintenancePort: stackConfig.maintenancePort,
    pid: process.pid,
    startedAt: devWatcherStartedAt,
  }
}

const writeDevWatcherLock = async (metadata: DevWatcherLockMetadata, flag: 'w' | 'wx') => {
  await mkdir(dirname(devWatcherLockPath), {recursive: true})
  await writeFile(devWatcherLockPath, JSON.stringify(metadata, null, 2), {flag})
}

const refreshDevWatcherLock = async () => {
  if (shuttingDown) {
    return
  }

  const currentLock = await readDevWatcherLock()

  if (currentLock !== null && currentLock.pid !== process.pid && isProcessAlive(currentLock.pid)) {
    return
  }

  await writeDevWatcherLock(getDevWatcherLockMetadata(), 'w')
}

const startDevWatcherLockHeartbeat = () => {
  if (devWatcherLockHeartbeat !== null) {
    return
  }

  devWatcherLockHeartbeat = setInterval(() => {
    return void refreshDevWatcherLock().catch((error) => {
      log(`failed to refresh watcher lock: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, devWatcherLockHeartbeatIntervalMs)

  devWatcherLockHeartbeat.unref?.()
}

const stopDevWatcherLockHeartbeat = () => {
  if (devWatcherLockHeartbeat === null) {
    return
  }

  clearInterval(devWatcherLockHeartbeat)
  devWatcherLockHeartbeat = null
}

const getActionOverride = (): ExistingAction | null => {
  const value = String(process.env.FORSKA_DEV_SERVER_WATCH_ACTION ?? '')
    .trim()
    .toLowerCase()

  return value === 'attach' || value === 'restart' || value === 'stop' || value === 'cancel' ? value : null
}

const fetchJson = async <T>(url: string): Promise<T | null> => {
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(healthProbeTimeoutMs)})
    return response.ok ? ((await response.json()) as T) : null
  } catch {
    return null
  }
}

const readJudgmentJobLeaseFiles = async (): Promise<JudgmentJobLeaseMetadata[]> => {
  const rootDirectory = getJudgmentJobsRootDirectory()

  if (!existsSync(rootDirectory)) {
    return []
  }

  return (await readdir(rootDirectory))
    .filter((entry) => {
      return entry.endsWith('.lease.json')
    })
    .reduce<Promise<JudgmentJobLeaseMetadata[]>>(async (promise, entry) => {
      const leases = await promise
      const nextPath = join(rootDirectory, entry)

      try {
        const metadata = JSON.parse(await readFile(nextPath, 'utf8')) as JudgmentJobLeaseMetadata
        return [...leases, metadata]
      } catch {
        return leases
      }
    }, Promise.resolve([]))
}

const getExistingStackState = async (stackLock: ServerStackLockMetadata): Promise<ExistingStackState> => {
  const judgePort = stackLock.judgePort ?? stackConfig.judgePort
  const [apiHealthResponse, maintenanceReadyResponse, maintenanceHealthResponse, duckdbLease, sqliteLeases] =
    await Promise.all([
      fetchJson<{data?: Record<string, number>}>(`http://127.0.0.1:${stackLock.apiPort}/api/judgmentsjobs-health`),
      fetchJson<{data?: {ready?: boolean}}>(`http://127.0.0.1:${stackLock.maintenancePort}${runtimeReadyPath}`),
      fetchJson<{
        data?: {martRefresh?: {progress?: {queuedArticleRefreshCount?: number; queuedProjectRefreshCount?: number}}}
      }>(`http://127.0.0.1:${stackLock.maintenancePort}/api/duckdb_owner_connections`),
      Effect.runPromise(readDuckdbOwnerLease(loadEnv().DUCKDB_PATH)),
      readJudgmentJobLeaseFiles(),
    ])
  const [apiRuntimeState, maintenanceRuntimeState, judgeRuntimeState, judgeHealthResponse] = await Promise.all([
    fetchJson<RuntimeStateResponse>(`http://127.0.0.1:${stackLock.apiPort}${runtimeStatePath}`),
    fetchJson<RuntimeStateResponse>(`http://127.0.0.1:${stackLock.maintenancePort}${runtimeStatePath}`),
    fetchJson<RuntimeStateResponse>(`http://127.0.0.1:${judgePort}${runtimeStatePath}`),
    fetchJson<{data?: {ready?: boolean}}>(`http://127.0.0.1:${judgePort}/api/runtime/ready`),
  ])

  return {
    apiHealth: {counts: apiHealthResponse?.data ?? null, reachable: apiHealthResponse !== null},
    duckdbLease: duckdbLease
      ? {
          alive: isDuckdbOwnerLeaseProcessAlive(duckdbLease),
          metadata: duckdbLease,
          stale: isDuckdbOwnerLeaseStale(duckdbLease),
        }
      : null,
    judgeHealth: {reachable: judgeHealthResponse !== null},
    runtimePids: {
      api: apiRuntimeState?.data?.pid ?? null,
      judge: judgeRuntimeState?.data?.pid ?? null,
      maintenance: maintenanceRuntimeState?.data?.pid ?? null,
    },
    sqliteHealth: {
      jobCounts: apiHealthResponse?.data ?? null,
      leasesAlive: sqliteLeases.filter((lease) => {
        return isJudgmentJobLeaseProcessAlive(lease)
      }).length,
      leasesStale: sqliteLeases.filter((lease) => {
        return isJudgmentJobLeaseStale(lease)
      }).length,
      leasesTotal: sqliteLeases.length,
    },
    stackLock,
    maintenanceHealth: {
      martRefresh: maintenanceHealthResponse?.data?.martRefresh?.progress
        ? {
            articleQueued: Number(maintenanceHealthResponse.data.martRefresh.progress.queuedArticleRefreshCount ?? 0),
            projectQueued: Number(maintenanceHealthResponse.data.martRefresh.progress.queuedProjectRefreshCount ?? 0),
          }
        : null,
      reachable: maintenanceReadyResponse !== null,
    },
  }
}

const getUnlockedExistingStackState = async (): Promise<ExistingStackState | null> => {
  const syntheticStackLock = {
    apiPort: stackConfig.apiPort,
    cwd: process.cwd(),
    judgePort: stackConfig.judgePort,
    maintenancePort: stackConfig.maintenancePort,
    pid: 0,
    startedAt: new Date().toISOString(),
  } satisfies ServerStackLockMetadata
  const existingStack = await getExistingStackState(syntheticStackLock)
  const replacementPid =
    existingStack.runtimePids.api ?? existingStack.runtimePids.maintenance ?? existingStack.runtimePids.judge ?? 0

  return existingStack.apiHealth.reachable
    || existingStack.maintenanceHealth.reachable
    || existingStack.judgeHealth.reachable
    ? {...existingStack, stackLock: {...syntheticStackLock, pid: replacementPid}}
    : null
}

const printExistingStackState = async ({
  existingStack,
  existingWatcher,
}: {
  existingStack: ExistingStackState | null
  existingWatcher: DevWatcherLockMetadata | null
}) => {
  log('existing dev stack detected')

  if (existingWatcher) {
    output.write(`  watcher: pid=${existingWatcher.pid} started=${formatIso(existingWatcher.startedAt)}\n`)
  } else {
    output.write('  watcher: none\n')
  }

  if (existingStack) {
    output.write(
      `  stack: pid=${existingStack.stackLock.pid} started=${formatIso(existingStack.stackLock.startedAt)}\n`,
    )
    output.write(`  api healthy: ${formatBool(existingStack.apiHealth.reachable)}\n`)
    output.write(`  maintenance healthy: ${formatBool(existingStack.maintenanceHealth.reachable)}\n`)
    output.write(`  judge healthy: ${formatBool(existingStack.judgeHealth.reachable)}\n`)
    output.write(
      `  duckdb lease: ${
        existingStack.duckdbLease
          ? `${existingStack.duckdbLease.metadata.serverRole}@${existingStack.duckdbLease.metadata.hostname}:${existingStack.duckdbLease.metadata.apiServerPort} pid=${existingStack.duckdbLease.metadata.pid} alive=${formatBool(existingStack.duckdbLease.alive)} stale=${formatBool(existingStack.duckdbLease.stale)}`
          : 'none'
      }\n`,
    )
    output.write(
      `  sqlite leases: total=${existingStack.sqliteHealth.leasesTotal} alive=${existingStack.sqliteHealth.leasesAlive} stale=${existingStack.sqliteHealth.leasesStale}\n`,
    )

    if (existingStack.apiHealth.counts) {
      output.write(
        `  jobs health: healthy=${existingStack.apiHealth.counts.healthy ?? 0} draining=${existingStack.apiHealth.counts.draining ?? 0} offlineRepairRequired=${existingStack.apiHealth.counts.offlineRepairRequired ?? 0} quarantined=${existingStack.apiHealth.counts.quarantined ?? 0} retainedOutbox=${existingStack.apiHealth.counts.retainedOutbox ?? 0} staleImport=${existingStack.apiHealth.counts.staleImport ?? 0}\n`,
      )
    }

    if (existingStack.maintenanceHealth.martRefresh) {
      output.write(
        `  mart queue: projectQueued=${existingStack.maintenanceHealth.martRefresh.projectQueued} articleQueued=${existingStack.maintenanceHealth.martRefresh.articleQueued}\n`,
      )
    }
  } else {
    output.write('  stack: none\n')
  }
}

const getDefaultExistingAction = ({existingStack}: {existingStack: ExistingStackState | null}) => {
  return existingStack?.apiHealth.reachable
    && existingStack?.maintenanceHealth.reachable
    && existingStack.judgeHealth.reachable
    ? 'attach'
    : 'restart'
}

const promptForExistingAction = async ({
  existingStack,
  existingWatcher,
}: {
  existingStack: ExistingStackState | null
  existingWatcher: DevWatcherLockMetadata | null
}): Promise<ExistingAction> => {
  const override = getActionOverride()

  if (override) {
    log(`using FORSKA_DEV_SERVER_WATCH_ACTION=${override}`)
    return override
  }

  if (!input.isTTY || !output.isTTY) {
    await printExistingStackState({existingStack, existingWatcher})
    throw new Error(
      'An existing dev watcher or server stack is already running. Re-run interactively or set FORSKA_DEV_SERVER_WATCH_ACTION=attach|restart|stop|cancel.',
    )
  }

  await printExistingStackState({existingStack, existingWatcher})
  output.write('Choose an action:\n')
  output.write(
    `  1. Attach to current stack${getDefaultExistingAction({existingStack}) === 'attach' ? ' (recommended)' : ''}\n`,
  )
  output.write(
    `  2. Stop existing watcher/stack and restart under this watcher${getDefaultExistingAction({existingStack}) === 'restart' ? ' (recommended)' : ''}\n`,
  )
  output.write('  3. Stop existing watcher/stack and exit\n')
  output.write('  4. Cancel\n')

  const rl = readline.createInterface({input, output})

  try {
    const answer = (await rl.question('Selection [1-4]: ')).trim()

    return answer === '2' ? 'restart' : answer === '3' ? 'stop' : answer === '4' ? 'cancel' : 'attach'
  } finally {
    rl.close()
  }
}

const getExistingLocks = async () => {
  const [existingWatcher, existingStack] = await Promise.all([readDevWatcherLock(), readServerStackLock()])
  const shouldProbeUnlockedStack = existingStack === null || !isProcessAlive(existingStack.pid)
  const lockedExistingStack =
    existingStack && isProcessAlive(existingStack.pid)
      ? await getExistingStackState(existingStack)
      : existingStack
        ? null
        : null

  return {
    existingStack: lockedExistingStack ?? (shouldProbeUnlockedStack ? await getUnlockedExistingStackState() : null),
    existingWatcher: existingWatcher && isProcessAlive(existingWatcher.pid) ? existingWatcher : null,
  }
}

const stopExternalProcess = async ({pid, processName}: {pid: number; processName: string}) => {
  if (!isProcessAlive(pid)) {
    return
  }

  process.kill(pid, 'SIGTERM')

  if (await waitForProcessExit(pid)) {
    return
  }

  log(`${processName} pid=${pid} did not exit after SIGTERM; sending SIGKILL`)

  if (isProcessAlive(pid)) {
    process.kill(pid, 'SIGKILL')
  }

  if (await waitForProcessExit(pid, Date.now() + forcedKillTimeoutMs)) {
    return
  }

  throw new Error(`Timed out waiting for ${processName} pid=${pid} to exit`)
}

const getProcessInfo = (pid: number): ProcessInfo | null => {
  const result = globalThis.Bun.spawnSync(['ps', '-o', 'ppid=', '-o', 'command=', '-p', String(pid)], {
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const output = result.stdout.toString().trim()
  const match = /^(\d+)\s+([\s\S]+)$/.exec(output)

  if (result.exitCode !== 0 || match === null || match[1] === undefined || match[2] === undefined) {
    return null
  }

  const parentPidValue = Number.parseInt(match[1], 10)

  return Number.isInteger(parentPidValue) ? {command: match[2], parentPid: parentPidValue} : null
}

const getRuntimePid = async (port: number) => {
  return (await fetchJson<RuntimeStateResponse>(`http://127.0.0.1:${port}${runtimeStatePath}`))?.data?.pid ?? null
}

const getConfiguredRuntimePids = async () => {
  const [api, maintenance, judge] = await Promise.all([
    getRuntimePid(stackConfig.apiPort),
    getRuntimePid(stackConfig.maintenancePort),
    getRuntimePid(stackConfig.judgePort),
  ])

  return {api, judge, maintenance}
}

const uniquePids = (pids: Array<number | null>) => {
  return [...new Set(pids)].filter((pid): pid is number => {
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== parentPid
  })
}

const getRuntimeSupervisorStopChain = (supervisorPid: number) => {
  const supervisorInfo = getProcessInfo(supervisorPid)
  const watcherPid =
    supervisorInfo !== null && getProcessInfo(supervisorInfo.parentPid)?.command.includes('scripts/devServerWatch.ts')
      ? supervisorInfo.parentPid
      : null

  return uniquePids([watcherPid, supervisorPid])
}

const getUnlockedStackStopPids = (runtimePids: number[]) => {
  const supervisorPids = uniquePids(
    runtimePids.map((runtimePid) => {
      return getProcessInfo(runtimePid)?.parentPid ?? null
    }),
  )
  const stopPids = supervisorPids.flatMap((supervisorPid) => {
    return getRuntimeSupervisorStopChain(supervisorPid)
  })

  return stopPids.length === 0 ? runtimePids : uniquePids(stopPids)
}

const stopExistingUnlockedStack = async () => {
  const runtimePids = uniquePids(Object.values(await getConfiguredRuntimePids()))
  const stopPids = getUnlockedStackStopPids(runtimePids)

  await stopPids.reduce<Promise<void>>(async (previous, pid) => {
    await previous
    return stopExternalProcess({pid, processName: 'unlocked server stack process'})
  }, Promise.resolve())
}

const stopExistingWatcher = async (existingWatcher: DevWatcherLockMetadata | null) => {
  if (!existingWatcher || !isProcessAlive(existingWatcher.pid)) {
    return
  }

  log(`stopping existing dev watcher pid=${existingWatcher.pid}`)
  await stopExternalProcess({pid: existingWatcher.pid, processName: 'dev watcher'})
}

const releaseDevWatcherLock = async () => {
  const currentLock = await readDevWatcherLock()

  if (!currentLock || currentLock.pid !== process.pid) {
    return
  }

  await unlink(devWatcherLockPath).catch((error) => {
    if (!isMissingFileError(error)) {
      throw error
    }
  })
}

const acquireDevWatcherLock = async (): Promise<void> => {
  const metadata = getDevWatcherLockMetadata()

  try {
    await writeDevWatcherLock(metadata, 'wx')
    startDevWatcherLockHeartbeat()
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
      throw error
    }

    const currentLock = await readDevWatcherLock()

    if (!currentLock) {
      return acquireDevWatcherLock()
    }

    if (!isProcessAlive(currentLock.pid)) {
      await unlink(devWatcherLockPath).catch((unlinkError) => {
        if (!isMissingFileError(unlinkError)) {
          throw unlinkError
        }
      })

      return acquireDevWatcherLock()
    }

    log(`taking over existing dev watcher pid=${currentLock.pid}`)
    await stopExternalProcess({pid: currentLock.pid, processName: 'dev watcher'})
    return acquireDevWatcherLock()
  }
}

const waitForStackLockRelease = async (deadlineMs = Date.now() + stackShutdownTimeoutMs): Promise<void> => {
  const currentLock = await readServerStackLock()

  if (!currentLock) {
    return
  }

  if (!isProcessAlive(currentLock.pid)) {
    await unlink(serverStackLockPath).catch((error) => {
      if (!isMissingFileError(error)) {
        throw error
      }
    })

    return
  }

  if (Date.now() >= deadlineMs) {
    throw new Error(
      `Timed out waiting for server stack pid=${currentLock.pid} to release lock for ports ${currentLock.apiPort}/${currentLock.maintenancePort}`,
    )
  }

  await waitFor(250)
  return waitForStackLockRelease(deadlineMs)
}

const stopExistingLockedStack = async () => {
  const currentLock = await readServerStackLock()

  if (!currentLock) {
    await stopExistingUnlockedStack()
    return
  }

  if (!isProcessAlive(currentLock.pid)) {
    await unlink(serverStackLockPath).catch((error) => {
      if (!isMissingFileError(error)) {
        throw error
      }
    })

    return
  }

  const currentChildPid = serverProcess?.pid ?? null

  if (currentChildPid === currentLock.pid) {
    await waitForStackLockRelease()
    return
  }

  log(`taking over existing server stack pid=${currentLock.pid}`)
  await stopExternalProcess({pid: currentLock.pid, processName: 'server stack'})
  await waitForStackLockRelease()
}

const getServerEnv = () => {
  return {...process.env, BUN_CONFIG_MAX_HTTP_REQUESTS: process.env.BUN_CONFIG_MAX_HTTP_REQUESTS ?? '2048'}
}

const startServer = async () => {
  attachedToExistingStack = false
  await stopExistingLockedStack()
  serverProcess = spawn([bunExecutablePath, 'scripts/startServerStack.ts'], {
    cwd: process.cwd(),
    env: getServerEnv(),
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  })
}

const stopServer = async () => {
  if (attachedToExistingStack) {
    attachedToExistingStack = false
    await stopExistingLockedStack()
    return
  }

  if (!serverProcess) {
    return
  }

  const processToStop = serverProcess
  serverProcess = null

  if (processToStop.pid !== undefined) {
    await stopExternalProcess({pid: processToStop.pid, processName: 'server stack'})
  } else {
    processToStop.kill('SIGTERM')
    await processToStop.exited
  }

  await waitForStackLockRelease()
}

const restartServer = () => {
  if (shuttingDown) {
    return
  }

  if (restartTimer) {
    clearTimeout(restartTimer)
  }

  restartTimer = setTimeout(() => {
    void (async () => {
      restartTimer = null
      log('change detected, restarting')
      await stopServer()
      await startServer()
    })()
  }, restartDelayMs)
}

const createWatcher = (watchedPath: string) => {
  if (!existsSync(watchedPath)) {
    return
  }

  watch(watchedPath, {recursive: true}, () => {
    restartServer()
  })
}

const stopParentMonitor = () => {
  if (parentMonitor === null) {
    return
  }

  clearInterval(parentMonitor)
  parentMonitor = null
}

const shouldShutdownForParentExit = () => {
  return process.ppid !== parentPid || !isProcessAlive(parentPid)
}

const startParentMonitor = () => {
  if (parentMonitor !== null) {
    return
  }

  parentMonitor = setInterval(() => {
    if (shuttingDown || !shouldShutdownForParentExit()) {
      return
    }

    log(`parent pid=${parentPid} exited, shutting down`)
    void shutdown()
  }, parentMonitorIntervalMs)

  parentMonitor.unref?.()
}

const shutdown = async () => {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  stopParentMonitor()
  stopDevWatcherLockHeartbeat()

  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }

  await stopServer()
  await releaseDevWatcherLock()
  process.exit(0)
}

process.on('SIGINT', () => {
  void shutdown()
})

process.on('SIGTERM', () => {
  void shutdown()
})

startParentMonitor()

watchedPaths.forEach((watchedPath) => {
  createWatcher(watchedPath)
})

await (async () => {
  const {existingStack, existingWatcher} = await getExistingLocks()

  if (!existingStack && !existingWatcher) {
    await acquireDevWatcherLock()
    void startServer()
    return
  }

  const action = await promptForExistingAction({existingStack, existingWatcher})

  if (action === 'cancel') {
    await releaseDevWatcherLock()
    process.exit(0)
  }

  if (action === 'stop') {
    await stopExistingWatcher(existingWatcher)
    await stopExistingLockedStack()
    process.exit(0)
  }

  await stopExistingWatcher(existingWatcher)
  await acquireDevWatcherLock()

  if (action === 'attach') {
    if (!existingStack) {
      void startServer()
      return
    }

    attachedToExistingStack = true
    log('attached to existing stack; file changes will restart it under this watcher')
    return
  }

  void startServer()
})()
