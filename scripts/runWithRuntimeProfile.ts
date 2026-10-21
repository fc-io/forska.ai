import {realpathSync} from 'node:fs'

import {getBackgroundServerEnv} from '../src/server/utils/backgroundServerStack.ts'
import {getDuckdbPath} from '../src/server/utils/getDuckdbPath.ts'
import {shouldUseProcessStopRequests, startProcessStopRequestWatcher} from '../src/server/utils/processStopRequest.ts'
import {getRuntimeProfileEnv, mergeRuntimeProfileEnv, type RuntimeProfileName} from '../src/utils/runtimeProfile.ts'
import {getRuntimeProfileWrapperShutdownTimeoutMs} from './serverStackShutdown.ts'
import {getLiveStopChildProcessDependencies, stopChildProcess} from './stopChildProcess.ts'

export type RuntimeProfileMode =
  | 'api-only-server'
  | 'app'
  | 'app-server'
  | 'duckdb-migration'
  | 'judge-only-server'
  | 'maintenance-only-server'
  | 'script'
  | 'server-stack'
  | 'stacked-server'
type RuntimeProfileServerRole = 'api' | 'judge-worker' | 'maintenance-worker'

export type RuntimeProfileCommandOptions = {
  mode: RuntimeProfileMode
  profileName: RuntimeProfileName
  scriptCommand?: string[]
}

type RuntimeProfileCommandConfig = {
  command: (commandOptions: RuntimeProfileCommandOptions) => string[]
  env: (commandOptions: RuntimeProfileCommandOptions) => Record<string, string | undefined>
}
type EnvValues = Record<string, string | undefined>
type RuntimeProfileScriptEnvConflict = {
  name: 'DUCKDB_PATH' | 'DUCKDB_PATH_FILE' | 'FORSKA_RUNTIME_PROFILE'
  value: string
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

const getTrimmedEnvValue = (value: string | undefined) => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const getInheritedRuntimeProfileConflict = (
  baseEnv: EnvValues,
  profileName: RuntimeProfileName,
): RuntimeProfileScriptEnvConflict[] => {
  const inheritedProfileName = getTrimmedEnvValue(baseEnv.FORSKA_RUNTIME_PROFILE)

  return inheritedProfileName === null || inheritedProfileName === profileName
    ? []
    : [{name: 'FORSKA_RUNTIME_PROFILE', value: inheritedProfileName}]
}

const getInheritedDuckdbPathConflict = (
  baseEnv: EnvValues,
  profileDuckdbPath: string,
): RuntimeProfileScriptEnvConflict[] => {
  const inheritedDuckdbPath = getTrimmedEnvValue(baseEnv.DUCKDB_PATH)

  return inheritedDuckdbPath === null
    || getDuckdbPath({duckdbPath: inheritedDuckdbPath, envValues: baseEnv}) === profileDuckdbPath
    ? []
    : [{name: 'DUCKDB_PATH', value: inheritedDuckdbPath}]
}

const getInheritedDuckdbPathFileConflict = (baseEnv: EnvValues): RuntimeProfileScriptEnvConflict[] => {
  const inheritedDuckdbPathFile = getTrimmedEnvValue(baseEnv.DUCKDB_PATH_FILE)

  return inheritedDuckdbPathFile === null ? [] : [{name: 'DUCKDB_PATH_FILE', value: inheritedDuckdbPathFile}]
}

const getProfileDuckdbPath = (profileName: RuntimeProfileName, baseEnv: EnvValues) => {
  return getDuckdbPath({
    duckdbPath: getRuntimeProfileEnv(profileName, {envValues: baseEnv}).DUCKDB_PATH,
    envValues: baseEnv,
  })
}

export const getRuntimeProfileScriptEnvConflicts = ({
  baseEnv = process.env,
  profileName,
}: {
  baseEnv?: EnvValues
  profileName: RuntimeProfileName
}) => {
  const profileDuckdbPath = getProfileDuckdbPath(profileName, baseEnv)

  return [
    ...getInheritedRuntimeProfileConflict(baseEnv, profileName),
    ...getInheritedDuckdbPathConflict(baseEnv, profileDuckdbPath),
    ...getInheritedDuckdbPathFileConflict(baseEnv),
  ]
}

const getShellWord = (value: string) => {
  return /\s/u.test(value) ? `"${value}"` : value
}

const getRuntimeProfileScriptEnvConflictError = ({
  baseEnv,
  conflicts,
  profileName,
  scriptCommand,
}: {
  baseEnv: EnvValues
  conflicts: RuntimeProfileScriptEnvConflict[]
  profileName: RuntimeProfileName
  scriptCommand: string[]
}) => {
  const conflictAssignments = conflicts.map((conflict) => {
    return `${conflict.name}=${getShellWord(conflict.value)}`
  })

  return new Error(
    [
      `--profile ${profileName} opens ${getProfileDuckdbPath(profileName, baseEnv)}, but the shell already sets ${conflictAssignments.join(' and ')}.`,
      'The wrapper does not override an explicit DuckDB target. Unset it to use the profile, use the matching :secondary script, or run the command directly against that target:',
      `  ${[...conflictAssignments, ...scriptCommand.map(getShellWord)].join(' ')}`,
    ].join('\n'),
  )
}

export const getRuntimeProfileScriptEnv = ({
  baseEnv = process.env,
  profileName,
  scriptCommand = [],
}: {
  baseEnv?: EnvValues
  profileName: RuntimeProfileName
  scriptCommand?: string[]
}) => {
  const conflicts = getRuntimeProfileScriptEnvConflicts({baseEnv, profileName})

  if (conflicts.length > 0) {
    throw getRuntimeProfileScriptEnvConflictError({baseEnv, conflicts, profileName, scriptCommand})
  }

  return mergeRuntimeProfileEnv({baseEnv, profileName})
}

export const getRuntimeProfileScriptCommand = (scriptCommand: string[] = []) => {
  const [executable, ...args] = scriptCommand

  if (executable === undefined) {
    throw new Error('Expected a command after -- for --mode script, for example: -- bun scripts/dbQuerySnapshot.ts')
  }

  return [executable === 'bun' ? bunExecutablePath : executable, ...args]
}

const runtimeProfileModes: Record<RuntimeProfileMode, RuntimeProfileCommandConfig> = {
  'api-only-server': {
    command: () => {
      return [bunExecutablePath, '--watch', 'src/server/index.ts']
    },
    env: (commandOptions) => {
      return getRuntimeProfileServerEnv(commandOptions, 'api')
    },
  },
  app: {
    command: () => {
      return [bunExecutablePath, 'x', '--bun', 'vite']
    },
    env: ({profileName}) => {
      return getRuntimeProfileBaseEnv(profileName)
    },
  },
  'app-server': {
    command: () => {
      return [bunExecutablePath, 'src/appServer.ts']
    },
    env: ({profileName}) => {
      return getAppServerEnv(profileName)
    },
  },
  'duckdb-migration': {
    command: () => {
      return [bunExecutablePath, 'src/db/migrateDuckdb.ts']
    },
    env: ({profileName}) => {
      return getRuntimeProfileBaseEnv(profileName)
    },
  },
  'judge-only-server': {
    command: () => {
      return [bunExecutablePath, '--watch', 'src/server/index.ts']
    },
    env: ({profileName}) => {
      return getRuntimeProfileJudgeWorkerEnv(profileName)
    },
  },
  script: {
    command: ({scriptCommand}) => {
      return getRuntimeProfileScriptCommand(scriptCommand)
    },
    env: ({profileName, scriptCommand}) => {
      return getRuntimeProfileScriptEnv({profileName, scriptCommand})
    },
  },
  'server-stack': {
    command: () => {
      return [bunExecutablePath, 'scripts/startServerStack.ts']
    },
    env: ({profileName}) => {
      return {...getRuntimeProfileBaseEnv(profileName), FORSKA_RUNTIME_SERVICE: 'dev-single-server'}
    },
  },
  'stacked-server': {
    command: () => {
      return [bunExecutablePath, 'scripts/devServerWatch.ts']
    },
    env: ({profileName}) => {
      return {...getRuntimeProfileBaseEnv(profileName), FORSKA_RUNTIME_SERVICE: 'dev-single-server'}
    },
  },
  'maintenance-only-server': {
    command: () => {
      return [bunExecutablePath, '--watch', 'src/server/index.ts']
    },
    env: (commandOptions) => {
      return getRuntimeProfileServerEnv(commandOptions, 'maintenance-worker')
    },
  },
}

const getWrapperArgs = (args: string[]) => {
  const separatorIndex = args.indexOf('--')

  return separatorIndex === -1 ? args : args.slice(0, separatorIndex)
}

const getScriptCommandArgs = (args: string[]) => {
  const separatorIndex = args.indexOf('--')

  return separatorIndex === -1 ? [] : args.slice(separatorIndex + 1)
}

const getCliFlagValue = (args: string[], flagName: string): string | null => {
  const flagIndex = args.indexOf(flagName)

  return flagIndex === -1 ? null : (args[flagIndex + 1] ?? null)
}

const getProfileName = (args: string[]): RuntimeProfileName => {
  const profileName = getCliFlagValue(args, '--profile')

  if (profileName === 'primary' || profileName === 'secondary') {
    return profileName
  }

  throw new Error(`Expected --profile primary|secondary, received ${String(profileName)}`)
}

const getMode = (args: string[]): RuntimeProfileMode => {
  const mode = getCliFlagValue(args, '--mode')

  if (
    mode === 'api-only-server'
    || mode === 'app'
    || mode === 'app-server'
    || mode === 'duckdb-migration'
    || mode === 'judge-only-server'
    || mode === 'maintenance-only-server'
    || mode === 'script'
    || mode === 'server-stack'
    || mode === 'stacked-server'
  ) {
    return mode
  }

  throw new Error(
    `Expected --mode api-only-server|app|app-server|duckdb-migration|judge-only-server|maintenance-only-server|script|server-stack|stacked-server, received ${String(mode)}`,
  )
}

export const parseRuntimeProfileCommandOptions = (args: string[]): RuntimeProfileCommandOptions => {
  const wrapperArgs = getWrapperArgs(args)
  const mode = getMode(wrapperArgs)
  const profileName = getProfileName(wrapperArgs)

  return mode === 'script' ? {mode, profileName, scriptCommand: getScriptCommandArgs(args)} : {mode, profileName}
}

export const getRuntimeProfileCommand = (commandOptions: RuntimeProfileCommandOptions): string[] => {
  return runtimeProfileModes[commandOptions.mode].command(commandOptions)
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

const logRuntimeProfileWrapperMessage = (message: string) => {
  console.error(`[runtime-profile] ${message}`)
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getScriptModeLaunchOrExit = (commandOptions: RuntimeProfileCommandOptions) => {
  try {
    return {command: getRuntimeProfileCommand(commandOptions), env: getRuntimeProfileCommandEnv(commandOptions)}
  } catch (error) {
    logRuntimeProfileWrapperMessage(getErrorMessage(error))
    process.exit(1)
  }
}

const getRuntimeProfileLaunch = (commandOptions: RuntimeProfileCommandOptions) => {
  return commandOptions.mode === 'script'
    ? getScriptModeLaunchOrExit(commandOptions)
    : {command: getRuntimeProfileCommand(commandOptions), env: getRuntimeProfileCommandEnv(commandOptions)}
}

const runWithRuntimeProfile = async () => {
  const commandOptions = parseRuntimeProfileCommandOptions(process.argv.slice(2))
  const {command, env: commandEnv} = getRuntimeProfileLaunch(commandOptions)

  if (commandOptions.mode === 'app') {
    await ensureAppPortAvailable({envValues: commandEnv})
  }

  const childProcess = globalThis.Bun.spawn(command, {
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
    void stopChildProcess(getLiveStopChildProcessDependencies(logRuntimeProfileWrapperMessage), childProcess, {
      childName: `${commandOptions.mode} child`,
      signal,
      timeoutMs: getRuntimeProfileWrapperShutdownTimeoutMs(commandEnv),
    })
  }

  process.once('SIGINT', () => {
    forwardSignal('SIGINT')
  })

  process.once('SIGTERM', () => {
    forwardSignal('SIGTERM')
  })

  if (shouldUseProcessStopRequests()) {
    startProcessStopRequestWatcher({
      onStopRequest: () => {
        forwardSignal('SIGTERM')
      },
    })
  }

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
