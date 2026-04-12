import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {spawn, type Subprocess} from 'bun'

import {
  getBackgroundServerEnvAsync,
  getBackgroundServerStackConfigAsync,
} from '../src/server/utils/backgroundServerStack.ts'

type ManagedRole = 'api' | 'worker'
type ServerProcess = Subprocess<'ignore', 'inherit', 'inherit'>
type ServerStackLockMetadata = {apiPort: number; cwd: string; pid: number; startedAt: string; workerPort: number}

type ManagedServerState = {
  apiProcess: ServerProcess | null
  apiReadyPromise: Promise<void> | null
  shuttingDown: boolean
  workerProcess: ServerProcess | null
  workerReadyPromise: Promise<void> | null
}

const restartDelayMs = 1_000
const startupTimeoutMs = 20_000
const shutdownTimeoutMs = 20_000
const forcedKillTimeoutMs = 5_000
const writerPollIntervalMs = 250

const config = await getBackgroundServerStackConfigAsync(process.env)
const serverStackLockPath = join(tmpdir(), 'forska-server-stack', `${config.apiPort}-${config.workerPort}.lock.json`)

if (config.apiPort === config.workerPort) {
  throw new Error(`API port ${config.apiPort} must differ from background writer port ${config.workerPort}`)
}

console.log(
  `[server:stack] api_port=${config.apiPort} worker_port=${config.workerPort} worker_duckdb_memory_limit=${config.workerDuckdbMemoryLimit}`,
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
    pid: process.pid,
    startedAt: new Date().toISOString(),
    workerPort: config.workerPort,
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
      `Another server stack is already running for ports ${config.apiPort}/${config.workerPort} (pid=${currentLock.pid}, startedAt=${currentLock.startedAt}). Stop it before starting a new one.`,
      {cause: error},
    )
  }
}

const managedServerState: ManagedServerState = {
  apiProcess: null,
  apiReadyPromise: null,
  shuttingDown: false,
  workerProcess: null,
  workerReadyPromise: null,
}

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

const isWriterReady = async (writerUrl: string) => {
  try {
    const response = await fetch(`${writerUrl}/api/writer_connections`, {signal: AbortSignal.timeout(1_000)})
    return response.ok
  } catch {
    return false
  }
}

const waitForWriter = async (writerUrl: string, deadlineMs = Date.now() + startupTimeoutMs): Promise<void> => {
  return Date.now() >= deadlineMs
    ? Promise.reject(new Error(`Timed out waiting for background writer at ${writerUrl}`))
    : (await isWriterReady(writerUrl))
      ? Promise.resolve()
      : waitFor(writerPollIntervalMs).then(() => {
          return waitForWriter(writerUrl, deadlineMs)
        })
}

const isServerProcessRunning = (serverProcess: ServerProcess | null): serverProcess is ServerProcess => {
  return serverProcess !== null && serverProcess.exitCode === null
}

const getManagedServerProcess = (role: ManagedRole) => {
  return role === 'api' ? managedServerState.apiProcess : managedServerState.workerProcess
}

const setManagedServerProcess = (role: ManagedRole, serverProcess: ServerProcess | null) => {
  if (role === 'api') {
    managedServerState.apiProcess = serverProcess
    return
  }

  managedServerState.workerProcess = serverProcess
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

const ensureWorkerReadyAttempt = async (): Promise<void> => {
  const workerProcess = await ensureManagedServerProcess('worker')

  try {
    return await waitForWriter(config.writerUrl)
  } catch (error) {
    console.error('[server:stack] worker did not become ready; restarting', error)
    await stopManagedServerProcess('worker', workerProcess)
    await waitFor(restartDelayMs)
    return ensureWorkerReadyAttempt()
  }
}

const ensureWorkerReady = () => {
  if (managedServerState.workerReadyPromise) {
    return managedServerState.workerReadyPromise
  }

  managedServerState.workerReadyPromise = ensureWorkerReadyAttempt().finally(() => {
    managedServerState.workerReadyPromise = null
  })

  return managedServerState.workerReadyPromise
}

const ensureApiReadyAttempt = async (): Promise<void> => {
  await ensureWorkerReady()
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

  return role === 'worker'
    ? ensureWorkerReady().then(() => {
        return ensureApiReady()
      })
    : ensureApiReady()
}

const shutdown = async (exitCode = 0) => {
  if (managedServerState.shuttingDown) {
    return
  }

  managedServerState.shuttingDown = true
  await Promise.all([stopManagedServerProcess('api'), stopManagedServerProcess('worker')])
  await releaseServerStackLock()
  process.exit(exitCode)
}

process.on('SIGINT', () => {
  void shutdown(0)
})

process.on('SIGTERM', () => {
  void shutdown(0)
})

try {
  await acquireServerStackLock()
  await ensureWorkerReady()
  await ensureApiReady()
  await new Promise(() => {})
} catch (error) {
  console.error('[server:stack] failed to start', error)
  await shutdown(1)
}
