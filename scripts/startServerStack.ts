import {realpathSync} from 'node:fs'
import {mkdir, rename, unlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {spawn, spawnSync, type Subprocess} from 'bun'
import {Effect} from 'effect'

import {getBackgroundServerEnv, getBackgroundServerStackConfig} from '../src/server/utils/backgroundServerStack.ts'
import {isDuckdbOwnerLeaseProcessAlive, readDuckdbOwnerLease} from '../src/server/utils/duckdbOwnerLease.ts'
import {getConfiguredDuckdbPath} from '../src/server/utils/getDuckdbPath.ts'
import {readJudgeWorkerJournalLock} from '../src/server/utils/judgeWorkerJournalIdentity.ts'
import {isLockOwnedByCurrentMachine} from '../src/server/utils/localMachineIdentity.ts'
import {installRuntimeJsonlSink, writeRuntimeLogEvent} from '../src/server/utils/runtimeLogger.ts'
import {resolveRuntimeProcessIdentity, type RuntimeProcessIdentity} from '../src/server/utils/runtimeProcessIdentity.ts'
import {runtimeReadyPath} from '../src/server/utils/runtimeReadyContract.ts'
import {withAbortSignalTimeout} from '../src/utils/withAbortSignalTimeout.ts'
import {
  getNextJudgeWatchdogState,
  isJudgeWatchdogResponseHealthy,
  type JudgeRuntimeReadyBody,
} from './getNextJudgeWatchdogState.ts'
import {
  processLockMalformedRetryIntervalMs,
  processLockMalformedStaleAfterMs,
  readJsonProcessLockState,
  readProcessLockForAcquisition,
} from './processLockAcquisition.ts'

type ManagedRole = 'api' | 'judge' | 'maintenance'
type ServerProcess = Subprocess<'ignore', 'inherit', 'inherit'>
type ServerStackLockMetadata = {
  apiPort: number
  cwd: string
  judgePort: number
  maintenancePort: number
  pid: number
  startedAt: string
}

const isPositiveInteger = (value: unknown) => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

const isNonEmptyString = (value: unknown) => {
  return typeof value === 'string' && value.length > 0
}

const isServerStackLockMetadata = (value: unknown): value is ServerStackLockMetadata => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const metadata = value as Record<string, unknown>

  return (
    isPositiveInteger(metadata.apiPort)
    && isNonEmptyString(metadata.cwd)
    && isPositiveInteger(metadata.judgePort)
    && isPositiveInteger(metadata.maintenancePort)
    && isPositiveInteger(metadata.pid)
    && isNonEmptyString(metadata.startedAt)
  )
}

type ManagedServerState = {
  apiProcess: ServerProcess | null
  apiReadyPromise: Promise<void> | null
  judgeProcess: ServerProcess | null
  judgeReadyPromise: Promise<void> | null
  lastExitedProcesses: Partial<Record<ManagedRole, ManagedProcessExitRecord>>
  shuttingDown: boolean
  maintenanceProcess: ServerProcess | null
  maintenanceReadyPromise: Promise<void> | null
}
type ManagedProcessExitRecord = {exitedAtMs: number; pid: number}

const restartDelayMs = 1_000
const maintenanceStartupTimeoutMs = 1_800_000
const judgeStartupTimeoutMs = 90_000
const shutdownTimeoutMs = 20_000
const forcedKillTimeoutMs = 5_000
const duckdbOwnerPollIntervalMs = 250
const judgeHealthWatchdogFailureThreshold = 3
const judgeHealthWatchdogIntervalMs = 5_000
const parentMonitorIntervalMs = 1_000
const serverStackLockHeartbeatIntervalMs = 1_000

const config = getBackgroundServerStackConfig(process.env)
const managedProcessRuntimeIdentities = new WeakMap<ServerProcess, RuntimeProcessIdentity>()
const serverStackLockPath = join(
  tmpdir(),
  'forska-server-stack',
  `${config.apiPort}-${config.maintenancePort}-${config.judgePort}.lock.json`,
)

if (
  config.apiPort === config.maintenancePort
  || config.apiPort === config.judgePort
  || config.maintenancePort === config.judgePort
) {
  throw new Error(
    `Split server ports must differ; received api=${config.apiPort} maintenance=${config.maintenancePort} judge=${config.judgePort}`,
  )
}

console.log(
  `[server:stack] api_port=${config.apiPort} maintenance_port=${config.maintenancePort} judge_port=${config.judgePort} maintenance_duckdb_memory_limit=${config.maintenanceDuckdbMemoryLimit}`,
)

const isMissingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const isExistingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const getChildProcessIdsCommand = (pid: number) => {
  return process.platform === 'win32'
    ? [
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}" | Select-Object -ExpandProperty ProcessId`,
      ]
    : ['pgrep', '-P', String(pid)]
}

const getChildProcessIds = (pid: number) => {
  let result: ReturnType<typeof spawnSync>

  try {
    result = spawnSync(getChildProcessIdsCommand(pid), {stderr: 'pipe', stdin: 'ignore', stdout: 'pipe'})
  } catch (error) {
    if (isMissingFileError(error)) {
      return []
    }

    throw error
  }

  if (result.exitCode !== 0) {
    return []
  }

  return result.stdout
    .toString()
    .split(/\s+/u)
    .map((value) => {
      return Number(value)
    })
    .filter((value) => {
      return Number.isInteger(value) && value > 0
    })
}

const getDescendantProcessIds = (pid: number): number[] => {
  const childPids = getChildProcessIds(pid)

  return childPids.flatMap((childPid) => {
    return [childPid, ...getDescendantProcessIds(childPid)]
  })
}

const killProcessIds = (pids: number[], signal: 'SIGTERM' | 'SIGKILL') => {
  for (const pid of new Set(pids)) {
    try {
      if (isProcessAlive(pid)) {
        process.kill(pid, signal)
      }
    } catch (error) {
      if (isProcessAlive(pid)) {
        throw error
      }
    }
  }
}

const readServerStackLock = async () => {
  const state = await readJsonProcessLockState(serverStackLockPath, isServerStackLockMetadata)

  if (state.kind === 'malformed') {
    console.error(`[server:stack] ignoring malformed supervisor lock at ${serverStackLockPath}`)
  }

  return state.kind === 'valid' ? state.metadata : null
}

const releaseServerStackLock = async () => {
  const currentLock = await readServerStackLock()

  if (!currentLock || currentLock.pid !== process.pid) {
    return
  }

  await unlink(serverStackLockPath).catch((error) => {
    if (!isMissingFileError(error)) {
      throw error
    }
  })
}

const acquireServerStackLock = async (): Promise<void> => {
  const metadata = getServerStackLockMetadata()

  try {
    await writeServerStackLock(metadata, 'wx')
  } catch (error) {
    if (!isExistingFileError(error)) {
      throw error
    }

    const currentLock = await readProcessLockForAcquisition({
      lockPath: serverStackLockPath,
      now: Date.now,
      readState: () => {
        return readJsonProcessLockState(serverStackLockPath, isServerStackLockMetadata)
      },
      retryIntervalMs: processLockMalformedRetryIntervalMs,
      staleAfterMs: processLockMalformedStaleAfterMs,
      wait: waitFor,
    })

    if (!currentLock) {
      return acquireServerStackLock()
    }

    if (!isProcessAlive(currentLock.pid)) {
      await unlink(serverStackLockPath).catch((unlinkError) => {
        if (!isMissingFileError(unlinkError)) {
          throw unlinkError
        }
      })

      return acquireServerStackLock()
    }

    throw new Error(
      `Another server stack is already running for ports ${config.apiPort}/${config.maintenancePort} (pid=${currentLock.pid}, startedAt=${currentLock.startedAt}). Stop it before starting a new one.`,
      {cause: error},
    )
  }
}

const managedServerState: ManagedServerState = {
  apiProcess: null,
  apiReadyPromise: null,
  judgeProcess: null,
  judgeReadyPromise: null,
  lastExitedProcesses: {},
  maintenanceProcess: null,
  maintenanceReadyPromise: null,
  shuttingDown: false,
}

let parentMonitor: ReturnType<typeof setInterval> | null = null
let serverStackLockHeartbeat: ReturnType<typeof setInterval> | null = null
let judgeHealthWatchdog: ReturnType<typeof setInterval> | null = null
let judgeHealthWatchdogCheck: Promise<void> | null = null
let judgeHealthWatchdogFailureCount = 0

const parentPid = process.ppid
const bunExecutablePath = realpathSync(process.execPath)
const serverStackStartedAt = new Date().toISOString()

installRuntimeJsonlSink({envValues: process.env, timestamp: serverStackStartedAt})

const getServerStackLockMetadata = (): ServerStackLockMetadata => {
  return {
    apiPort: config.apiPort,
    cwd: process.cwd(),
    judgePort: config.judgePort,
    maintenancePort: config.maintenancePort,
    pid: process.pid,
    startedAt: serverStackStartedAt,
  }
}

const writeServerStackLock = async (metadata: ServerStackLockMetadata, flag: 'w' | 'wx') => {
  await mkdir(dirname(serverStackLockPath), {recursive: true})
  const payload = JSON.stringify(metadata, null, 2)

  if (flag === 'wx') {
    await writeFile(serverStackLockPath, payload, {flag})
    return
  }

  const temporaryPath = `${serverStackLockPath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporaryPath, payload, {flag: 'wx'})
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
      throw error
    }

    await unlink(temporaryPath).catch(() => {})
    await writeFile(temporaryPath, payload, {flag: 'wx'})
  }
  try {
    await rename(temporaryPath, serverStackLockPath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

const refreshServerStackLock = async () => {
  if (managedServerState.shuttingDown) {
    return
  }

  const currentLock = await readServerStackLock()

  if (currentLock?.pid === process.pid) {
    return
  }

  if (currentLock !== null && currentLock.pid !== process.pid && isProcessAlive(currentLock.pid)) {
    return
  }

  await writeServerStackLock(getServerStackLockMetadata(), 'w')
}

const startServerStackLockHeartbeat = () => {
  if (serverStackLockHeartbeat !== null) {
    return
  }

  serverStackLockHeartbeat = setInterval(() => {
    return void refreshServerStackLock().catch((error) => {
      console.error('[server:stack] failed to refresh supervisor lock', error)
    })
  }, serverStackLockHeartbeatIntervalMs)

  serverStackLockHeartbeat.unref?.()
}

const stopServerStackLockHeartbeat = () => {
  if (serverStackLockHeartbeat === null) {
    return
  }

  clearInterval(serverStackLockHeartbeat)
  serverStackLockHeartbeat = null
}

const getServerCommand = () => {
  return [bunExecutablePath, 'src/server/index.ts']
}

const waitFor = async (ms: number) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const waitForProcessExit = async (pid: number, deadlineMs = Date.now() + shutdownTimeoutMs): Promise<boolean> => {
  if (!isProcessAlive(pid)) {
    return true
  }

  if (Date.now() >= deadlineMs) {
    return false
  }

  await waitFor(250)
  return waitForProcessExit(pid, deadlineMs)
}

const waitForProcessIdsExit = async (pids: number[], deadlineMs = Date.now() + shutdownTimeoutMs) => {
  const uniquePids = [...new Set(pids)]

  await Promise.all(
    uniquePids.map((pid) => {
      return waitForProcessExit(pid, deadlineMs)
    }),
  )

  return uniquePids.filter((pid) => {
    return isProcessAlive(pid)
  })
}

const stopProcessTree = async ({pid, processName}: {pid: number; processName: string}) => {
  const descendantPids = getDescendantProcessIds(pid)
  const capturedPids = [...descendantPids, pid]

  killProcessIds([...descendantPids, pid], 'SIGTERM')

  const survivingPids = await waitForProcessIdsExit(capturedPids)

  if (survivingPids.length === 0) {
    return
  }

  console.error(
    `[server:stack] ${processName} pids=${survivingPids.join(',')} did not exit after SIGTERM; sending SIGKILL`,
  )

  const forcedKillPids = [...getDescendantProcessIds(pid), ...capturedPids]

  killProcessIds(forcedKillPids, 'SIGKILL')

  const forcedKillSurvivors = await waitForProcessIdsExit(forcedKillPids, Date.now() + forcedKillTimeoutMs)

  if (forcedKillSurvivors.length > 0) {
    throw new Error(`Timed out waiting for ${processName} pids=${forcedKillSurvivors.join(',')} to exit`)
  }
}

const isDuckdbOwnerReady = async (duckdbOwnerUrl: string) => {
  try {
    return await withAbortSignalTimeout(1_000, async (signal) => {
      const response = await fetch(`${duckdbOwnerUrl}${runtimeReadyPath}`, {signal})
      const body = response.ok
        ? ((await response.json().catch(() => {
            return null
          })) as {data?: {duckdbOwner?: unknown; ready?: unknown}} | null)
        : null

      return body?.data?.ready === true && body?.data?.duckdbOwner === true
    })
  } catch {
    return false
  }
}

const waitForDuckdbOwner = async (
  duckdbOwnerUrl: string,
  deadlineMs = Date.now() + maintenanceStartupTimeoutMs,
): Promise<void> => {
  return Date.now() >= deadlineMs
    ? Promise.reject(new Error(`Timed out waiting for maintenance DuckDB owner at ${duckdbOwnerUrl}`))
    : (await isDuckdbOwnerReady(duckdbOwnerUrl))
      ? Promise.resolve()
      : waitFor(duckdbOwnerPollIntervalMs).then(() => {
          return waitForDuckdbOwner(duckdbOwnerUrl, deadlineMs)
        })
}

const isServerProcessRunning = (serverProcess: ServerProcess | null): serverProcess is ServerProcess => {
  return serverProcess !== null && serverProcess.exitCode === null
}

const isManagedServerProcessAlive = (serverProcess: ServerProcess) => {
  const pid = serverProcess.pid

  return isServerProcessRunning(serverProcess) && (pid === undefined || isProcessAlive(pid))
}

const getManagedServerProcess = (role: ManagedRole) => {
  return role === 'api'
    ? managedServerState.apiProcess
    : role === 'judge'
      ? managedServerState.judgeProcess
      : managedServerState.maintenanceProcess
}

const setManagedServerProcess = (role: ManagedRole, serverProcess: ServerProcess | null) => {
  if (role === 'api') {
    managedServerState.apiProcess = serverProcess
    return
  }

  if (role === 'judge') {
    managedServerState.judgeProcess = serverProcess
    return
  }

  managedServerState.maintenanceProcess = serverProcess
}

const getBackgroundServerRole = (role: ManagedRole) => {
  return role === 'judge' ? 'judge-worker' : role === 'maintenance' ? 'maintenance-worker' : role
}

const stopExternalProcess = async ({pid, processName}: {pid: number; processName: string}) => {
  if (!isProcessAlive(pid)) {
    return
  }

  await stopProcessTree({pid, processName})
}

const removeFileIfExists = async (filePath: string) => {
  await unlink(filePath).catch((error) => {
    if (!isMissingFileError(error)) {
      throw error
    }
  })
}

const getLastExitedManagedProcess = (role: ManagedRole) => {
  return managedServerState.lastExitedProcesses[role] ?? null
}

const setLastExitedManagedProcess = (role: ManagedRole, serverProcess: ServerProcess) => {
  const pid = serverProcess.pid

  if (pid === undefined) {
    return
  }

  managedServerState.lastExitedProcesses = {
    ...managedServerState.lastExitedProcesses,
    [role]: {exitedAtMs: Date.now(), pid},
  }
}

const isLockFromExitedProcess = (
  currentLock: NonNullable<ReturnType<typeof readJudgeWorkerJournalLock>>,
  exitedProcess: ManagedProcessExitRecord | null,
) => {
  const acquiredAtMs = new Date(currentLock.metadata.acquiredAt).getTime()

  return (
    exitedProcess !== null
    && currentLock.metadata.pid === exitedProcess.pid
    && !Number.isNaN(acquiredAtMs)
    && acquiredAtMs <= exitedProcess.exitedAtMs
  )
}

const stopConflictingJudgeWorker = async (envValues: Record<string, string | undefined>) => {
  const currentLock = readJudgeWorkerJournalLock({cwd: process.cwd(), envValues})

  if (currentLock === null) {
    return
  }

  if (currentLock.ownedByCurrentHost && isLockFromExitedProcess(currentLock, getLastExitedManagedProcess('judge'))) {
    console.log(
      `[server:stack] clearing stale judge worker lock from exited pid=${currentLock.metadata.pid} journal=${currentLock.identity.journalPath}`,
    )
    await removeFileIfExists(currentLock.identity.lockPath)
    return
  }

  if (!currentLock.ownedByCurrentHost || !currentLock.processAlive) {
    return
  }

  console.log(
    `[server:stack] taking over existing judge worker pid=${currentLock.metadata.pid} journal=${currentLock.identity.journalPath}`,
  )
  await stopExternalProcess({pid: currentLock.metadata.pid, processName: 'judge worker'})
}

const stopConflictingDuckdbOwner = async (envValues: Record<string, string | undefined>) => {
  const duckdbPath = getConfiguredDuckdbPath({envValues})
  const currentLease = duckdbPath === ':memory:' ? null : await Effect.runPromise(readDuckdbOwnerLease(duckdbPath))

  if (
    currentLease === null
    || !isLockOwnedByCurrentMachine(currentLease)
    || !isDuckdbOwnerLeaseProcessAlive(currentLease)
  ) {
    return
  }

  console.log(
    `[server:stack] taking over existing DuckDB owner pid=${currentLease.pid} port=${currentLease.apiServerPort}`,
  )
  await stopExternalProcess({pid: currentLease.pid, processName: 'DuckDB owner'})
}

const startServerProcess = async (role: ManagedRole): Promise<ServerProcess> => {
  const env = getBackgroundServerEnv({baseEnv: process.env, role: getBackgroundServerRole(role)})
  const processStartedAt = new Date().toISOString()

  if (role === 'maintenance') {
    await stopConflictingDuckdbOwner(env)
  }

  if (role === 'judge') {
    await stopConflictingJudgeWorker(env)
  }

  const serverProcess = spawn(getServerCommand(), {
    cwd: process.cwd(),
    env,
    stderr: 'inherit',
    stdin: 'ignore',
    stdout: 'inherit',
  })
  managedProcessRuntimeIdentities.set(
    serverProcess,
    resolveRuntimeProcessIdentity({envValues: env, pid: serverProcess.pid, processStartedAt}),
  )

  console.log(`[server:stack] started ${role} pid=${serverProcess.pid ?? 'unknown'}`)
  return serverProcess
}

const stopServerProcess = async (serverProcess: ServerProcess | null) => {
  if (!isServerProcessRunning(serverProcess)) {
    return
  }

  const pid = serverProcess.pid

  if (pid === undefined) {
    serverProcess.kill('SIGTERM')
  } else {
    await stopProcessTree({pid, processName: 'server process'})
    return
  }

  try {
    await serverProcess.exited
  } catch {
    return
  }
}

const stopManagedServerProcess = async (role: ManagedRole, serverProcess = getManagedServerProcess(role)) => {
  if (serverProcess === null) {
    return
  }

  if (getManagedServerProcess(role) === serverProcess) {
    setManagedServerProcess(role, null)
  }

  await stopServerProcess(serverProcess)
}

const ensureManagedServerProcess = async (role: ManagedRole): Promise<ServerProcess> => {
  const currentProcess = getManagedServerProcess(role)

  if (isServerProcessRunning(currentProcess)) {
    return currentProcess
  }

  const nextProcess = await startServerProcess(role)
  setManagedServerProcess(role, nextProcess)
  void monitorManagedServerExit(role, nextProcess)
  return nextProcess
}

const ensureMaintenanceReadyAttempt = async (): Promise<void> => {
  const maintenanceProcess = await ensureManagedServerProcess('maintenance')

  try {
    return await waitForDuckdbOwner(config.duckdbOwnerUrl)
  } catch (error) {
    console.error('[server:stack] maintenance worker did not become ready; restarting', error)
    await stopManagedServerProcess('maintenance', maintenanceProcess)
    await waitFor(restartDelayMs)
    return ensureMaintenanceReadyAttempt()
  }
}

const ensureMaintenanceReady = () => {
  if (managedServerState.maintenanceReadyPromise) {
    return managedServerState.maintenanceReadyPromise
  }

  managedServerState.maintenanceReadyPromise = ensureMaintenanceReadyAttempt().finally(() => {
    managedServerState.maintenanceReadyPromise = null
  })

  return managedServerState.maintenanceReadyPromise
}

const ensureApiReadyAttempt = async (): Promise<void> => {
  await ensureMaintenanceReady()
  await ensureManagedServerProcess('api')
}

const ensureApiReady = () => {
  if (managedServerState.apiReadyPromise) {
    return managedServerState.apiReadyPromise
  }

  managedServerState.apiReadyPromise = ensureApiReadyAttempt().finally(() => {
    managedServerState.apiReadyPromise = null
  })

  return managedServerState.apiReadyPromise
}

const getJudgeRuntimeReadyUrl = () => {
  return `http://127.0.0.1:${config.judgePort}/api/runtime/ready`
}

const probeJudgeRuntimeReady = async (): Promise<{body: JudgeRuntimeReadyBody | null; responseOk: boolean}> => {
  try {
    return await withAbortSignalTimeout(1_000, async (signal) => {
      const response = await fetch(getJudgeRuntimeReadyUrl(), {signal})
      const body = response.ok
        ? ((await response.json().catch(() => {
            return null
          })) as JudgeRuntimeReadyBody | null)
        : null

      return {body, responseOk: response.ok}
    })
  } catch {
    return {body: null, responseOk: false}
  }
}

const isJudgeReady = async () => {
  const probe = await probeJudgeRuntimeReady()

  return isJudgeWatchdogResponseHealthy(probe) && probe.body?.data?.ready === true
}

const isJudgeLocallyHealthy = async () => {
  return isJudgeWatchdogResponseHealthy(await probeJudgeRuntimeReady())
}

const waitForJudgeReady = async (deadlineMs = Date.now() + judgeStartupTimeoutMs): Promise<void> => {
  return Date.now() >= deadlineMs
    ? Promise.reject(new Error(`Timed out waiting for judge-worker readiness at ${getJudgeRuntimeReadyUrl()}`))
    : (await isJudgeReady())
      ? Promise.resolve()
      : waitFor(duckdbOwnerPollIntervalMs).then(() => {
          return waitForJudgeReady(deadlineMs)
        })
}

const shouldSkipRestartForReadyReplacement = async (role: ManagedRole, exitCode: number | null) => {
  if (role !== 'judge' || exitCode !== 143) {
    return false
  }

  if (!(await isJudgeReady())) {
    return false
  }

  console.error('[server:stack] judge replacement is already ready after SIGTERM; not restarting duplicate')
  return true
}

const ensureJudgeReadyAttempt = async (): Promise<void> => {
  await ensureMaintenanceReady()
  const judgeProcess = await ensureManagedServerProcess('judge')

  try {
    return await waitForJudgeReady()
  } catch (error) {
    console.error('[server:stack] judge worker did not become ready; restarting', error)
    await stopManagedServerProcess('judge', judgeProcess)
    await waitFor(restartDelayMs)
    return ensureJudgeReadyAttempt()
  }
}

const ensureJudgeReady = () => {
  if (managedServerState.judgeReadyPromise) {
    return managedServerState.judgeReadyPromise
  }

  managedServerState.judgeReadyPromise = ensureJudgeReadyAttempt().finally(() => {
    managedServerState.judgeReadyPromise = null
  })

  return managedServerState.judgeReadyPromise
}

const writeJudgeHealthWatchdogRestartEvent = ({
  consecutiveFailureCount,
  processAlive,
  serverProcess,
}: {
  consecutiveFailureCount: number
  processAlive: boolean
  serverProcess: ServerProcess
}) => {
  const pid = serverProcess.pid ?? null
  const reason = processAlive ? 'health checks failed' : 'process is no longer alive'
  const message = `[server:stack] judge pid=${pid ?? 'unknown'} ${reason}; watchdog restart planned`

  console.error(message)

  try {
    writeRuntimeLogEvent({
      attrs: {consecutiveFailureCount, pid, processAlive, restartPlanned: true, role: 'judge'},
      event: 'server.stack.managed-process-watchdog-restart',
      message,
      runtimeIdentity: managedProcessRuntimeIdentities.get(serverProcess),
      serverRole: 'judge-worker',
      severity: 'ERROR',
    })
  } catch (error) {
    console.error('[server:stack] failed to write judge watchdog restart to runtime log', error)
  }
}

const restartJudgeFromHealthWatchdog = async ({
  consecutiveFailureCount,
  processAlive,
  serverProcess,
}: {
  consecutiveFailureCount: number
  processAlive: boolean
  serverProcess: ServerProcess
}) => {
  if (managedServerState.shuttingDown || getManagedServerProcess('judge') !== serverProcess) {
    return
  }

  writeJudgeHealthWatchdogRestartEvent({consecutiveFailureCount, processAlive, serverProcess})
  setLastExitedManagedProcess('judge', serverProcess)
  await stopManagedServerProcess('judge', serverProcess)
  await waitFor(restartDelayMs)

  if (!managedServerState.shuttingDown) {
    await ensureJudgeReady()
  }
}

const runJudgeHealthWatchdogCheck = async () => {
  if (managedServerState.shuttingDown || managedServerState.judgeReadyPromise !== null) {
    return
  }

  const serverProcess = getManagedServerProcess('judge')

  if (serverProcess === null) {
    judgeHealthWatchdogFailureCount = 0
    await ensureJudgeReady()
    return
  }

  const processAlive = isManagedServerProcessAlive(serverProcess)
  const healthy = processAlive ? await isJudgeLocallyHealthy() : false

  if (managedServerState.shuttingDown || getManagedServerProcess('judge') !== serverProcess) {
    return
  }

  const watchdogState = getNextJudgeWatchdogState({
    consecutiveFailureCount: judgeHealthWatchdogFailureCount,
    healthy,
    processAlive,
    restartThreshold: judgeHealthWatchdogFailureThreshold,
  })
  judgeHealthWatchdogFailureCount = watchdogState.consecutiveFailureCount

  if (!watchdogState.shouldRestart) {
    return
  }

  judgeHealthWatchdogFailureCount = 0
  await restartJudgeFromHealthWatchdog({
    consecutiveFailureCount: watchdogState.consecutiveFailureCount,
    processAlive,
    serverProcess,
  })
}

const triggerJudgeHealthWatchdogCheck = () => {
  if (judgeHealthWatchdogCheck !== null || managedServerState.shuttingDown) {
    return
  }

  judgeHealthWatchdogCheck = runJudgeHealthWatchdogCheck()
    .catch((error) => {
      console.error('[server:stack] judge health watchdog failed', error)
    })
    .finally(() => {
      judgeHealthWatchdogCheck = null
    })
}

const startJudgeHealthWatchdog = () => {
  if (judgeHealthWatchdog !== null) {
    return
  }

  judgeHealthWatchdog = setInterval(triggerJudgeHealthWatchdogCheck, judgeHealthWatchdogIntervalMs)
  judgeHealthWatchdog.unref?.()
}

const stopJudgeHealthWatchdog = () => {
  if (judgeHealthWatchdog === null) {
    return
  }

  clearInterval(judgeHealthWatchdog)
  judgeHealthWatchdog = null
}

const monitorManagedServerExit = async (role: ManagedRole, serverProcess: ServerProcess): Promise<void> => {
  const exitCode = await serverProcess.exited.catch(() => {
    return null
  })

  if (managedServerState.shuttingDown || getManagedServerProcess(role) !== serverProcess) {
    return
  }

  setLastExitedManagedProcess(role, serverProcess)
  setManagedServerProcess(role, null)
  const pid = serverProcess.pid ?? null
  const signal = serverProcess.signalCode
  const message = `[server:stack] ${role} pid=${pid ?? 'unknown'} exited unexpectedly with code ${String(exitCode)} signal=${signal ?? 'none'}; restart planned`

  console.error(message)

  try {
    writeRuntimeLogEvent({
      attrs: {exitCode, pid, restartPlanned: true, role, signal, supervisorPid: process.pid},
      event: 'server.stack.managed-process-unexpected-exit',
      message,
      runtimeIdentity: managedProcessRuntimeIdentities.get(serverProcess),
      serverRole: getBackgroundServerRole(role),
      severity: 'ERROR',
    })
  } catch (error) {
    console.error('[server:stack] failed to write managed process exit to runtime log', error)
  }

  await waitFor(restartDelayMs)

  if (managedServerState.shuttingDown) {
    return
  }

  if (await shouldSkipRestartForReadyReplacement(role, exitCode)) {
    return
  }

  if (managedServerState.shuttingDown) {
    return
  }

  console.error(`[server:stack] restarting ${role}`)

  return role === 'maintenance'
    ? ensureMaintenanceReady().then(() => {
        return Promise.all([ensureApiReady(), ensureJudgeReady()]).then(() => {
          return undefined
        })
      })
    : role === 'judge'
      ? ensureJudgeReady()
      : ensureApiReady()
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
    if (managedServerState.shuttingDown || !shouldShutdownForParentExit()) {
      return
    }

    console.error(`[server:stack] parent pid=${parentPid} exited; shutting down`)
    void shutdown(0)
  }, parentMonitorIntervalMs)

  parentMonitor.unref?.()
}

const shutdown = async (exitCode = 0) => {
  if (managedServerState.shuttingDown) {
    return
  }

  managedServerState.shuttingDown = true
  stopParentMonitor()
  stopServerStackLockHeartbeat()
  stopJudgeHealthWatchdog()
  await Promise.all([
    stopManagedServerProcess('api'),
    stopManagedServerProcess('judge'),
    stopManagedServerProcess('maintenance'),
  ])
  await releaseServerStackLock()
  process.exit(exitCode)
}

process.on('SIGINT', () => {
  void shutdown(0)
})

process.on('SIGTERM', () => {
  void shutdown(0)
})

startParentMonitor()

try {
  await acquireServerStackLock()
  startServerStackLockHeartbeat()
  await ensureMaintenanceReady()
  await Promise.all([ensureApiReady(), ensureJudgeReady()])
  startJudgeHealthWatchdog()
  await new Promise(() => {})
} catch (error) {
  console.error('[server:stack] failed to start', error)
  await shutdown(1)
}
