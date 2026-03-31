import {mergeRuntimeProfileEnv, type RuntimeProfileName} from '../src/utils/runtimeProfile.ts'

type RuntimeProfileMode = 'duckdb-migration'

type RuntimeProfileCommandOptions = {mode: RuntimeProfileMode; profileName: RuntimeProfileName}

const runtimeProfileModes: Record<RuntimeProfileMode, string[]> = {
  'duckdb-migration': ['bun', 'src/db/migrateDuckdb.ts'],
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

  if (mode === 'duckdb-migration') {
    return mode
  }

  throw new Error(`Expected --mode duckdb-migration, received ${String(mode)}`)
}

const getRuntimeProfileCommandOptions = (): RuntimeProfileCommandOptions => {
  return {mode: getMode(), profileName: getProfileName()}
}

const getRuntimeProfileCommand = ({mode}: RuntimeProfileCommandOptions): string[] => {
  return runtimeProfileModes[mode]
}

const runWithRuntimeProfile = async () => {
  const commandOptions = getRuntimeProfileCommandOptions()
  const childProcess = globalThis.Bun.spawn(getRuntimeProfileCommand(commandOptions), {
    cwd: process.cwd(),
    env: mergeRuntimeProfileEnv({profileName: commandOptions.profileName}),
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
