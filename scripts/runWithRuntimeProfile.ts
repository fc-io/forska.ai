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
type RuntimeProfileServerRole = 'api' | 'maintenance-worker'

export type RuntimeProfileCommandOptions = {mode: RuntimeProfileMode; profileName: RuntimeProfileName}

type RuntimeProfileCommandConfig = {
  command: string[]
  env: (commandOptions: RuntimeProfileCommandOptions) => Record<string, string | undefined>
}

type ForwardedSignal = 'SIGINT' | 'SIGTERM'

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
  const baseEnv = getRuntimeProfileBaseEnv(profileName)

  return {
    ...baseEnv,
    API_SERVER_PORT: baseEnv.BACKGROUND_JUDGE_PORT,
    FORSKA_RUNTIME_SERVICE: 'judge-worker-server',
    SERVER_DUCKDB_OWNER_URL: `http://127.0.0.1:${baseEnv.BACKGROUND_MAINTENANCE_PORT}`,
    SERVER_ROLE: 'judge-worker',
  }
}

const runtimeProfileModes: Record<RuntimeProfileMode, RuntimeProfileCommandConfig> = {
  'api-only-server': {
    command: ['bun', 'run', '--watch', 'src/server/index.ts'],
    env: (commandOptions) => {
      return getRuntimeProfileServerEnv(commandOptions, 'api')
    },
  },
  app: {
    command: ['bunx', '--bun', 'vite'],
    env: ({profileName}) => {
      return getRuntimeProfileBaseEnv(profileName)
    },
  },
  'app-server': {
    command: ['bun', 'run', 'src/appServer.ts'],
    env: ({profileName}) => {
      return getAppServerEnv(profileName)
    },
  },
  'duckdb-migration': {
    command: ['bun', 'src/db/migrateDuckdb.ts'],
    env: ({profileName}) => {
      return getRuntimeProfileBaseEnv(profileName)
    },
  },
  'judge-only-server': {
    command: ['bun', 'run', '--watch', 'src/server/index.ts'],
    env: ({profileName}) => {
      return getRuntimeProfileJudgeWorkerEnv(profileName)
    },
  },
  'server-stack': {
    command: ['bun', 'scripts/startServerStack.ts'],
    env: ({profileName}) => {
      return {...getRuntimeProfileBaseEnv(profileName), FORSKA_RUNTIME_SERVICE: 'dev-single-server'}
    },
  },
  'stacked-server': {
    command: ['bun', 'scripts/devServerWatch.ts'],
    env: ({profileName}) => {
      return {...getRuntimeProfileBaseEnv(profileName), FORSKA_RUNTIME_SERVICE: 'dev-single-server'}
    },
  },
  'maintenance-only-server': {
    command: ['bun', 'run', '--watch', 'src/server/index.ts'],
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

const runWithRuntimeProfile = async () => {
  const commandOptions = getRuntimeProfileCommandOptions()
  const childProcess = globalThis.Bun.spawn(getRuntimeProfileCommand(commandOptions), {
    cwd: process.cwd(),
    env: getRuntimeProfileCommandEnv(commandOptions),
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
