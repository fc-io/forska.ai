import {existsSync, watch} from 'node:fs'
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

const watchedPaths = ['src', 'package.json', 'tsconfig.json']
const restartDelayMs = 150
const stackShutdownTimeoutMs = 20_000
const healthProbeTimeoutMs = 1_500

type ServerProcess = Subprocess<'inherit', 'inherit', 'inherit'>
type DevWatcherLockMetadata = {apiPort: number; pid: number; startedAt: string; workerPort: number}
type ServerStackLockMetadata = {apiPort: number; cwd: string; pid: number; startedAt: string; workerPort: number}
type ExistingAction = 'attach' | 'cancel' | 'restart' | 'stop'
type ExistingStackState = {
  apiHealth: {counts: null | Record<string, number>; reachable: boolean}
  duckdbLease: null | {alive: boolean; metadata: DuckdbOwnerLeaseMetadata; stale: boolean}
  sqliteHealth: {
    jobCounts: null | Record<string, number>
    leasesAlive: number
    leasesStale: number
    leasesTotal: number
  }
  stackLock: ServerStackLockMetadata
  workerHealth: {martRefresh: null | {articleQueued: number; projectQueued: number}; reachable: boolean}
}

let restartTimer: ReturnType<typeof setTimeout> | null = null
let serverProcess: ServerProcess | null = null
let shuttingDown = false
let attachedToExistingStack = false

const stackConfig = getBackgroundServerStackConfig(process.env)
const serverStackLockPath = join(
  tmpdir(),
  'forska-server-stack',
  `${stackConfig.apiPort}-${stackConfig.workerPort}.lock.json`,
)
const devWatcherLockPath = join(
  tmpdir(),
  'forska-dev-server-watch',
  `${stackConfig.apiPort}-${stackConfig.workerPort}.lock.json`,
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
  const [apiHealthResponse, workerHealthResponse, duckdbLease, sqliteLeases] = await Promise.all([
    fetchJson<{data?: Record<string, number>}>(`http://127.0.0.1:${stackLock.apiPort}/api/judgmentsjobs-health`),
    fetchJson<{
      data?: {martRefresh?: {progress?: {queuedArticleRefreshCount?: number; queuedProjectRefreshCount?: number}}}
    }>(`http://127.0.0.1:${stackLock.workerPort}/api/writer_connections`),
    Effect.runPromise(readDuckdbOwnerLease(loadEnv().DUCKDB_PATH)),
    readJudgmentJobLeaseFiles(),
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
    workerHealth: {
      martRefresh: workerHealthResponse?.data?.martRefresh?.progress
        ? {
            articleQueued: Number(workerHealthResponse.data.martRefresh.progress.queuedArticleRefreshCount ?? 0),
            projectQueued: Number(workerHealthResponse.data.martRefresh.progress.queuedProjectRefreshCount ?? 0),
          }
        : null,
      reachable: workerHealthResponse !== null,
    },
  }
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
    output.write(`  worker healthy: ${formatBool(existingStack.workerHealth.reachable)}\n`)
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

    if (existingStack.workerHealth.martRefresh) {
      output.write(
        `  mart queue: projectQueued=${existingStack.workerHealth.martRefresh.projectQueued} articleQueued=${existingStack.workerHealth.martRefresh.articleQueued}\n`,
      )
    }
  } else {
    output.write('  stack: none\n')
  }
}

const getDefaultExistingAction = ({existingStack}: {existingStack: ExistingStackState | null}) => {
  return existingStack?.apiHealth.reachable && existingStack?.workerHealth.reachable ? 'attach' : 'restart'
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
    `  2. Restart stack under this watcher${getDefaultExistingAction({existingStack}) === 'restart' ? ' (recommended)' : ''}\n`,
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

  return {
    existingStack:
      existingStack && isProcessAlive(existingStack.pid)
        ? await getExistingStackState(existingStack)
        : existingStack
          ? null
          : null,
    existingWatcher: existingWatcher && isProcessAlive(existingWatcher.pid) ? existingWatcher : null,
  }
}

const stopExternalProcess = async (pid: number) => {
  process.kill(pid, 'SIGTERM')
  const deadlineMs = Date.now() + stackShutdownTimeoutMs

  while (isProcessAlive(pid)) {
    if (Date.now() >= deadlineMs) {
      throw new Error(`Timed out waiting for pid=${pid} to exit`)
    }

    await waitFor(250)
  }
}

const stopExistingWatcher = async (existingWatcher: DevWatcherLockMetadata | null) => {
  if (!existingWatcher || !isProcessAlive(existingWatcher.pid)) {
    return
  }

  log(`stopping existing dev watcher pid=${existingWatcher.pid}`)
  await stopExternalProcess(existingWatcher.pid)
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
  const metadata = {
    apiPort: stackConfig.apiPort,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    workerPort: stackConfig.workerPort,
  } satisfies DevWatcherLockMetadata

  try {
    await mkdir(dirname(devWatcherLockPath), {recursive: true})
    await writeFile(devWatcherLockPath, JSON.stringify(metadata, null, 2), {flag: 'wx'})
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
    process.kill(currentLock.pid, 'SIGTERM')
    await waitFor(500)
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
      `Timed out waiting for server stack pid=${currentLock.pid} to release lock for ports ${currentLock.apiPort}/${currentLock.workerPort}`,
    )
  }

  await waitFor(250)
  return waitForStackLockRelease(deadlineMs)
}

const stopExistingLockedStack = async () => {
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

  const currentChildPid = serverProcess?.pid ?? null

  if (currentChildPid === currentLock.pid) {
    await waitForStackLockRelease()
    return
  }

  log(`taking over existing server stack pid=${currentLock.pid}`)
  process.kill(currentLock.pid, 'SIGTERM')
  await waitForStackLockRelease()
}

const getServerEnv = () => {
  return {...process.env, BUN_CONFIG_MAX_HTTP_REQUESTS: process.env.BUN_CONFIG_MAX_HTTP_REQUESTS ?? '2048'}
}

const startServer = async () => {
  attachedToExistingStack = false
  await stopExistingLockedStack()
  serverProcess = spawn(['bun', 'scripts/startServerStack.ts'], {
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
  processToStop.kill()
  await processToStop.exited
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

const shutdown = async () => {
  if (shuttingDown) {
    return
  }

  shuttingDown = true

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
