import {appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
  getRuntimeProcessLogIdentity,
  type RuntimeProcessIdentity,
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
  runtimeIdentity?: RuntimeProcessIdentity
  serverRole?: RuntimeProcessServerRole
  severity: RuntimeLogSeverity
  timestamp?: string
}

type RuntimeTerminalLogLevel = 'error' | 'log' | 'warn'

type RuntimeTerminalLogEventInput = RuntimeLogEventInput & {
  terminalArgs?: unknown[]
  terminalLevel?: RuntimeTerminalLogLevel
}

type RuntimeLogConfigOptions = {
  cwd?: string
  envValues?: Record<string, string | undefined>
  joinPath?: (...paths: string[]) => string
  runtimeWritableRoot?: string
}

type RuntimeJsonlSinkState = {
  activeDate: string | null
  fileMode: RuntimeLogFileMode
  flushTimeoutMs: number
  installed: boolean
  logDir: string | null
  logLevel: RuntimeLogLevel
  maxFileBytes: number
  serverRole: RuntimeProcessServerRole | undefined
}

type RuntimeLogFileMode = 'per-instance-file' | 'shared-file'
type RuntimeProcessWithFailureMonitor = typeof process & {
  on: (event: 'uncaughtExceptionMonitor', listener: (error: Error, origin: string) => void) => typeof process
}

const runtimeLogLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const
const runtimeLogProfiles = ['local', 'primary', 'secondary'] as const
const runtimeLogLevelWeights: Record<RuntimeLogLevel, number> = {DEBUG: 10, ERROR: 40, INFO: 20, WARN: 30}
const runtimeLogSharedFilePlatforms = ['darwin', 'linux'] as const
const runtimeLogRetentionDays = 7
const runtimeLogFlushTimeoutMs = 1_000
const runtimeLogDefaultMaxFileBytes = 100 * 1024 * 1024
const runtimeLogManagedFilePattern =
  /^(api-server|app-server|dev-single-server|judge-worker-server|maintenance-worker-server|single-server)-(\d{4}-\d{2}-\d{2})(?:-[A-Za-z0-9_.-]+)?\.jsonl$/

declare global {
  var __forskaRuntimeFailureHandlersInstalled: boolean | undefined
  var __forskaRuntimeJsonlSinkState: RuntimeJsonlSinkState | undefined
}

const getRuntimeJsonlSinkState = () => {
  globalThis.__forskaRuntimeJsonlSinkState ??= {
    activeDate: null,
    fileMode: 'shared-file',
    flushTimeoutMs: runtimeLogFlushTimeoutMs,
    installed: false,
    logDir: null,
    logLevel: 'INFO',
    maxFileBytes: runtimeLogDefaultMaxFileBytes,
    serverRole: undefined,
  }

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

const resolveRuntimeLogMaxFileBytes = (value: string | null | undefined) => {
  const parsedValue = Number.parseInt(getTrimmedValue(value) ?? '', 10)

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : runtimeLogDefaultMaxFileBytes
}

const getJsonlDateFromTimestamp = (timestamp: string) => {
  return timestamp.slice(0, 10)
}

const getUtcDateBefore = ({date, days}: {date: string; days: number}) => {
  const dateMs = Date.parse(`${date}T00:00:00.000Z`)
  return new Date(dateMs - days * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10)
}

const getRuntimeLogInstanceFileSuffix = (instanceId: string) => {
  return instanceId.replaceAll(/[^A-Za-z0-9_.-]/g, '_')
}

const isTestRuntime = (envValues: Record<string, string | undefined>) => {
  return getTrimmedValue(envValues.NODE_ENV)?.toLowerCase() === 'test'
}

const getDefaultTestRuntimeLogDir = ({
  envValues,
  joinPath,
  runtimeProfile,
}: {
  envValues: Record<string, string | undefined>
  joinPath: (...paths: string[]) => string
  runtimeProfile: RuntimeLogProfile
}) => {
  return joinPath(
    getTrimmedValue(envValues.FORSKA_TEST_LOG_ROOT) ?? tmpdir(),
    'forska-runtime-logs',
    String(process.pid),
    runtimeProfile,
  )
}

const getRuntimeLogFilePath = ({
  fileMode,
  instanceId,
  logDir,
  service,
  timestamp,
}: {
  fileMode: RuntimeLogFileMode
  instanceId: string
  logDir: string
  service: RuntimeProcessServiceName
  timestamp: string
}) => {
  const date = getJsonlDateFromTimestamp(timestamp)
  const suffix = fileMode === 'shared-file' ? '' : `-${getRuntimeLogInstanceFileSuffix(instanceId)}`

  return join(logDir, `${service}-${date}${suffix}.jsonl`)
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
    || normalizedValue === 'judge-worker'
    || normalizedValue === 'maintenance-worker'
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

const getRuntimeLogFileSizeBytes = (filePath: string) => {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

const ensureRuntimeLogFileBelowSizeCap = ({
  filePath,
  maxFileBytes,
  record,
}: {
  filePath: string
  maxFileBytes: number
  record: RuntimeLogRecord
}) => {
  const currentSizeBytes = getRuntimeLogFileSizeBytes(filePath)

  if (currentSizeBytes < maxFileBytes) {
    return
  }

  writeFileSync(
    filePath,
    getJsonLine({
      attrs: {currentSizeBytes, maxFileBytes},
      event: 'runtime.log.file-truncated',
      message: '[runtime] JSONL log file truncated after size cap',
      runtime: record.runtime,
      severity: 'WARN',
      timestamp: record.timestamp,
    }),
    'utf8',
  )
}

export const getRuntimeLogFileMode = ({platform = process.platform}: {platform?: string} = {}) => {
  const matchedPlatform = runtimeLogSharedFilePlatforms.find((item) => {
    return item === platform
  })

  return matchedPlatform === undefined ? 'per-instance-file' : 'shared-file'
}

export const pruneManagedRuntimeLogFiles = ({currentDate, logDir}: {currentDate: string; logDir: string}) => {
  const cutoffDate = getUtcDateBefore({date: currentDate, days: runtimeLogRetentionDays})

  return readdirSync(logDir, {withFileTypes: true}).reduce((deletedFiles, dirent) => {
    const match = dirent.isFile() ? runtimeLogManagedFilePattern.exec(dirent.name) : null
    const shouldDelete = match?.[2] !== undefined && match[2] < cutoffDate

    if (shouldDelete) {
      rmSync(join(logDir, dirent.name), {force: true})
    }

    return shouldDelete ? [...deletedFiles, dirent.name] : deletedFiles
  }, [] as string[])
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
  const defaultRuntimeLogDir = runtimeWritableRoot
    ? joinPath(runtimeWritableRoot, 'logs', 'runtime', runtimeProfile)
    : resolveRuntimeWritablePath({cwd, envValues, pathValue: join('logs', 'runtime', runtimeProfile)})

  return isTestRuntime(envValues)
    ? getDefaultTestRuntimeLogDir({envValues, joinPath, runtimeProfile})
    : defaultRuntimeLogDir
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
    maxFileBytes: resolveRuntimeLogMaxFileBytes(envValues.RUNTIME_LOG_MAX_BYTES),
    runtimeProfile,
  }
}

export const createRuntimeLogRecord = ({
  attrs,
  envValues = process.env,
  event,
  message,
  runtimeIdentity,
  serverRole = getRuntimeProcessServerRole(envValues),
  severity,
  timestamp = new Date().toISOString(),
}: RuntimeLogEventInput & {envValues?: Record<string, string | undefined>}): RuntimeLogRecord => {
  return {
    attrs: attrs ?? {},
    event,
    message,
    runtime: getRuntimeProcessLogIdentity({identity: runtimeIdentity, serverRole}),
    severity,
    timestamp,
  }
}

export const installRuntimeJsonlSink = ({
  envValues = process.env,
  platform = process.platform,
  timestamp = new Date().toISOString(),
}: {envValues?: Record<string, string | undefined>; platform?: string; timestamp?: string} = {}) => {
  const state = getRuntimeJsonlSinkState()
  const runtimeLogConfig = getRuntimeLogConfig({envValues})

  mkdirSync(runtimeLogConfig.logDir, {recursive: true})
  pruneManagedRuntimeLogFiles({currentDate: getJsonlDateFromTimestamp(timestamp), logDir: runtimeLogConfig.logDir})
  state.activeDate = getJsonlDateFromTimestamp(timestamp)
  state.fileMode = getRuntimeLogFileMode({platform})
  state.flushTimeoutMs = runtimeLogFlushTimeoutMs
  state.installed = true
  state.logDir = runtimeLogConfig.logDir
  state.logLevel = runtimeLogConfig.logLevel
  state.maxFileBytes = runtimeLogConfig.maxFileBytes
  state.serverRole = getRuntimeProcessServerRole(envValues)

  return state
}

export const isRuntimeJsonlSinkInstalled = () => {
  return getRuntimeJsonlSinkState().installed
}

const writeRuntimeLogEventToJsonl = ({force, input}: {force: boolean; input: RuntimeLogEventInput}) => {
  const state = getRuntimeJsonlSinkState()

  if (
    !state.installed
    || state.logDir === null
    || (!force && !shouldWriteRuntimeLogSeverity({configuredLevel: state.logLevel, severity: input.severity}))
  ) {
    return false
  }

  const record = createRuntimeLogRecord({...input, serverRole: input.serverRole ?? state.serverRole})
  const recordDate = getJsonlDateFromTimestamp(record.timestamp)

  if (state.activeDate !== recordDate) {
    pruneManagedRuntimeLogFiles({currentDate: recordDate, logDir: state.logDir})
    state.activeDate = recordDate
  }

  const logFilePath = getRuntimeLogFilePath({
    fileMode: state.fileMode,
    instanceId: record.runtime.instanceId,
    logDir: state.logDir,
    service: record.runtime.service,
    timestamp: record.timestamp,
  })

  ensureRuntimeLogFileBelowSizeCap({filePath: logFilePath, maxFileBytes: state.maxFileBytes, record})
  appendFileSync(logFilePath, getJsonLine(record), 'utf8')

  return true
}

export const writeRuntimeLogEvent = (input: RuntimeLogEventInput) => {
  return writeRuntimeLogEventToJsonl({force: false, input})
}

const getTerminalLevelForSeverity = (severity: RuntimeLogSeverity): RuntimeTerminalLogLevel => {
  const terminalLevels: Record<RuntimeLogSeverity, RuntimeTerminalLogLevel> = {
    DEBUG: 'log',
    ERROR: 'error',
    INFO: 'log',
    WARN: 'warn',
  }

  return terminalLevels[severity]
}

const writeRuntimeTerminalEvent = ({terminalArgs = [], terminalLevel, ...input}: RuntimeTerminalLogEventInput) => {
  const level = terminalLevel ?? getTerminalLevelForSeverity(input.severity)
  console[level](input.message, ...terminalArgs)
}

export const writeRuntimeOperatorLogEvent = (input: RuntimeTerminalLogEventInput) => {
  const jsonlWritten = writeRuntimeLogEventToJsonl({force: true, input})
  writeRuntimeTerminalEvent(input)

  return jsonlWritten
}

export const writeRuntimeFailureLogEvent = ({
  severity = 'ERROR',
  terminalLevel: _terminalLevel,
  ...input
}: Omit<RuntimeTerminalLogEventInput, 'severity'> & {severity?: RuntimeLogSeverity}) => {
  const eventInput = {...input, severity}
  const jsonlWritten = writeRuntimeLogEventToJsonl({force: true, input: eventInput})
  writeRuntimeTerminalEvent({...eventInput, terminalLevel: 'error'})

  return jsonlWritten
}

export const registerRuntimeFailureHandlers = () => {
  if (globalThis.__forskaRuntimeFailureHandlersInstalled) {
    return
  }

  globalThis.__forskaRuntimeFailureHandlersInstalled = true
  ;(process as RuntimeProcessWithFailureMonitor).on('uncaughtExceptionMonitor', (error, origin) => {
    writeRuntimeFailureLogEvent({
      attrs: {error, origin},
      event: 'runtime.failure.uncaught-exception',
      message: '[runtime] uncaught exception',
    })
  })
  process.on('unhandledRejection', (reason) => {
    writeRuntimeFailureLogEvent({
      attrs: {reason},
      event: 'runtime.failure.unhandled-rejection',
      message: '[runtime] unhandled promise rejection',
    })
  })
}

export const flushRuntimeLogs = async ({
  timeoutMs = getRuntimeJsonlSinkState().flushTimeoutMs,
}: {timeoutMs?: number} = {}) => {
  const flush = Promise.resolve(true)
  const timeout = new Promise<false>((resolve) => {
    setTimeout(() => {
      resolve(false)
    }, timeoutMs).unref()
  })

  return Promise.race([flush, timeout])
}

export const exitWithRuntimeLogFlush = async ({code, timeoutMs}: {code: number; timeoutMs?: number}) => {
  await flushRuntimeLogs({timeoutMs})
  process.exit(code)
}

export const resetRuntimeJsonlSinkForTests = () => {
  const state = getRuntimeJsonlSinkState()
  state.activeDate = null
  state.fileMode = 'shared-file'
  state.flushTimeoutMs = runtimeLogFlushTimeoutMs
  state.installed = false
  state.logDir = null
  state.logLevel = 'INFO'
  state.maxFileBytes = runtimeLogDefaultMaxFileBytes
  state.serverRole = undefined
}
