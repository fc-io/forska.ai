import {
  removeProcessStopRequest,
  shouldUseProcessStopRequests,
  writeProcessStopRequest,
} from '../src/server/utils/processStopRequest.ts'

export type StopChildProcessSignal = 'SIGINT' | 'SIGKILL' | 'SIGTERM'

export type StoppableChildProcess = {
  exitCode: number | null
  exited: Promise<number>
  kill: (signal?: StopChildProcessSignal) => void
  pid?: number
}

export type StopChildProcessDependencies = {
  clearStopRequest: (pid: number) => void
  log: (message: string) => void
  platform: string
  requestStop: (pid: number, reason: string) => void
  wait: (ms: number) => Promise<void>
}

export type StopChildProcessOptions = {childName: string; signal: StopChildProcessSignal; timeoutMs: number}

export type StopChildProcessResult = 'already-exited' | 'exited' | 'killed' | 'signalled'

const waitForUnrefTimer = async (ms: number) => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

export const getLiveStopChildProcessDependencies = (log: (message: string) => void): StopChildProcessDependencies => {
  return {
    clearStopRequest: (pid) => {
      removeProcessStopRequest(pid)
    },
    log,
    platform: process.platform,
    requestStop: (pid, reason) => {
      writeProcessStopRequest({pid, reason})
    },
    wait: waitForUnrefTimer,
  }
}

const waitForChildExit = async (childProcess: StoppableChildProcess) => {
  await childProcess.exited.catch(() => {
    return null
  })
}

const signalChildProcess = async (
  childProcess: StoppableChildProcess,
  options: StopChildProcessOptions,
): Promise<StopChildProcessResult> => {
  childProcess.kill(options.signal)
  await waitForChildExit(childProcess)
  return 'signalled'
}

const requestChildProcessStop = (
  dependencies: StopChildProcessDependencies,
  childProcess: StoppableChildProcess,
  options: StopChildProcessOptions,
) => {
  if (childProcess.pid === undefined) {
    return
  }

  try {
    dependencies.requestStop(childProcess.pid, `${options.signal} to ${options.childName}`)
  } catch (error) {
    dependencies.log(
      `${options.childName} pid=${childProcess.pid} could not receive a stop request: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const killChildProcessAfterTimeout = async (
  dependencies: StopChildProcessDependencies,
  childProcess: StoppableChildProcess,
  options: StopChildProcessOptions,
): Promise<StopChildProcessResult> => {
  dependencies.log(
    `${options.childName} pid=${childProcess.pid ?? 'unknown'} did not exit within ${options.timeoutMs}ms; terminating it`,
  )
  childProcess.kill('SIGKILL')
  await waitForChildExit(childProcess)
  return 'killed'
}

const waitForChildExitOrTimeout = async (
  dependencies: StopChildProcessDependencies,
  childProcess: StoppableChildProcess,
  timeoutMs: number,
) => {
  return Promise.race([
    waitForChildExit(childProcess).then(() => {
      return true
    }),
    dependencies.wait(timeoutMs).then(() => {
      return childProcess.exitCode !== null
    }),
  ])
}

const stopChildProcessWithStopRequest = async (
  dependencies: StopChildProcessDependencies,
  childProcess: StoppableChildProcess,
  options: StopChildProcessOptions,
): Promise<StopChildProcessResult> => {
  requestChildProcessStop(dependencies, childProcess, options)

  try {
    return (await waitForChildExitOrTimeout(dependencies, childProcess, options.timeoutMs))
      ? 'exited'
      : await killChildProcessAfterTimeout(dependencies, childProcess, options)
  } finally {
    if (childProcess.pid !== undefined) {
      dependencies.clearStopRequest(childProcess.pid)
    }
  }
}

export const stopChildProcess = async (
  dependencies: StopChildProcessDependencies,
  childProcess: StoppableChildProcess,
  options: StopChildProcessOptions,
): Promise<StopChildProcessResult> => {
  if (childProcess.exitCode !== null) {
    await waitForChildExit(childProcess)
    return 'already-exited'
  }

  return shouldUseProcessStopRequests(dependencies.platform)
    ? stopChildProcessWithStopRequest(dependencies, childProcess, options)
    : signalChildProcess(childProcess, options)
}
