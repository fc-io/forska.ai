import {getBackgroundServerEnv} from '../src/server/utils/backgroundServerStack.ts'
import {mergeRuntimeProfileEnv, type RuntimeProfileName} from '../src/utils/runtimeProfile.ts'

type RuntimeProfileMode =
  | 'api-only-server'
  | 'app'
  | 'app-server'
  | 'duckdb-migration'
  | 'server-stack'
  | 'stacked-server'
  | 'worker-only-server'
type RuntimeProfileServerRole = 'api' | 'worker'

type RuntimeProfileCommandOptions = {mode: RuntimeProfileMode; profileName: RuntimeProfileName}

type RuntimeProfileCommandConfig = {
  command: string[]
  env: (commandOptions: RuntimeProfileCommandOptions) => Record<string, string | undefined>
}

const getRuntimeProfileBaseEnv = (profileName: RuntimeProfileName) => {
  return mergeRuntimeProfileEnv({profileName})
}

const getRuntimeProfileServerEnv = ({profileName}: RuntimeProfileCommandOptions, role: RuntimeProfileServerRole) => {
  return getBackgroundServerEnv({baseEnv: getRuntimeProfileBaseEnv(profileName), role})
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
      return getRuntimeProfileBaseEnv(profileName)
    },
  },
  'duckdb-migration': {
    command: ['bun', 'src/db/migrateDuckdb.ts'],
    env: ({profileName}) => {
      return getRuntimeProfileBaseEnv(profileName)
    },
  },
  'server-stack': {
    command: ['bun', 'scripts/startServerStack.ts'],
    env: ({profileName}) => {
      return getRuntimeProfileBaseEnv(profileName)
    },
  },
  'stacked-server': {
    command: ['bun', 'scripts/devServerWatch.ts'],
    env: ({profileName}) => {
      return getRuntimeProfileBaseEnv(profileName)
    },
  },
  'worker-only-server': {
    command: ['bun', 'run', '--watch', 'src/server/index.ts'],
    env: (commandOptions) => {
      return getRuntimeProfileServerEnv(commandOptions, 'worker')
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
    || mode === 'server-stack'
    || mode === 'stacked-server'
    || mode === 'worker-only-server'
  ) {
    return mode
  }

  throw new Error(
    `Expected --mode api-only-server|app|app-server|duckdb-migration|server-stack|stacked-server|worker-only-server, received ${String(mode)}`,
  )
}

const getRuntimeProfileCommandOptions = (): RuntimeProfileCommandOptions => {
  return {mode: getMode(), profileName: getProfileName()}
}

const getRuntimeProfileCommand = ({mode}: RuntimeProfileCommandOptions): string[] => {
  return runtimeProfileModes[mode].command
}

const getRuntimeProfileCommandEnv = (commandOptions: RuntimeProfileCommandOptions) => {
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
  const exitCode = await childProcess.exited

  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}

if (import.meta.main) {
  await runWithRuntimeProfile()
}
