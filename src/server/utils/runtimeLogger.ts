import {join} from 'node:path'

import {resolveRuntimeFilePath, resolveRuntimeWritablePath} from './runtimeWritablePath.ts'

export type RuntimeLogLevel = 'DEBUG' | 'ERROR' | 'INFO' | 'WARN'
export type RuntimeLogProfile = 'local' | 'primary' | 'secondary'

type RuntimeLogConfigOptions = {
  cwd?: string
  envValues?: Record<string, string | undefined>
  joinPath?: (...paths: string[]) => string
  runtimeWritableRoot?: string
}

const runtimeLogLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const
const runtimeLogProfiles = ['local', 'primary', 'secondary'] as const

const getTrimmedValue = (value: string | null | undefined) => {
  const normalizedValue = String(value ?? '').trim()

  return normalizedValue === '' ? null : normalizedValue
}

const resolveRuntimeLogProfile = (value: string | null | undefined): RuntimeLogProfile => {
  const normalizedValue = getTrimmedValue(value)?.toLowerCase()
  const matchedProfile = runtimeLogProfiles.find((profile) => {
    return profile === normalizedValue
  })

  return matchedProfile ?? 'local'
}

const resolveRuntimeLogLevel = (value: string | null | undefined, fallback: RuntimeLogLevel): RuntimeLogLevel => {
  const normalizedValue = getTrimmedValue(value)?.toUpperCase()
  const matchedLevel = runtimeLogLevels.find((level) => {
    return level === normalizedValue
  })

  return matchedLevel ?? fallback
}

export const getRuntimeLogProfile = ({
  envValues = process.env,
}: Pick<RuntimeLogConfigOptions, 'envValues'> = {}): RuntimeLogProfile => {
  return resolveRuntimeLogProfile(envValues.FORSKA_RUNTIME_PROFILE)
}

export const getDefaultRuntimeLogDir = ({
  cwd = process.cwd(),
  envValues = process.env,
  joinPath = join,
  runtimeWritableRoot,
}: RuntimeLogConfigOptions = {}) => {
  const runtimeProfile = getRuntimeLogProfile({envValues})

  return runtimeWritableRoot
    ? joinPath(runtimeWritableRoot, 'logs', 'runtime', runtimeProfile)
    : resolveRuntimeWritablePath({cwd, envValues, pathValue: join('logs', 'runtime', runtimeProfile)})
}

export const getRuntimeLogConfig = ({
  cwd = process.cwd(),
  envValues = process.env,
  joinPath = join,
  runtimeWritableRoot,
}: RuntimeLogConfigOptions = {}) => {
  const runtimeProfile = getRuntimeLogProfile({envValues})
  const configuredLogDir = getTrimmedValue(envValues.LOG_DIR)
  const logDir =
    configuredLogDir === null
      ? getDefaultRuntimeLogDir({cwd, envValues, joinPath, runtimeWritableRoot})
      : resolveRuntimeFilePath({cwd, envValues, pathValue: configuredLogDir})

  return {
    logDir,
    logLevel: resolveRuntimeLogLevel(envValues.LOG_LEVEL, 'INFO'),
    logStderrLevel: resolveRuntimeLogLevel(envValues.LOG_STDERR_LEVEL, 'WARN'),
    runtimeProfile,
  }
}
