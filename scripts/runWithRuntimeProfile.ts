import {realpathSync} from 'node:fs'

import {getBackgroundServerEnv} from '../src/server/utils/backgroundServerStack.ts'
import {mergeRuntimeProfileEnv, type RuntimeProfileName} from '../src/utils/runtimeProfile.ts'

export type RuntimeProfileMode =
  | 'api-only-server'
  | 'app'
  | 'app-server'
  | 'duckdb-migration'
  | 'judge-only-server'
  | 'maintenance-only-server'
  | 'server-stack'
  | 'stacked-server'
type RuntimeProfileServerRole = 'api' | 'judge-worker' | 'maintenance-worker'

export type RuntimeProfileCommandOptions = {mode: RuntimeProfileMode; profileName: RuntimeProfileName}

type RuntimeProfileCommandConfig = {
  command: string[]
  env: (commandOptions: RuntimeProfileCommandOptions) => Record<string, string | undefined>
}

export type AppPortConflictPolicy = 'abort' | 'ignore' | 'kill'
export type AppPortListenerProcess = {command: string | null; cwd: string | null; names: string[]; pid: number}
type ForwardedSignal = 'SIGINT' | 'SIGTERM'
const bunExecutablePath = realpathSync(process.execPath)
const appPortConflictEnvName = 'FORSKA_VITE_PORT_CONFLICT'
const appPortKillTimeoutMs = 5_000

const getRuntimeProfileBaseEnv = (profileName: RuntimeProfileName) => {
  return mergeRuntimeProfileEnv({profileName})
}

const getAppServerEnv = (profileName: RuntimeProfileName) => {
  return {...getRuntimeProfileBaseEnv(profileName), FORSKA_RUNTIME_SERVICE: 'app-server'}
}

const getRuntimeProfileServerEnv = ({profileName}: RuntimeProfileCommandOptions, role: RuntimeProfileServerRole) => {
  return getBackgroundServerEnv({baseEnv: getRuntimeProfileBaseEnv(profileName), role})
}

const getRuntimeProfileJudgeWorkerEnv = (profileName: RuntimeProfileName) => {
  return getBackgroundServerEnv({baseEnv: getRuntimeProfileBaseEnv(profileName), role: 'judge-worker'})
}

const runtimeProfileModes: Record<RuntimeProfileMode, RuntimeProfileCommandConfig> = {
  'api-only-server': {
    command: [bunExecutablePath, '--watch', 'src/server/index.ts'],
    env: (commandOptions) => {
      return getRuntimeProfileServerEnv(commandOptions, 'api')
    },
  },
  app: {
    command: [bunExecutablePath, 'x', '--bun', 'vite'],
    env: ({profileName}) => {
      return getRuntimeProfileBaseEnv(profileName)
    },
  },
  'app-server': {
    command: [bunExecutablePath, 'src/appServer.ts'],
    env: ({profileName}) => {
      return getAppServerEnv(profileName)
    },
  },
  'duckdb-migration': {
    command: [bunExecutablePath, 'src/db/migrateDuckdb.ts'],
    env: ({profileName}) => {
      return getRuntimeProfileBaseEnv(profileName)
    },
  },
  'judge-only-server': {
    command: [bunExecutablePath, '--watch', 'src/server/index.ts'],
    env: ({profileName}) => {
      return getRuntimeProfileJudgeWorkerEnv(profileName)
    },
  },
  'server-stack': {
    command: [bunExecutablePath, 'scripts/startServerStack.ts'],
    env: ({profileName}) => {
      return {...getRuntimeProfileBaseEnv(profileName), FORSKA_RUNTIME_SERVICE: 'dev-single-server'}
    },
  },
  'stacked-server': {
    command: [bunExecutablePath, 'scripts/devServerWatch.ts'],
    env: ({profileName}) => {
      return {...getRuntimeProfileBaseEnv(profileName), FORSKA_RUNTIME_SERVICE: 'dev-single-server'}
    },
  },
  'maintenance-only-server': {
    command: [bunExecutablePath, '--watch', 'src/server/index.ts'],
    env: (commandOptions) => {
      return getRuntimeProfileServerEnv(commandOptions, 'maintenance-worker')
    },
  },
}

const getCliFlagValue = (flagName: string): string | null => {
  const flagIndex = process.argv.indexOf(flagName)

  return flagIndex === -1 ? null : (process.argv[flagIndex + 1] ?? null)
}

const getProfileName = (): RuntimeProfileName => {
  const profileName = getCliFlagValue('--profile')

  if (profileName === 'primary' || profileName === 'secondary') {
    return profileName
  }

  throw new Error(`Expected --profile primary|secondary, received ${String(profileName)}`)
}

const getMode = (): RuntimeProfileMode => {
  const mode = getCliFlagValue('--mode')

  if (
    mode === 'api-only-server'
    || mode === 'app'
    || mode === 'app-server'
    || mode === 'duckdb-migration'
    || mode === 'judge-only-server'
    || mode === 'maintenance-only-server'
    || mode === 'server-stack'
    || mode === 'stacked-server'
  ) {
    return mode
  }

  throw new Error(
    `Expected --mode api-only-server|app|app-server|duckdb-migration|judge-only-server|maintenance-only-server|server-stack|stacked-server, received ${String(mode)}`,
  )
}

const getRuntimeProfileCommandOptions = (): RuntimeProfileCommandOptions => {
  return {mode: getMode(), profileName: getProfileName()}
}

const getRuntimeProfileCommand = ({mode}: RuntimeProfileCommandOptions): string[] => {
  return runtimeProfileModes[mode].command
}

export const getRuntimeProfileCommandEnv = (commandOptions: RuntimeProfileCommandOptions) => {
  return runtimeProfileModes[commandOptions.mode].env(commandOptions)
}

const decodeProcessOutput = (value: unknown) => {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value)
  }

  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(value)
  }

  return ''
}

export const parseLsofFieldOutput = (output: string): AppPortListenerProcess[] => {
  const listeners = new Map<number, AppPortListenerProcess>()
  let currentPid: number | null = null

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim()

    if (line === '') {
      continue
    }

    const field = line.slice(0, 1)
    const value = line.slice(1)

    if (field === 'p') {
      const parsedPid = Number(value)

      if (Number.isInteger(parsedPid) && parsedPid > 0) {
        currentPid = parsedPid
        if (!listeners.has(parsedPid)) {
          listeners.set(parsedPid, {command: null, cwd: null, names: [], pid: parsedPid})
        }
      }
      continue
    }

    if (currentPid === null) {
      continue
    }

    const listener = listeners.get(currentPid)

    if (listener === undefined) {
      continue
    }

    if (field === 'c') {
      listener.command = value === '' ? null : value
    }

    if (field === 'n' && value !== '') {
      listener.names.push(value)
    }
  }

  return [...listeners.values()]
}

const getTrimmedOutput = (command: string[]) => {
  const result = globalThis.Bun.spawnSync(command, {stderr: 'pipe', stdout: 'pipe'})

  if (result.exitCode !== 0) {
    return null
  }

  const output = decodeProcessOutput(result.stdout).trim()

  return output === '' ? null : output
}

const getProcessCwd = (pid: number) => {
  const output = getTrimmedOutput(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'])

  return (
    output
      ?.split(/\r?\n/u)
      .find((line) => {
        return line.startsWith('n')
      })
      ?.slice(1)
      .trim() || null
  )
}

const getProcessCommand = (pid: number) => {
  return getTrimmedOutput(['ps', '-p', String(pid), '-o', 'command='])
}

export const getAppPortConflictPolicy = (envValues: Record<string, string | undefined>): AppPortConflictPolicy => {
  const normalized = String(envValues[appPortConflictEnvName] ?? 'abort')
    .trim()
    .toLowerCase()

  if (normalized === 'abort' || normalized === '') {
    return 'abort'
  }

  if (normalized === 'kill' || normalized === 'takeover') {
    return 'kill'
  }

  if (normalized === 'ignore' || normalized === 'allow') {
    return 'ignore'
  }

  throw new Error(
    `Expected ${appPortConflictEnvName}=abort|kill|ignore, received ${JSON.stringify(
      envValues[appPortConflictEnvName],
    )}`,
  )
}

const getPortListenerProcesses = (port: string): AppPortListenerProcess[] => {
  // Container images (Apple container on oven/bun) ship without lsof; treat that as "nothing
  // observable" instead of failing app startup, which is what Bun.spawnSync does for a missing binary.
  if (!globalThis.Bun.which('lsof')) {
    console.warn(`[app:preflight] lsof is not installed; skipping the Vite port ${port} listener check`)
    return []
  }

  const result = globalThis.Bun.spawnSync(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'], {
    stderr: 'pipe',
    stdout: 'pipe',
  })

  if (result.exitCode !== 0) {
    return []
  }

  return parseLsofFieldOutput(decodeProcessOutput(result.stdout)).map((listener) => {
    return {...listener, command: getProcessCommand(listener.pid) ?? listener.command, cwd: getProcessCwd(listener.pid)}
  })
}

export const formatAppPortListeners = (listeners: AppPortListenerProcess[]) => {
  return listeners
    .map((listener) => {
      const endpoints = listener.names.length > 0 ? listener.names.join(', ') : 'unknown endpoint'
      const cwd = listener.cwd ?? 'unknown cwd'
      const command = listener.command ?? 'unknown command'

      return `- pid=${listener.pid} endpoints=${endpoints}\n  cwd=${cwd}\n  command=${command}`
    })
    .join('\n')
}

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForProcessExit = async (pid: number, timeoutMs: number) => {
  const deadlineMs = Date.now() + timeoutMs

  while (Date.now() < deadlineMs) {
    if (!isProcessAlive(pid)) {
      return true
    }

    await new Promise((resolve) => {
      return setTimeout(resolve, 100)
    })
  }

  return !isProcessAlive(pid)
}

const terminateListenerProcess = async (listener: AppPortListenerProcess) => {
  if (!isProcessAlive(listener.pid)) {
    return
  }

  process.kill(listener.pid, 'SIGTERM')

  if (await waitForProcessExit(listener.pid, appPortKillTimeoutMs)) {
    return
  }

  process.kill(listener.pid, 'SIGKILL')
  await waitForProcessExit(listener.pid, appPortKillTimeoutMs)
}

export const ensureAppPortAvailable = async ({
  envValues,
  getListeners = getPortListenerProcesses,
  terminateListener = terminateListenerProcess,
}: {
  envValues: Record<string, string | undefined>
  getListeners?: (port: string) => AppPortListenerProcess[]
  terminateListener?: (listener: AppPortListenerProcess) => Promise<void>
}) => {
  const port = String(envValues.VITE_PORT ?? '').trim()

  if (port === '') {
    return
  }

  const listeners = getListeners(port).filter((listener) => {
    return listener.pid !== process.pid
  })

  if (listeners.length === 0) {
    return
  }

  const policy = getAppPortConflictPolicy(envValues)

  if (policy === 'ignore') {
    console.error(
      `[app:preflight] Vite port ${port} is already in use; continuing because ${appPortConflictEnvName}=ignore`,
    )
    return
  }

  if (policy === 'kill') {
    console.error(`[app:preflight] Vite port ${port} is already in use; terminating existing listener(s):`)
    console.error(formatAppPortListeners(listeners))

    for (const listener of listeners) {
      await terminateListener(listener)
    }

    const remainingListeners = getListeners(port).filter((listener) => {
      return listener.pid !== process.pid
    })

    if (remainingListeners.length === 0) {
      return
    }

    throw new Error(
      `Vite port ${port} is still in use after ${appPortConflictEnvName}=kill:\n${formatAppPortListeners(
        remainingListeners,
      )}`,
    )
  }

  throw new Error(
    `Vite port ${port} is already in use. Stop the listed process(es), choose another VITE_PORT, or rerun with ${appPortConflictEnvName}=kill to terminate them before startup:\n${formatAppPortListeners(
      listeners,
    )}`,
  )
}

const runWithRuntimeProfile = async () => {
  const commandOptions = getRuntimeProfileCommandOptions()
  const commandEnv = getRuntimeProfileCommandEnv(commandOptions)

  if (commandOptions.mode === 'app') {
    await ensureAppPortAvailable({envValues: commandEnv})
  }

  const childProcess = globalThis.Bun.spawn(getRuntimeProfileCommand(commandOptions), {
    cwd: process.cwd(),
    env: commandEnv,
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  })

  let forwardedSignal: ForwardedSignal | null = null
  const forwardSignal = (signal: ForwardedSignal) => {
    if (forwardedSignal !== null) {
      return
    }

    forwardedSignal = signal

    if (childProcess.exitCode === null) {
      childProcess.kill(signal)
    }
  }

  process.once('SIGINT', () => {
    forwardSignal('SIGINT')
  })

  process.once('SIGTERM', () => {
    forwardSignal('SIGTERM')
  })

  const exitCode = await childProcess.exited

  if (forwardedSignal !== null) {
    process.exit(exitCode)
  }

  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}

if (import.meta.main) {
  await runWithRuntimeProfile()
}
