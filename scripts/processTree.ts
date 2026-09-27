import {spawnSync} from 'bun'

export type ProcessTreeSignal = 'SIGKILL' | 'SIGTERM'

export type ProcessTreeDependencies = {
  getDescendantProcessIds: (pid: number) => number[]
  isProcessAlive: (pid: number) => boolean
  killProcessIds: (pids: number[], signal: ProcessTreeSignal) => void
  log: (message: string) => void
  now: () => number
  wait: (ms: number) => Promise<void>
}

export type StopProcessTreeOptions = {
  forcedKillTimeoutMs: number
  pid: number
  pollIntervalMs?: number
  processName: string
  shutdownTimeoutMs: number
}

export type StopProcessTreeResult = 'exited' | 'killed'

const defaultProcessTreePollIntervalMs = 250

const isMissingFileError = (error: unknown) => {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export const isProcessAlive = (pid: number) => {
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

  return (result.stdout?.toString() ?? '')
    .split(/\s+/u)
    .map((value) => {
      return Number(value)
    })
    .filter((value) => {
      return Number.isInteger(value) && value > 0
    })
}

export const getDescendantProcessIds = (pid: number): number[] => {
  const childPids = getChildProcessIds(pid)

  return childPids.flatMap((childPid) => {
    return [childPid, ...getDescendantProcessIds(childPid)]
  })
}

export const killProcessIds = (pids: number[], signal: ProcessTreeSignal) => {
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

export const getLiveProcessTreeDependencies = (log: (message: string) => void): ProcessTreeDependencies => {
  return {
    getDescendantProcessIds,
    isProcessAlive,
    killProcessIds,
    log,
    now: Date.now,
    wait: async (ms) => {
      await new Promise((resolve) => {
        setTimeout(resolve, ms)
      })
    },
  }
}

export const waitForProcessIdsExit = async (
  dependencies: Pick<ProcessTreeDependencies, 'isProcessAlive' | 'now' | 'wait'>,
  pids: number[],
  deadlineMs: number,
  pollIntervalMs = defaultProcessTreePollIntervalMs,
): Promise<number[]> => {
  const survivingPids = [...new Set(pids)].filter((pid) => {
    return dependencies.isProcessAlive(pid)
  })

  if (survivingPids.length === 0 || dependencies.now() >= deadlineMs) {
    return survivingPids
  }

  await dependencies.wait(pollIntervalMs)
  return waitForProcessIdsExit(dependencies, survivingPids, deadlineMs, pollIntervalMs)
}

const terminateOrphanedDescendants = (
  dependencies: ProcessTreeDependencies,
  options: StopProcessTreeOptions,
  orphanedDescendantPids: number[],
) => {
  if (orphanedDescendantPids.length === 0) {
    return
  }

  dependencies.log(
    `${options.processName} left pids=${orphanedDescendantPids.join(',')} running after its own shutdown; sending SIGTERM`,
  )
  dependencies.killProcessIds(orphanedDescendantPids, 'SIGTERM')
}

const killProcessTree = async (
  dependencies: ProcessTreeDependencies,
  options: StopProcessTreeOptions,
  input: {capturedDescendantPids: number[]; survivingPids: number[]},
): Promise<StopProcessTreeResult> => {
  dependencies.log(
    `${options.processName} pids=${input.survivingPids.join(',')} did not exit within ${options.shutdownTimeoutMs}ms after SIGTERM; sending SIGKILL to the process tree`,
  )

  const forcedKillPids = [
    ...new Set([options.pid, ...dependencies.getDescendantProcessIds(options.pid), ...input.capturedDescendantPids]),
  ]

  dependencies.killProcessIds(forcedKillPids, 'SIGKILL')

  const forcedKillSurvivors = await waitForProcessIdsExit(
    dependencies,
    forcedKillPids,
    dependencies.now() + options.forcedKillTimeoutMs,
    options.pollIntervalMs,
  )

  if (forcedKillSurvivors.length > 0) {
    throw new Error(`Timed out waiting for ${options.processName} pids=${forcedKillSurvivors.join(',')} to exit`)
  }

  return 'killed'
}

export const stopProcessTree = async (
  dependencies: ProcessTreeDependencies,
  options: StopProcessTreeOptions,
): Promise<StopProcessTreeResult> => {
  const capturedDescendantPids = dependencies.getDescendantProcessIds(options.pid)
  const deadlineMs = dependencies.now() + options.shutdownTimeoutMs

  dependencies.killProcessIds([options.pid], 'SIGTERM')

  const parentSurvivors = await waitForProcessIdsExit(dependencies, [options.pid], deadlineMs, options.pollIntervalMs)

  terminateOrphanedDescendants(
    dependencies,
    options,
    parentSurvivors.length > 0
      ? []
      : capturedDescendantPids.filter((pid) => {
          return dependencies.isProcessAlive(pid)
        }),
  )

  const survivingPids = await waitForProcessIdsExit(
    dependencies,
    [...capturedDescendantPids, options.pid],
    deadlineMs,
    options.pollIntervalMs,
  )

  return survivingPids.length === 0
    ? 'exited'
    : killProcessTree(dependencies, options, {capturedDescendantPids, survivingPids})
}
