import {basename, extname, relative} from 'node:path'

import {getRuntimeProfileDuckdbPath} from '../../utils/runtimeProfile.ts'

type EnvValues = Record<string, string | undefined>
type OperatorScriptRuntimeProfile = 'local' | 'primary' | 'secondary'

export type OperatorScriptDuckdbTarget = {banner: string; status: 'allowed'} | {message: string; status: 'refused'}

type OperatorScriptDuckdbTargetInput = {
  cwd: string
  duckdbPath: string
  envValues: EnvValues
  scriptPath: string | null
}

const operatorScriptRuntimeProfiles: OperatorScriptRuntimeProfile[] = ['local', 'primary', 'secondary']

const getTrimmedValue = (value: string | undefined) => {
  const normalized = String(value ?? '').trim()

  return normalized === '' ? null : normalized
}

const isOperatorScriptRuntimeProfile = (value: string): value is OperatorScriptRuntimeProfile => {
  return operatorScriptRuntimeProfiles.some((profileName) => {
    return profileName === value
  })
}

const hasExplicitDuckdbPath = (envValues: EnvValues) => {
  return getTrimmedValue(envValues.DUCKDB_PATH) !== null || getTrimmedValue(envValues.DUCKDB_PATH_FILE) !== null
}

export const getOperatorScriptName = (scriptPath: string | null) => {
  return scriptPath === null ? 'duckdb-script' : basename(scriptPath, extname(scriptPath))
}

const getOperatorScriptCommand = ({cwd, scriptPath}: Pick<OperatorScriptDuckdbTargetInput, 'cwd' | 'scriptPath'>) => {
  return scriptPath === null ? '<script>' : relative(cwd, scriptPath)
}

export const getOperatorScriptDuckdbBanner = ({
  duckdbPath,
  profileName,
  scriptName,
}: {
  duckdbPath: string
  profileName: string | null
  scriptName: string
}) => {
  return `[${scriptName}] duckdb path: ${duckdbPath} profile: ${profileName ?? 'unset (DUCKDB_PATH set explicitly)'}`
}

const getInvalidRuntimeProfileMessage = (scriptName: string, profileName: string) => {
  return `[${scriptName}] refusing to open DuckDB: FORSKA_RUNTIME_PROFILE=${profileName} is not local, primary or secondary.`
}

const getMissingRuntimeProfileMessage = (input: OperatorScriptDuckdbTargetInput) => {
  const scriptName = getOperatorScriptName(input.scriptPath)
  const scriptCommand = getOperatorScriptCommand(input)
  const primaryDuckdbPath = getRuntimeProfileDuckdbPath({envValues: input.envValues, profileName: 'primary'})

  return [
    `[${scriptName}] refusing to open DuckDB: FORSKA_RUNTIME_PROFILE is not set, so DUCKDB_PATH resolves to the local default`,
    `  ${input.duckdbPath}`,
    `which is not the DB the dev server uses (primary profile: ${primaryDuckdbPath}). Choose the DB explicitly:`,
    `  bun scripts/runWithRuntimeProfile.ts --profile primary|secondary --mode script -- bun ${scriptCommand} ...`,
    `  FORSKA_RUNTIME_PROFILE=local|primary|secondary bun ${scriptCommand} ...`,
    'The bun run db:* scripts already use the wrapper. An explicit DUCKDB_PATH=<file> also counts as a choice.',
  ].join('\n')
}

const getAllowedOperatorScriptDuckdbTarget = (
  input: OperatorScriptDuckdbTargetInput,
  profileName: string | null,
): OperatorScriptDuckdbTarget => {
  return {
    banner: getOperatorScriptDuckdbBanner({
      duckdbPath: input.duckdbPath,
      profileName,
      scriptName: getOperatorScriptName(input.scriptPath),
    }),
    status: 'allowed',
  }
}

const getUnprofiledOperatorScriptDuckdbTarget = (
  input: OperatorScriptDuckdbTargetInput,
): OperatorScriptDuckdbTarget => {
  return hasExplicitDuckdbPath(input.envValues)
    ? getAllowedOperatorScriptDuckdbTarget(input, null)
    : {message: getMissingRuntimeProfileMessage(input), status: 'refused'}
}

const getProfiledOperatorScriptDuckdbTarget = (
  input: OperatorScriptDuckdbTargetInput,
  profileName: string,
): OperatorScriptDuckdbTarget => {
  return isOperatorScriptRuntimeProfile(profileName)
    ? getAllowedOperatorScriptDuckdbTarget(input, profileName)
    : {
        message: getInvalidRuntimeProfileMessage(getOperatorScriptName(input.scriptPath), profileName),
        status: 'refused',
      }
}

export const getOperatorScriptDuckdbTarget = (input: OperatorScriptDuckdbTargetInput): OperatorScriptDuckdbTarget => {
  const profileName = getTrimmedValue(input.envValues.FORSKA_RUNTIME_PROFILE)?.toLowerCase() ?? null

  return profileName === null
    ? getUnprofiledOperatorScriptDuckdbTarget(input)
    : getProfiledOperatorScriptDuckdbTarget(input, profileName)
}
