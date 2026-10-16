import {realpathSync} from 'node:fs'

import {shouldUseProcessStopRequests, startProcessStopRequestWatcher} from '../src/server/utils/processStopRequest.ts'
import {getDevStartShutdownTimeoutMs} from './serverStackShutdown.ts'
import {getLiveStopChildProcessDependencies, stopChildProcess} from './stopChildProcess.ts'

const bunExecutablePath = realpathSync(process.execPath)

export const devStartCommands = [
  {
    command: [bunExecutablePath, 'scripts/runWithRuntimeProfile.ts', '--profile', 'primary', '--mode', 'app'],
    name: 'app',
    stdin: 'ignore',
  },
  {
    command: [
      bunExecutablePath,
      'scripts/runWithRuntimeProfile.ts',
      '--profile',
      'primary',
      '--mode',
      'stacked-server',
    ],
    name: 'api',
    stdin: 'inherit',
  },
] as const

type DevStartCommand = (typeof devStartCommands)[number]
type DevStartProcess = {childProcess: ReturnType<typeof globalThis.Bun.spawn>; name: DevStartCommand['name']}

const activeProcesses: DevStartProcess[] = []
let shuttingDown = false

const startDevProcess = (commandConfig: DevStartCommand) => {
  const childProcess = globalThis.Bun.spawn([...commandConfig.command], {
    cwd: process.cwd(),
    env: {...process.env},
    stderr: 'inherit',
    stdin: commandConfig.stdin,
    stdout: 'inherit',
  })

  console.log(`[dev:start] started ${commandConfig.name} pid=${childProcess.pid ?? 'unknown'}`)

  return {childProcess, name: commandConfig.name}
}

const logDevStartMessage = (message: string) => {
  console.error(`[dev:start] ${message}`)
}

const stopDevProcess = async ({childProcess, name}: DevStartProcess) => {
  await stopChildProcess(getLiveStopChildProcessDependencies(logDevStartMessage), childProcess, {
    childName: name,
    signal: 'SIGTERM',
    timeoutMs: getDevStartShutdownTimeoutMs(process.env),
  })
}

const stopDevProcesses = async () => {
  await Promise.all(activeProcesses.map(stopDevProcess))
}

const shutdown = async (exitCode = 0) => {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  await stopDevProcesses()
  process.exit(exitCode)
}

const getExitCode = async ({childProcess}: DevStartProcess) => {
  return childProcess.exited.catch(() => {
    return 1
  })
}

const monitorDevProcess = async (devProcess: DevStartProcess) => {
  const exitCode = await getExitCode(devProcess)

  if (shuttingDown) {
    return
  }

  console.error(`[dev:start] ${devProcess.name} exited with code ${exitCode}`)
  await shutdown(exitCode)
}

export const runDevStart = async () => {
  process.once('SIGINT', () => {
    void shutdown(0)
  })

  process.once('SIGTERM', () => {
    void shutdown(0)
  })

  if (shouldUseProcessStopRequests()) {
    startProcessStopRequestWatcher({
      onStopRequest: () => {
        void shutdown(0)
      },
    })
  }

  activeProcesses.push(...devStartCommands.map(startDevProcess))
  await Promise.all(activeProcesses.map(monitorDevProcess))
}

if (import.meta.main) {
  await runDevStart()
}
