import {spawn, type Subprocess} from 'bun'

import {getBackgroundServerEnv, getBackgroundServerStackConfig} from '../src/server/utils/backgroundServerStack.ts'

type ManagedRole = 'api' | 'worker'
type ServerProcess = Subprocess<'ignore', 'inherit', 'inherit'>

const startupTimeoutMs = 20_000
const writerPollIntervalMs = 250

const getServerCommand = () => {
  return ['bun', 'run', 'src/server/index.ts']
}

const startServerProcess = (role: ManagedRole): ServerProcess => {
  return spawn(getServerCommand(), {
    cwd: process.cwd(),
    env: getBackgroundServerEnv({baseEnv: process.env, role}),
    stderr: 'inherit',
    stdin: 'ignore',
    stdout: 'inherit',
  })
}

const waitFor = async (ms: number) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const isWriterReady = async (writerUrl: string) => {
  try {
    const response = await fetch(`${writerUrl}/api/writer_connections`, {signal: AbortSignal.timeout(1_000)})
    return response.ok
  } catch {
    return false
  }
}

const waitForWriter = async (writerUrl: string) => {
  const deadlineMs = Date.now() + startupTimeoutMs

  while (Date.now() < deadlineMs) {
    if (await isWriterReady(writerUrl)) {
      return
    }

    await waitFor(writerPollIntervalMs)
  }

  throw new Error(`Timed out waiting for background writer at ${writerUrl}`)
}

const stopServerProcess = async (serverProcess: ServerProcess | null) => {
  if (serverProcess === null || serverProcess.exitCode !== null) {
    return
  }

  serverProcess.kill('SIGTERM')

  try {
    await serverProcess.exited
  } catch {
    return
  }
}

const config = getBackgroundServerStackConfig(process.env)

if (config.apiPort === config.workerPort) {
  throw new Error(`API port ${config.apiPort} must differ from background writer port ${config.workerPort}`)
}

console.log(`[server:stack] api_port=${config.apiPort} worker_port=${config.workerPort}`)

let workerProcess: ServerProcess | null = null
let apiProcess: ServerProcess | null = null
let shuttingDown = false

const shutdown = async (exitCode = 0) => {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  await Promise.all([stopServerProcess(apiProcess), stopServerProcess(workerProcess)])
  process.exit(exitCode)
}

process.on('SIGINT', () => {
  void shutdown(0)
})

process.on('SIGTERM', () => {
  void shutdown(0)
})

try {
  workerProcess = startServerProcess('worker')
  await waitForWriter(config.writerUrl)
  apiProcess = startServerProcess('api')

  const firstExit = await Promise.race([
    workerProcess.exited.then((exitCode) => {
      return {exitCode, role: 'worker' as const}
    }),
    apiProcess.exited.then((exitCode) => {
      return {exitCode, role: 'api' as const}
    }),
  ])

  if (!shuttingDown) {
    console.error(`[server:stack] ${firstExit.role} exited with code ${String(firstExit.exitCode)}`)
  }

  await shutdown(firstExit.exitCode ?? 1)
} catch (error) {
  console.error('[server:stack] failed to start', error)
  await shutdown(1)
}
