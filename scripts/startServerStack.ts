import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {spawn, type Subprocess} from 'bun'

import {
  getBackgroundServerEnvAsync,
  getBackgroundServerStackConfigAsync,
} from '../src/server/utils/backgroundServerStack.ts'

type ManagedRole = 'api' | 'maintenance'
type ServerProcess = Subprocess<'ignore', 'inherit', 'inherit'>
type ServerStackLockMetadata = {apiPort: number; cwd: string; maintenancePort: number; pid: number; startedAt: string}

type ManagedServerState = {
  apiProcess: ServerProcess | null
  apiReadyPromise: Promise<void> | null
  shuttingDown: boolean
  maintenanceProcess: ServerProcess | null
  maintenanceReadyPromise: Promise<void> | null
}

const restartDelayMs = 1_000
const startupTimeoutMs = 20_000
const shutdownTimeoutMs = 20_000
const forcedKillTimeoutMs = 5_000
const duckdbOwnerPollIntervalMs = 250
const parentMonitorIntervalMs = 1_000

const config = await getBackgroundServerStackConfigAsync(process.env)
const serverStackLockPath = join(
  tmpdir(),
  'forska-server-stack',
  `${config.apiPort}-${config.maintenancePort}.lock.json`,
)

if (config.apiPort === config.maintenancePort) {
  throw new Error(`API port ${config.apiPort} must differ from maintenance-worker port ${config.maintenancePort}`)
}

console.log(
  `[server:stack] api_port=${config.apiPort} maintenance_port=${config.maintenancePort} maintenance_duckdb_memory_limit=${config.maintenanceDuckdbMemoryLimit}`,
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
  const metadata = {
    apiPort: config.apiPort,
    cwd: process.cwd(),
    maintenancePort: config.maintenancePort,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  } satisfies ServerStackLockMetadata

  try {
    await mkdir(dirname(serverStackLockPath), {recursive: true})
    await writeFile(serverStackLockPath, JSON.stringify(metadata, null, 2), {flag: 'wx'})
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
  maintenanceProcess: null,
  maintenanceReadyPromise: null,
  shuttingDown: false,
}

let parentMonitor: ReturnType<typeof setInterval> | null = null

const parentPid = process.ppid

const getServerCommand = () => {
  return ['bun', 'run', 'src/server/index.ts']
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
    const response = await fetch(`${duckdbOwnerUrl}/api/duckdb_owner_connections`, {
      signal: AbortSignal.timeout(1_000),
    })
    return response.ok
  } catch {
    return false
  }
}

const waitForDuckdbOwner = async (
  duckdbOwnerUrl: string,
  deadlineMs = Date.now() + startupTimeoutMs,
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
  return role === 'api' ? managedServerState.apiProcess : managedServerState.maintenanceProcess
}

const setManagedServerProcess = (role: ManagedRole, serverProcess: ServerProcess | null) => {
  if (role === 'api') {
    managedServerState.apiProcess = serverProcess
    return
  }

  managedServerState.maintenanceProcess = serverProcess
}

const startServerProcess = async (role: ManagedRole): Promise<ServerProcess> => {
  const serverProcess = spawn(getServerCommand(), {
    cwd: process.cwd(),
    env: await getBackgroundServerEnvAsync({baseEnv: process.env, role}),
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

const monitorManagedServerExit = async (role: ManagedRole, serverProcess: ServerProcess): Promise<void> => {
  const exitCode = await serverProcess.exited.catch(() => {
    return null
  })

  if (managedServerState.shuttingDown || getManagedServerProcess(role) !== serverProcess) {
    return
  }

  setManagedServerProcess(role, null)
  console.error(`[server:stack] ${role} exited with code ${String(exitCode)}; restarting`)
  await waitFor(restartDelayMs)

  return role === 'maintenance'
    ? ensureMaintenanceReady().then(() => {
        return ensureApiReady()
      })
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
  await Promise.all([stopManagedServerProcess('api'), stopManagedServerProcess('maintenance')])
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
  await ensureMaintenanceReady()
  await ensureApiReady()
  await new Promise(() => {})
} catch (error) {
  console.error('[server:stack] failed to start', error)
  await shutdown(1)
}
