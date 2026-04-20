import {appendFileSync, mkdirSync} from 'node:fs'
import {join} from 'node:path'

import {
  getRuntimeProcessLogIdentity,
  type RuntimeProcessLogIdentity,
  type RuntimeProcessServerRole,
  type RuntimeProcessServiceName,
} from './runtimeProcessIdentity.ts'
import {resolveRuntimeFilePath, resolveRuntimeWritablePath} from './runtimeWritablePath.ts'

export type RuntimeLogLevel = 'DEBUG' | 'ERROR' | 'INFO' | 'WARN'
export type RuntimeLogProfile = 'local' | 'primary' | 'secondary'
export type RuntimeLogSeverity = RuntimeLogLevel

export type RuntimeLogRecord = {
  attrs: Record<string, unknown>
  event: string
  message: string
  runtime: RuntimeProcessLogIdentity
  severity: RuntimeLogSeverity
  timestamp: string
}

export type RuntimeLogEventInput = {
  attrs?: Record<string, unknown>
  event: string
  message: string
  serverRole?: RuntimeProcessServerRole
  severity: RuntimeLogSeverity
  timestamp?: string
}

type RuntimeLogConfigOptions = {
  cwd?: string
  envValues?: Record<string, string | undefined>
  joinPath?: (...paths: string[]) => string
  runtimeWritableRoot?: string
}

type RuntimeJsonlSinkState = {
  installed: boolean
  logDir: string | null
  logLevel: RuntimeLogLevel
  serverRole: RuntimeProcessServerRole | undefined
}

const runtimeLogLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const
const runtimeLogProfiles = ['local', 'primary', 'secondary'] as const
const runtimeLogLevelWeights: Record<RuntimeLogLevel, number> = {DEBUG: 10, ERROR: 40, INFO: 20, WARN: 30}

declare global {
  var __forskaRuntimeJsonlSinkState: RuntimeJsonlSinkState | undefined
}

const getRuntimeJsonlSinkState = () => {
  globalThis.__forskaRuntimeJsonlSinkState ??= {installed: false, logDir: null, logLevel: 'INFO', serverRole: undefined}

  return globalThis.__forskaRuntimeJsonlSinkState
}

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

const getJsonlDateFromTimestamp = (timestamp: string) => {
  return timestamp.slice(0, 10)
}

const getRuntimeLogFilePath = ({
  logDir,
  service,
  timestamp,
}: {
  logDir: string
  service: RuntimeProcessServiceName
  timestamp: string
}) => {
  return join(logDir, `${service}-${getJsonlDateFromTimestamp(timestamp)}.jsonl`)
}

const shouldWriteRuntimeLogSeverity = ({
  configuredLevel,
  severity,
}: {
  configuredLevel: RuntimeLogLevel
  severity: RuntimeLogSeverity
}) => {
  return runtimeLogLevelWeights[severity] >= runtimeLogLevelWeights[configuredLevel]
}

const getRuntimeProcessServerRole = (
  envValues: Record<string, string | undefined> = process.env,
): RuntimeProcessServerRole | undefined => {
  const normalizedValue = getTrimmedValue(envValues.SERVER_ROLE)

  return normalizedValue === 'api'
    || normalizedValue === 'auto'
    || normalizedValue === 'dev-single'
    || normalizedValue === 'worker'
    || normalizedValue === 'writer'
    ? normalizedValue
    : undefined
}

const getSerializableValue = (value: unknown, seenObjects = new WeakSet<object>()): unknown => {
  if (value instanceof Error) {
    return {message: value.message, name: value.name, stack: value.stack}
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      return getSerializableValue(item, seenObjects)
    })
  }

  if (value && typeof value === 'object') {
    if (seenObjects.has(value)) {
      return '[Circular]'
    }

    seenObjects.add(value)

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        return [key, getSerializableValue(item, seenObjects)]
      }),
    )
  }

  return value
}

const getJsonLine = (record: RuntimeLogRecord) => {
  return `${JSON.stringify(getSerializableValue(record))}\n`
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

export const createRuntimeLogRecord = ({
  attrs,
  envValues = process.env,
  event,
  message,
  serverRole = getRuntimeProcessServerRole(envValues),
  severity,
  timestamp = new Date().toISOString(),
}: RuntimeLogEventInput & {envValues?: Record<string, string | undefined>}): RuntimeLogRecord => {
  return {attrs: attrs ?? {}, event, message, runtime: getRuntimeProcessLogIdentity({serverRole}), severity, timestamp}
}

export const installRuntimeJsonlSink = ({
  envValues = process.env,
}: {envValues?: Record<string, string | undefined>} = {}) => {
  const state = getRuntimeJsonlSinkState()
  const runtimeLogConfig = getRuntimeLogConfig({envValues})

  mkdirSync(runtimeLogConfig.logDir, {recursive: true})
  state.installed = true
  state.logDir = runtimeLogConfig.logDir
  state.logLevel = runtimeLogConfig.logLevel
  state.serverRole = getRuntimeProcessServerRole(envValues)

  return state
}

export const isRuntimeJsonlSinkInstalled = () => {
  return getRuntimeJsonlSinkState().installed
}

export const writeRuntimeLogEvent = (input: RuntimeLogEventInput) => {
  const state = getRuntimeJsonlSinkState()

  if (
    !state.installed
    || state.logDir === null
    || !shouldWriteRuntimeLogSeverity({configuredLevel: state.logLevel, severity: input.severity})
  ) {
    return false
  }

  const record = createRuntimeLogRecord({...input, serverRole: input.serverRole ?? state.serverRole})
  appendFileSync(
    getRuntimeLogFilePath({logDir: state.logDir, service: record.runtime.service, timestamp: record.timestamp}),
    getJsonLine(record),
    'utf8',
  )

  return true
}

export const resetRuntimeJsonlSinkForTests = () => {
  const state = getRuntimeJsonlSinkState()
  state.installed = false
  state.logDir = null
  state.logLevel = 'INFO'
  state.serverRole = undefined
}
