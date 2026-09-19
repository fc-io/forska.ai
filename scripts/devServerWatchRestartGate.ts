export type DevServerWatchRestartGateDependencies = {
  isMaintenanceReady: () => Promise<boolean>
  isStackAlive: () => boolean
  log: (message: string) => void
  now: () => number
  wait: (ms: number) => Promise<void>
}

export type DevServerWatchRestartGateOptions = {pollIntervalMs: number; timeoutMs: number}

export type DevServerWatchRestartGateResult = 'ready' | 'stack-gone' | 'timed-out'

const getRestartGateWaitingMessage = (timeoutMs: number) => {
  return (
    'server stack is still starting; waiting for the maintenance worker to become ready before restarting '
    + `so DuckDB startup preflight and repairs are not interrupted (up to ${Math.round(timeoutMs / 1_000)}s)`
  )
}

const pollDevServerWatchRestartGate = async (
  dependencies: DevServerWatchRestartGateDependencies,
  options: DevServerWatchRestartGateOptions,
  deadlineMs: number,
): Promise<DevServerWatchRestartGateResult> => {
  if (!dependencies.isStackAlive()) {
    return 'stack-gone'
  }

  if (await dependencies.isMaintenanceReady()) {
    return 'ready'
  }

  if (dependencies.now() >= deadlineMs) {
    dependencies.log('server stack did not become ready in time; restarting anyway')
    return 'timed-out'
  }

  await dependencies.wait(options.pollIntervalMs)

  return pollDevServerWatchRestartGate(dependencies, options, deadlineMs)
}

export const waitForDevServerWatchRestartGate = async (
  dependencies: DevServerWatchRestartGateDependencies,
  options: DevServerWatchRestartGateOptions,
): Promise<DevServerWatchRestartGateResult> => {
  if (!dependencies.isStackAlive()) {
    return 'stack-gone'
  }

  if (await dependencies.isMaintenanceReady()) {
    return 'ready'
  }

  dependencies.log(getRestartGateWaitingMessage(options.timeoutMs))

  return pollDevServerWatchRestartGate(dependencies, options, dependencies.now() + options.timeoutMs)
}
