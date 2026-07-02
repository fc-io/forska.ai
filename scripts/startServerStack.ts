import {realpathSync} from 'node:fs'
import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {spawn, type Subprocess} from 'bun'
import {Effect} from 'effect'

import {getBackgroundServerEnv, getBackgroundServerStackConfig} from '../src/server/utils/backgroundServerStack.ts'
import {isDuckdbOwnerLeaseProcessAlive, readDuckdbOwnerLease} from '../src/server/utils/duckdbOwnerLease.ts'
import {getConfiguredDuckdbPath} from '../src/server/utils/getDuckdbPath.ts'
import {readJudgeWorkerJournalLock} from '../src/server/utils/judgeWorkerJournalIdentity.ts'
import {isLockOwnedByCurrentMachine} from '../src/server/utils/localMachineIdentity.ts'
import {runtimeReadyPath} from '../src/server/utils/runtimeReadyContract.ts'

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
const maintenanceStartupTimeoutMs = 180_000
const judgeStartupTimeoutMs = 90_000
const shutdownTimeoutMs = 20_000
const forcedKillTimeoutMs = 5_000
const duckdbOwnerPollIntervalMs = 250
const parentMonitorIntervalMs = 1_000
const serverStackLockHeartbeatIntervalMs = 1_000

const config = getBackgroundServerStackConfig(process.env)
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

const readServerStackLock = async () => {
  try {
    return JSON.parse(await readFile(serverStackLockPath, 'utf8')) as ServerStackLockMetadata
  } catch (error) {
    return isMissingFileError(error) ? null : Promise.reject(error)
  }
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

    const currentLock = await readServerStackLock()

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

const parentPid = process.ppid
const bunExecutablePath = realpathSync(process.execPath)
const serverStackStartedAt = new Date().toISOString()

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
  await writeFile(serverStackLockPath, JSON.stringify(metadata, null, 2), {flag})
}

const refreshServerStackLock = async () => {
  if (managedServerState.shuttingDown) {
    return
  }

  const currentLock = await readServerStackLock()

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

const isDuckdbOwnerReady = async (duckdbOwnerUrl: string) => {
  try {
    const response = await fetch(`${duckdbOwnerUrl}${runtimeReadyPath}`, {signal: AbortSignal.timeout(1_000)})
    const body = response.ok
      ? ((await response.json().catch(() => {
          return null
        })) as {data?: {duckdbOwner?: unknown; ready?: unknown}} | null)
      : null

    return body?.data?.ready === true && body?.data?.duckdbOwner === true
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

  process.kill(pid, 'SIGTERM')

  if (await waitForProcessExit(pid)) {
    return
  }

  console.error(`[server:stack] ${processName} pid=${pid} did not exit after SIGTERM; sending SIGKILL`)

  if (isProcessAlive(pid)) {
    process.kill(pid, 'SIGKILL')
  }

  if (await waitForProcessExit(pid, Date.now() + forcedKillTimeoutMs)) {
    return
  }

  throw new Error(`Timed out waiting for ${processName} pid=${pid} to exit`)
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
    || currentLease.apiServerPort !== config.maintenancePort
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

  console.log(`[server:stack] started ${role} pid=${serverProcess.pid ?? 'unknown'}`)
  return serverProcess
}

const stopServerProcess = async (serverProcess: ServerProcess | null) => {
  if (!isServerProcessRunning(serverProcess)) {
    return
  }

  const pid = serverProcess.pid

  serverProcess.kill('SIGTERM')

  if (pid !== undefined && !(await waitForProcessExit(pid))) {
    console.error(`[server:stack] pid=${pid} did not exit after SIGTERM; sending SIGKILL`)

    if (isProcessAlive(pid)) {
      serverProcess.kill('SIGKILL')
    }

    if (!(await waitForProcessExit(pid, Date.now() + forcedKillTimeoutMs))) {
      throw new Error(`Timed out waiting for pid=${pid} to exit`)
    }
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

const isJudgeReady = async () => {
  try {
    const response = await fetch(getJudgeRuntimeReadyUrl(), {signal: AbortSignal.timeout(1_000)})
    return response.ok
  } catch {
    return false
  }
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

const monitorManagedServerExit = async (role: ManagedRole, serverProcess: ServerProcess): Promise<void> => {
  const exitCode = await serverProcess.exited.catch(() => {
    return null
  })

  if (managedServerState.shuttingDown || getManagedServerProcess(role) !== serverProcess) {
    return
  }

  setLastExitedManagedProcess(role, serverProcess)
  setManagedServerProcess(role, null)
  console.error(`[server:stack] ${role} pid=${serverProcess.pid ?? 'unknown'} exited with code ${String(exitCode)}`)
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
  await new Promise(() => {})
} catch (error) {
  console.error('[server:stack] failed to start', error)
  await shutdown(1)
}
