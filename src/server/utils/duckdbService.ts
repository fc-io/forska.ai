import {randomUUID} from 'node:crypto'
import {mkdirSync} from 'node:fs'
import {access, copyFile, mkdir, rm} from 'node:fs/promises'
import {availableParallelism, tmpdir} from 'node:os'
import {basename, join} from 'node:path'

import {DuckDBConnection, DuckDBInstance, type DuckDBType, type DuckDBValue} from '@duckdb/node-api'
import {Effect} from 'effect'

import {parseDuckdbMemoryLimitToMiB} from './duckdbMemoryLimit.ts'
import {getEnv} from './env.ts'
import {ensureDuckdbPathDirectory} from './getDuckdbPath.ts'
import {exitWithRuntimeLogFlush, writeRuntimeFailureLogEvent, writeRuntimeOperatorLogEvent} from './runtimeLogger.ts'
import {
  ensureCurrentDuckdbOwnerLease,
  registerDuckdbOwnerDemotionHandler,
  releaseCurrentDuckdbOwnerLease,
} from './serverRuntimeRole.ts'

type DuckdbRuntimeConfig = {
  appendLaneCount: number
  binary: string
  databasePath: string
  memoryLimit: string
  preserveInsertionOrder: boolean
  serializeConcurrentWork: boolean
  tempDirectory: string | null
  threads: string
}
export type DuckdbSnapshot = {createdAt: string; snapshotPath: string}
export type DuckdbAppendRuntimeMetrics = {
  batchesCompleted: number
  batchesStarted: number
  laneCount: number
  lastDurationMs: number | null
  maxQueueDepth: number
  maxQueueDepthByLane: number[]
  queueDepth: number
  queueDepthByLane: number[]
  totalDurationMs: number
}
type DuckdbSingleQueueRuntimeMetrics = {
  lastDurationMs: number | null
  lastWaitMs: number | null
  maxQueueDepth: number
  queueDepth: number
  tasksCompleted: number
  tasksStarted: number
  totalDurationMs: number
  totalWaitMs: number
}
export type DuckdbQueueRuntimeMetrics = {
  background: DuckdbSingleQueueRuntimeMetrics
  main: DuckdbSingleQueueRuntimeMetrics
}
export type DuckdbBackgroundRuntimeDiagnostics = {
  configured: DuckdbRuntimeConfig
  effective: {
    memoryLimit: string | null
    preserveInsertionOrder: boolean | null
    tempDirectory: string | null
    threads: string | null
  }
  instanceOptions: Record<string, string>
  queues: DuckdbQueueRuntimeMetrics
}
type DuckdbTransactionRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}
type DuckdbAppendBarrier = {promise: Promise<void>; resolve: () => void}
type DuckdbBoundValues = DuckDBValue[] | Record<string, DuckDBValue>
type DuckdbBoundTypes = DuckDBType[] | Record<string, DuckDBType | undefined>

type DuckdbServiceState = {
  appendBarrier: DuckdbAppendBarrier | null
  appendConnections: DuckDBConnection[]
  appendLastDurationMs: number | null
  appendMaxQueueDepthByLane: number[]
  appendPendingCountByLane: number[]
  appendQueues: Promise<void>[]
  appendTotalBatchesCompleted: number
  appendTotalBatchesStarted: number
  appendTotalDurationMs: number
  backgroundConnection: DuckDBConnection | null
  backgroundLastDurationMs: number | null
  backgroundLastWaitMs: number | null
  backgroundMaxQueueDepth: number
  backgroundPendingCount: number
  backgroundQueue: Promise<void>
  backgroundTasksCompleted: number
  backgroundTasksStarted: number
  backgroundTotalDurationMs: number
  backgroundTotalWaitMs: number
  controlConnection: DuckDBConnection | null
  duckdbInstance: DuckDBInstance | null
  duckdbLastDurationMs: number | null
  duckdbLastWaitMs: number | null
  duckdbMaxQueueDepth: number
  duckdbPendingCount: number
  duckdbQueue: Promise<void>
  duckdbRuntimeConfig: DuckdbRuntimeConfig | null
  duckdbTasksCompleted: number
  duckdbTasksStarted: number
  duckdbTotalDurationMs: number
  duckdbTotalWaitMs: number
  nextAppendLaneIndex: number
  shutdownHooksRegistered: boolean
  startupPromise: Promise<DuckDBConnection> | null
}

type EffectFiberFailure = {
  error?: {cause?: unknown; error?: unknown; message?: string}
  failure?: {cause?: unknown; error?: unknown; message?: string}
}

const duckdbStartupRetryableErrorFragments = [
  'Failure while replaying WAL file',
  'Calling DatabaseManager::GetDefaultDatabase with no default database set',
]
const duckdbAbortedTransactionErrorFragments = ['Current transaction is aborted']
const duckdbRestartRequiredErrorFragments = [
  'database has been invalidated because of a previous fatal error',
  'must be restarted prior to being used again',
]

declare global {
  var __forskaDuckdbServiceState: DuckdbServiceState | undefined
}

const duckdbSnapshotDirectory = join(tmpdir(), 'forska-duckdb-studio')
const getDuckdbAppendLaneCountValue = () => {
  return Math.max(1, Number(getEnv().DUCKDB_APPEND_LANE_COUNT ?? 2))
}

const getInitialDuckdbAppendQueues = (appendLaneCount: number) => {
  return Array.from({length: appendLaneCount}, () => {
    return Promise.resolve()
  })
}

const getInitialDuckdbAppendLaneMetrics = (appendLaneCount: number) => {
  return Array.from({length: appendLaneCount}, () => {
    return 0
  })
}

const getDuckdbServiceState = () => {
  globalThis.__forskaDuckdbServiceState ??= {
    appendBarrier: null,
    appendConnections: [],
    appendLastDurationMs: null,
    appendMaxQueueDepthByLane: getInitialDuckdbAppendLaneMetrics(getDuckdbAppendLaneCountValue()),
    appendPendingCountByLane: getInitialDuckdbAppendLaneMetrics(getDuckdbAppendLaneCountValue()),
    appendQueues: getInitialDuckdbAppendQueues(getDuckdbAppendLaneCountValue()),
    appendTotalBatchesCompleted: 0,
    appendTotalBatchesStarted: 0,
    appendTotalDurationMs: 0,
    backgroundConnection: null,
    backgroundLastDurationMs: null,
    backgroundLastWaitMs: null,
    backgroundMaxQueueDepth: 0,
    backgroundPendingCount: 0,
    backgroundQueue: Promise.resolve(),
    backgroundTasksCompleted: 0,
    backgroundTasksStarted: 0,
    backgroundTotalDurationMs: 0,
    backgroundTotalWaitMs: 0,
    controlConnection: null,
    duckdbInstance: null,
    duckdbLastDurationMs: null,
    duckdbLastWaitMs: null,
    duckdbMaxQueueDepth: 0,
    duckdbPendingCount: 0,
    duckdbQueue: Promise.resolve(),
    duckdbRuntimeConfig: null,
    duckdbTasksCompleted: 0,
    duckdbTasksStarted: 0,
    duckdbTotalDurationMs: 0,
    duckdbTotalWaitMs: 0,
    nextAppendLaneIndex: 0,
    shutdownHooksRegistered: false,
    startupPromise: null,
  }

  return globalThis.__forskaDuckdbServiceState
}

const duckdbServiceState = getDuckdbServiceState()

const getTrimmedValue = (value: string | null | undefined) => {
  const normalized = String(value ?? '').trim()
  return normalized === '' ? null : normalized
}

const getDuckdbThreadCountValue = (memoryLimit: string) => {
  const memoryLimitMiB = parseDuckdbMemoryLimitToMiB(memoryLimit)

  if (memoryLimitMiB !== null && memoryLimitMiB <= 6400) {
    return '1'
  }

  const memoryBoundThreadCount =
    memoryLimitMiB === null || memoryLimitMiB > 8192 ? 8 : memoryLimitMiB > 4096 ? 4 : memoryLimitMiB > 2048 ? 2 : 1

  return String(Math.max(1, Math.min(availableParallelism(), memoryBoundThreadCount)))
}

const shouldSerializeDuckdbConcurrentWork = (memoryLimit: string) => {
  const memoryLimitMiB = parseDuckdbMemoryLimitToMiB(memoryLimit)
  return memoryLimitMiB !== null && memoryLimitMiB <= 6400
}

const getDuckdbRuntimeConfigValue = () => {
  if (duckdbServiceState.duckdbRuntimeConfig) {
    return duckdbServiceState.duckdbRuntimeConfig
  }

  const env = getEnv()

  duckdbServiceState.duckdbRuntimeConfig = {
    appendLaneCount: getDuckdbAppendLaneCountValue(),
    binary: '@duckdb/node-api',
    databasePath: env.DUCKDB_PATH,
    memoryLimit: env.DUCKDB_MEMORY_LIMIT,
    preserveInsertionOrder: false,
    serializeConcurrentWork: shouldSerializeDuckdbConcurrentWork(env.DUCKDB_MEMORY_LIMIT),
    tempDirectory: getTrimmedValue(env.DUCKDB_TEMP_DIRECTORY),
    threads: getDuckdbThreadCountValue(env.DUCKDB_MEMORY_LIMIT),
  }

  return duckdbServiceState.duckdbRuntimeConfig
}

const ensureDuckdbRuntimeDirectories = (runtimeConfig: DuckdbRuntimeConfig) => {
  ensureDuckdbPathDirectory(runtimeConfig.databasePath)
  return runtimeConfig.tempDirectory === null ? runtimeConfig : createDuckdbTempDirectory(runtimeConfig)
}

const createDuckdbTempDirectory = (runtimeConfig: DuckdbRuntimeConfig) => {
  mkdirSync(runtimeConfig.tempDirectory ?? '', {recursive: true})
  return runtimeConfig
}

const getDuckdbInstanceOptions = (runtimeConfig: DuckdbRuntimeConfig): Record<string, string> => {
  return runtimeConfig.tempDirectory === null
    ? {
        memory_limit: runtimeConfig.memoryLimit,
        preserve_insertion_order: String(runtimeConfig.preserveInsertionOrder),
        threads: runtimeConfig.threads,
      }
    : {
        memory_limit: runtimeConfig.memoryLimit,
        preserve_insertion_order: String(runtimeConfig.preserveInsertionOrder),
        temp_directory: runtimeConfig.tempDirectory,
        threads: runtimeConfig.threads,
      }
}

const getErrorMessage = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Error) {
    return value.message
  }

  return typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string'
    ? value.message
    : null
}

const getEffectFiberFailure = (value: unknown): EffectFiberFailure | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const causeSymbol = Object.getOwnPropertySymbols(value).find((symbol) => {
    return String(symbol) === 'Symbol(effect/Runtime/FiberFailure/Cause)'
  })

  return causeSymbol === undefined ? null : ((value as Record<PropertyKey, unknown>)[causeSymbol] as EffectFiberFailure)
}

const getEffectFailureMessage = (value: unknown): string | null => {
  const fiberFailure = getEffectFiberFailure(value)
  const failure = fiberFailure?.error ?? fiberFailure?.failure

  return getErrorMessage(failure?.cause) ?? getErrorMessage(failure?.error) ?? getErrorMessage(failure?.message)
}

const getNormalizedDuckdbError = (error: unknown): Error => {
  if (error instanceof Error) {
    const effectFailureMessage = getEffectFailureMessage(error)
    const combinedMessage =
      effectFailureMessage !== null && effectFailureMessage !== error.message
        ? `${error.message} -- ${effectFailureMessage}`
        : error.message

    return combinedMessage === error.message ? error : new Error(combinedMessage)
  }

  return new Error(getErrorMessage(error) ?? String(error))
}

const getChainedDuckdbError = (error: unknown, nextError: unknown, context: string): Error => {
  const normalizedError = getNormalizedDuckdbError(error)
  const normalizedNextError = getNormalizedDuckdbError(nextError)
  const combinedMessage =
    normalizedNextError.message === normalizedError.message
      ? normalizedError.message
      : `${normalizedError.message} -- ${context}: ${normalizedNextError.message}`

  return combinedMessage === normalizedError.message ? normalizedError : new Error(combinedMessage)
}

let duckdbFatalRecoveryPromise: Promise<void> | null = null

const isDuckdbRestartRequiredError = (error: unknown) => {
  const message = getNormalizedDuckdbError(error).message

  return duckdbRestartRequiredErrorFragments.some((fragment) => {
    return message.includes(fragment)
  })
}

const isDuckdbAbortedTransactionError = (error: unknown) => {
  const message = getNormalizedDuckdbError(error).message

  return duckdbAbortedTransactionErrorFragments.some((fragment) => {
    return message.includes(fragment)
  })
}

const getCompactDuckdbErrorMessage = (error: unknown) => {
  const message = getNormalizedDuckdbError(error).message.replace(/\s+/g, ' ').trim()
  return message.length <= 280 ? message : `${message.slice(0, 277)}...`
}

const getDuckdbStatementPreview = (statement: string) => {
  const normalizedStatement = statement.replace(/\s+/g, ' ').trim()
  return normalizedStatement.length <= 280 ? normalizedStatement : `${normalizedStatement.slice(0, 277)}...`
}

const getDuckdbErrorWithStatementContext = (error: unknown, label: string, statement: string) => {
  const normalizedError = getNormalizedDuckdbError(error)
  const statementContext = `${label}: ${getDuckdbStatementPreview(statement)}`

  return normalizedError.message.includes(statementContext)
    ? normalizedError
    : new Error(`${normalizedError.message} -- ${statementContext}`)
}

const withDuckdbStatementErrorContext = async <T>({
  label,
  statement,
  work,
}: {
  label: string
  statement: string
  work: () => Promise<T>
}): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    throw getDuckdbErrorWithStatementContext(error, label, statement)
  }
}

const recoverDuckdbRuntimeAfterFatalError = async (error: unknown) => {
  if (duckdbFatalRecoveryPromise !== null) {
    return duckdbFatalRecoveryPromise
  }

  writeRuntimeOperatorLogEvent({
    attrs: {error},
    event: 'duckdb.recovery.restart',
    message: '[duckdb] restarting embedded runtime after fatal invalidation',
    severity: 'WARN',
    terminalArgs: [getCompactDuckdbErrorMessage(error)],
  })

  duckdbFatalRecoveryPromise = closeDuckdbServiceDirect()
    .catch((closeError) => {
      writeRuntimeFailureLogEvent({
        attrs: {closeError},
        event: 'duckdb.recovery.close-failure',
        message: '[duckdb] failed to close embedded runtime during fatal recovery',
        severity: 'ERROR',
        terminalArgs: [closeError],
      })
    })
    .finally(() => {
      duckdbFatalRecoveryPromise = null
    })

  return duckdbFatalRecoveryPromise
}

const isDuckdbStartupRetryableError = (error: unknown) => {
  const message = getNormalizedDuckdbError(error).message

  return duckdbStartupRetryableErrorFragments.some((fragment) => {
    return message.includes(fragment)
  })
}

const withNormalizedDuckdbError = async <T>(work: () => Promise<T>, canRetryAfterRestart = true): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    const normalizedError = getNormalizedDuckdbError(error)

    if (!canRetryAfterRestart || !isDuckdbRestartRequiredError(normalizedError)) {
      throw normalizedError
    }

    await recoverDuckdbRuntimeAfterFatalError(normalizedError)

    try {
      return await work()
    } catch (retryError) {
      throw getChainedDuckdbError(normalizedError, retryError, 'restart retry failed')
    }
  }
}

const resetDuckdbRuntimeState = () => {
  const appendLaneCount = getDuckdbRuntimeConfigValue().appendLaneCount

  duckdbServiceState.appendBarrier = null
  duckdbServiceState.appendConnections = []
  duckdbServiceState.appendLastDurationMs = null
  duckdbServiceState.appendMaxQueueDepthByLane = getInitialDuckdbAppendLaneMetrics(appendLaneCount)
  duckdbServiceState.appendPendingCountByLane = getInitialDuckdbAppendLaneMetrics(appendLaneCount)
  duckdbServiceState.appendQueues = getInitialDuckdbAppendQueues(appendLaneCount)
  duckdbServiceState.appendTotalBatchesCompleted = 0
  duckdbServiceState.appendTotalBatchesStarted = 0
  duckdbServiceState.appendTotalDurationMs = 0
  duckdbServiceState.backgroundConnection = null
  duckdbServiceState.backgroundLastDurationMs = null
  duckdbServiceState.backgroundLastWaitMs = null
  duckdbServiceState.backgroundMaxQueueDepth = 0
  duckdbServiceState.backgroundPendingCount = 0
  duckdbServiceState.backgroundQueue = Promise.resolve()
  duckdbServiceState.backgroundTasksCompleted = 0
  duckdbServiceState.backgroundTasksStarted = 0
  duckdbServiceState.backgroundTotalDurationMs = 0
  duckdbServiceState.backgroundTotalWaitMs = 0
  duckdbServiceState.controlConnection = null
  duckdbServiceState.duckdbInstance = null
  duckdbServiceState.duckdbLastDurationMs = null
  duckdbServiceState.duckdbLastWaitMs = null
  duckdbServiceState.duckdbMaxQueueDepth = 0
  duckdbServiceState.duckdbPendingCount = 0
  duckdbServiceState.duckdbQueue = Promise.resolve()
  duckdbServiceState.duckdbRuntimeConfig = null
  duckdbServiceState.duckdbTasksCompleted = 0
  duckdbServiceState.duckdbTasksStarted = 0
  duckdbServiceState.duckdbTotalDurationMs = 0
  duckdbServiceState.duckdbTotalWaitMs = 0
  duckdbServiceState.nextAppendLaneIndex = 0
  duckdbServiceState.startupPromise = null
}

const getDuckdbConnection = () => {
  if (duckdbServiceState.controlConnection === null) {
    throw new Error('DuckDB connection not started')
  }

  return duckdbServiceState.controlConnection
}

const getDuckdbAppendConnection = (laneIndex: number) => {
  const appendConnection = duckdbServiceState.appendConnections[laneIndex]

  if (appendConnection === undefined) {
    throw new Error(`DuckDB append lane ${laneIndex} not started`)
  }

  return appendConnection
}

const getDuckdbBackgroundConnection = () => {
  if (duckdbServiceState.backgroundConnection === null) {
    throw new Error('DuckDB background connection not started')
  }

  return duckdbServiceState.backgroundConnection
}

const createDuckdbAppendBarrier = (): DuckdbAppendBarrier => {
  let resolve: DuckdbAppendBarrier['resolve'] = () => {
    return undefined
  }
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })

  return {promise, resolve}
}

const waitForDuckdbAppendBarrier = async (): Promise<void> => {
  const currentBarrier = duckdbServiceState.appendBarrier

  return currentBarrier === null
    ? undefined
    : currentBarrier.promise.then(() => {
        return waitForDuckdbAppendBarrier()
      })
}

const getDuckdbAppendQueueSnapshot = () => {
  return [...duckdbServiceState.appendQueues]
}

const waitForDuckdbAppendQueues = async (): Promise<void> => {
  await Promise.all(getDuckdbAppendQueueSnapshot())
}

const waitForDuckdbBackgroundQueue = async (): Promise<void> => {
  await duckdbServiceState.backgroundQueue
}

const withDuckdbAppendBarrier = async <T>(work: () => Promise<T>): Promise<T> => {
  const appendBarrier = createDuckdbAppendBarrier()
  duckdbServiceState.appendBarrier = appendBarrier

  try {
    await waitForDuckdbAppendQueues()
    await waitForDuckdbBackgroundQueue()
    return await work()
  } finally {
    duckdbServiceState.appendBarrier =
      duckdbServiceState.appendBarrier === appendBarrier ? null : duckdbServiceState.appendBarrier
    appendBarrier.resolve()
  }
}

const getCloseSyncError = (close: (() => void) | null) => {
  if (close === null) {
    return null
  }

  try {
    close()
    return null
  } catch (error) {
    return getNormalizedDuckdbError(error)
  }
}

const getCombinedCloseError = (errors: Array<Error | null>): Error | null => {
  const [firstError, secondError, ...remainingErrors] = errors.filter((error): error is Error => {
    return error !== null
  })

  return firstError === undefined
    ? null
    : secondError === undefined
      ? firstError
      : getCombinedCloseError([getChainedDuckdbError(firstError, secondError, 'close failed'), ...remainingErrors])
}

const getAppendConnectionCloseErrors = (appendConnections: DuckDBConnection[]): Array<Error | null> => {
  return appendConnections.map((appendConnection) => {
    return getCloseSyncError(() => {
      appendConnection.interrupt()
      appendConnection.closeSync()
    })
  })
}

const closeDuckdbServiceWithoutBarrier = async () => {
  const activeConnection = duckdbServiceState.controlConnection
  const activeAppendConnections = [...duckdbServiceState.appendConnections]
  const activeBackgroundConnection = duckdbServiceState.backgroundConnection
  const activeInstance = duckdbServiceState.duckdbInstance

  resetDuckdbRuntimeState()

  const closeError = getCombinedCloseError([
    getCloseSyncError(
      activeConnection === null
        ? null
        : () => {
            activeConnection.interrupt()
            activeConnection.closeSync()
          },
    ),
    ...getAppendConnectionCloseErrors(activeAppendConnections),
    getCloseSyncError(
      activeBackgroundConnection === null
        ? null
        : () => {
            activeBackgroundConnection.interrupt()
            activeBackgroundConnection.closeSync()
          },
    ),
    getCloseSyncError(
      activeInstance === null
        ? null
        : () => {
            activeInstance.closeSync()
          },
    ),
  ])

  try {
    await releaseCurrentDuckdbOwnerLease()
  } catch (error) {
    throw closeError === null ? error : getChainedDuckdbError(closeError, error, 'lease release failed')
  }

  if (closeError !== null) {
    throw closeError
  }
}

const closeDuckdbServiceDirect = async () => {
  return withDuckdbAppendBarrier(closeDuckdbServiceWithoutBarrier)
}

const closeDuckdbServiceForSignal = async () => {
  return closeDuckdbServiceWithoutBarrier()
}

const registerDuckdbShutdownHooks = () => {
  if (duckdbServiceState.shutdownHooksRegistered) {
    return
  }

  duckdbServiceState.shutdownHooksRegistered = true
  ;(['SIGINT', 'SIGTERM'] as const).map((signal) => {
    process.once(signal, () => {
      void closeDuckdbServiceForSignal().then(
        () => {
          void exitWithRuntimeLogFlush({code: 0})
        },
        (error) => {
          writeRuntimeFailureLogEvent({
            attrs: {error, signal},
            event: 'duckdb.shutdown.failure',
            message: `[duckdb] shutdown failed on ${signal}`,
            terminalArgs: [error],
          })
          void exitWithRuntimeLogFlush({code: 1})
        },
      )
    })
  })
}

const createDuckdbInstance = async (runtimeConfig: DuckdbRuntimeConfig) => {
  return DuckDBInstance.create(runtimeConfig.databasePath, getDuckdbInstanceOptions(runtimeConfig))
}

const cleanupFailedDuckdbStart = async (params: {
  appendConnections: DuckDBConnection[]
  backgroundConnection: DuckDBConnection | null
  controlConnection: DuckDBConnection | null
  duckdbInstance: DuckDBInstance | null
}) => {
  const closeError = getCombinedCloseError([
    getCloseSyncError(
      params.controlConnection === null
        ? null
        : () => {
            const controlConnection = params.controlConnection

            if (controlConnection === null) {
              return
            }

            controlConnection.closeSync()
          },
    ),
    ...getAppendConnectionCloseErrors(params.appendConnections),
    getCloseSyncError(
      params.backgroundConnection === null
        ? null
        : () => {
            const backgroundConnection = params.backgroundConnection

            if (backgroundConnection === null) {
              return
            }

            backgroundConnection.closeSync()
          },
    ),
    getCloseSyncError(
      params.duckdbInstance === null
        ? null
        : () => {
            const duckdbInstance = params.duckdbInstance

            if (duckdbInstance === null) {
              return
            }

            duckdbInstance.closeSync()
          },
    ),
  ])

  if (closeError !== null) {
    writeRuntimeFailureLogEvent({
      attrs: {closeError},
      event: 'duckdb.startup.cleanup-failure',
      message: '[duckdb] failed to clean up embedded runtime',
      terminalArgs: [closeError],
    })
  }

  try {
    await releaseCurrentDuckdbOwnerLease()
  } catch (error) {
    resetDuckdbRuntimeState()
    return closeError === null
      ? getNormalizedDuckdbError(error)
      : getChainedDuckdbError(closeError, error, 'lease release failed')
  }

  resetDuckdbRuntimeState()
  return closeError
}

const startDuckdbProcess = async (): Promise<DuckDBConnection> => {
  const appendLaneCount = getDuckdbRuntimeConfigValue().appendLaneCount

  if (
    duckdbServiceState.controlConnection
    && duckdbServiceState.duckdbInstance
    && duckdbServiceState.appendConnections.length === appendLaneCount
  ) {
    return duckdbServiceState.controlConnection
  }

  const runtimeConfig = ensureDuckdbRuntimeDirectories(getDuckdbRuntimeConfigValue())
  let appendConnections: DuckDBConnection[] = []
  let backgroundConnection: DuckDBConnection | null = null
  let controlConnection: DuckDBConnection | null = null
  let duckdbInstance: DuckDBInstance | null = null

  const createAppendConnections = async (remainingCount: number): Promise<void> => {
    if (remainingCount === 0) {
      return
    }

    if (duckdbInstance === null) {
      throw new Error('DuckDB instance not started')
    }

    const nextAppendConnection = await duckdbInstance.connect()
    appendConnections = [...appendConnections, nextAppendConnection]
    return createAppendConnections(remainingCount - 1)
  }

  await ensureCurrentDuckdbOwnerLease()

  try {
    duckdbInstance = await createDuckdbInstance(runtimeConfig)
    controlConnection = await duckdbInstance.connect()
    await createAppendConnections(appendLaneCount)
    backgroundConnection = await duckdbInstance.connect()

    duckdbServiceState.appendConnections = appendConnections
    duckdbServiceState.appendQueues = getInitialDuckdbAppendQueues(appendLaneCount)
    duckdbServiceState.appendPendingCountByLane = getInitialDuckdbAppendLaneMetrics(appendLaneCount)
    duckdbServiceState.appendMaxQueueDepthByLane = getInitialDuckdbAppendLaneMetrics(appendLaneCount)
    duckdbServiceState.backgroundConnection = backgroundConnection
    duckdbServiceState.backgroundQueue = Promise.resolve()
    duckdbServiceState.controlConnection = controlConnection
    duckdbServiceState.duckdbInstance = duckdbInstance
    duckdbServiceState.nextAppendLaneIndex = 0
    registerDuckdbShutdownHooks()

    return controlConnection
  } catch (error) {
    const cleanupError = await cleanupFailedDuckdbStart({
      appendConnections,
      backgroundConnection,
      controlConnection,
      duckdbInstance,
    })
    throw cleanupError === null ? error : getChainedDuckdbError(error, cleanupError, 'startup cleanup failed')
  }
}

const ensureStartedDuckdbProcess = async () => {
  const appendLaneCount = getDuckdbRuntimeConfigValue().appendLaneCount

  if (
    duckdbServiceState.backgroundConnection
    && duckdbServiceState.controlConnection
    && duckdbServiceState.duckdbInstance
    && duckdbServiceState.appendConnections.length === appendLaneCount
  ) {
    return duckdbServiceState.controlConnection
  }

  if (duckdbServiceState.startupPromise !== null) {
    return duckdbServiceState.startupPromise
  }

  duckdbServiceState.startupPromise = startDuckdbProcess()
    .catch(async (error) => {
      if (!isDuckdbStartupRetryableError(error)) {
        throw error
      }

      writeRuntimeFailureLogEvent({
        attrs: {error},
        event: 'duckdb.startup.retry',
        message: '[duckdb] retrying startup after recoverable initialization failure',
        severity: 'WARN',
        terminalArgs: [error],
      })
      return startDuckdbProcess()
    })
    .finally(() => {
      duckdbServiceState.startupPromise = null
    })

  return duckdbServiceState.startupPromise
}

const enqueueDuckdbWork = async <T>(work: () => Promise<T>): Promise<T> => {
  const queuedAtMs = Date.now()
  duckdbServiceState.duckdbPendingCount += 1
  duckdbServiceState.duckdbMaxQueueDepth = Math.max(
    duckdbServiceState.duckdbMaxQueueDepth,
    duckdbServiceState.duckdbPendingCount,
  )
  const queuedWork = duckdbServiceState.duckdbQueue.then(async () => {
    const startedAtMs = Date.now()
    const waitMs = startedAtMs - queuedAtMs
    duckdbServiceState.duckdbLastWaitMs = waitMs
    duckdbServiceState.duckdbTasksStarted += 1
    duckdbServiceState.duckdbTotalWaitMs += waitMs

    try {
      return await work()
    } finally {
      const durationMs = Date.now() - startedAtMs
      duckdbServiceState.duckdbLastDurationMs = durationMs
      duckdbServiceState.duckdbTasksCompleted += 1
      duckdbServiceState.duckdbTotalDurationMs += durationMs
    }
  })
  duckdbServiceState.duckdbQueue = queuedWork.then(
    () => {
      duckdbServiceState.duckdbPendingCount = Math.max(0, duckdbServiceState.duckdbPendingCount - 1)
      return undefined
    },
    () => {
      duckdbServiceState.duckdbPendingCount = Math.max(0, duckdbServiceState.duckdbPendingCount - 1)
      return undefined
    },
  )
  return queuedWork
}

const enqueueDuckdbBackgroundWork = async <T>(work: () => Promise<T>): Promise<T> => {
  const queuedAtMs = Date.now()
  duckdbServiceState.backgroundPendingCount += 1
  duckdbServiceState.backgroundMaxQueueDepth = Math.max(
    duckdbServiceState.backgroundMaxQueueDepth,
    duckdbServiceState.backgroundPendingCount,
  )
  const queuedWork = duckdbServiceState.backgroundQueue.then(async () => {
    const startedAtMs = Date.now()
    const waitMs = startedAtMs - queuedAtMs
    duckdbServiceState.backgroundLastWaitMs = waitMs
    duckdbServiceState.backgroundTasksStarted += 1
    duckdbServiceState.backgroundTotalWaitMs += waitMs

    try {
      return await work()
    } finally {
      const durationMs = Date.now() - startedAtMs
      duckdbServiceState.backgroundLastDurationMs = durationMs
      duckdbServiceState.backgroundTasksCompleted += 1
      duckdbServiceState.backgroundTotalDurationMs += durationMs
    }
  })
  duckdbServiceState.backgroundQueue = queuedWork.then(
    () => {
      duckdbServiceState.backgroundPendingCount = Math.max(0, duckdbServiceState.backgroundPendingCount - 1)
      return undefined
    },
    () => {
      duckdbServiceState.backgroundPendingCount = Math.max(0, duckdbServiceState.backgroundPendingCount - 1)
      return undefined
    },
  )
  return queuedWork
}

const getDuckdbAppendQueueDepth = () => {
  return duckdbServiceState.appendPendingCountByLane.reduce((totalCount, currentCount) => {
    return totalCount + currentCount
  }, 0)
}

const incrementDuckdbAppendQueueDepth = (laneIndex: number) => {
  const nextQueueDepthByLane = duckdbServiceState.appendPendingCountByLane.map((currentCount, currentLaneIndex) => {
    return currentLaneIndex === laneIndex ? currentCount + 1 : currentCount
  })

  duckdbServiceState.appendPendingCountByLane = nextQueueDepthByLane
  duckdbServiceState.appendMaxQueueDepthByLane = duckdbServiceState.appendMaxQueueDepthByLane.map(
    (currentCount, currentLaneIndex) => {
      const nextLaneCount = nextQueueDepthByLane[currentLaneIndex] ?? 0
      return currentCount > nextLaneCount ? currentCount : nextLaneCount
    },
  )
}

const decrementDuckdbAppendQueueDepth = (laneIndex: number) => {
  duckdbServiceState.appendPendingCountByLane = duckdbServiceState.appendPendingCountByLane.map(
    (currentCount, currentLaneIndex) => {
      return currentLaneIndex === laneIndex ? Math.max(0, currentCount - 1) : currentCount
    },
  )
}

const recordDuckdbAppendBatchStart = () => {
  duckdbServiceState.appendTotalBatchesStarted += 1
}

const recordDuckdbAppendBatchCompletion = (durationMs: number) => {
  duckdbServiceState.appendLastDurationMs = durationMs
  duckdbServiceState.appendTotalBatchesCompleted += 1
  duckdbServiceState.appendTotalDurationMs += durationMs
}

const getNextDuckdbAppendLaneIndex = () => {
  const appendLaneCount = duckdbServiceState.appendConnections.length

  if (appendLaneCount === 0) {
    throw new Error('DuckDB append lanes not started')
  }

  const nextLaneIndex = duckdbServiceState.nextAppendLaneIndex % appendLaneCount
  duckdbServiceState.nextAppendLaneIndex = (nextLaneIndex + 1) % appendLaneCount
  return nextLaneIndex
}

const enqueueDuckdbAppendLaneWork = async <T>(
  laneIndex: number,
  work: (appendConnection: DuckDBConnection) => Promise<T>,
): Promise<T> => {
  incrementDuckdbAppendQueueDepth(laneIndex)
  const appendQueue = duckdbServiceState.appendQueues[laneIndex] ?? Promise.resolve()
  const queuedWork = appendQueue.then(async () => {
    const startedAtMs = Date.now()

    recordDuckdbAppendBatchStart()

    try {
      return await work(getDuckdbAppendConnection(laneIndex))
    } finally {
      recordDuckdbAppendBatchCompletion(Date.now() - startedAtMs)
    }
  })

  duckdbServiceState.appendQueues[laneIndex] = queuedWork.then(
    () => {
      decrementDuckdbAppendQueueDepth(laneIndex)
      return undefined
    },
    () => {
      decrementDuckdbAppendQueueDepth(laneIndex)
      return undefined
    },
  )

  return queuedWork
}

type DuckdbStatementSplitState = {buffer: string; inDouble: boolean; inSingle: boolean; statements: string[]}

const appendDuckdbStatementBuffer = (state: DuckdbStatementSplitState, value: string): DuckdbStatementSplitState => {
  return {...state, buffer: `${state.buffer}${value}`}
}

const flushDuckdbStatementBuffer = (state: DuckdbStatementSplitState): DuckdbStatementSplitState => {
  const trimmedStatement = state.buffer.trim()

  return trimmedStatement === ''
    ? {...state, buffer: ''}
    : {...state, buffer: '', statements: [...state.statements, trimmedStatement]}
}

const splitDuckdbStatementsStep = (
  sql: string,
  index: number,
  state: DuckdbStatementSplitState,
): DuckdbStatementSplitState => {
  if (index >= sql.length) {
    return flushDuckdbStatementBuffer(state)
  }

  const currentCharacter = sql[index] ?? ''
  const nextCharacter = sql[index + 1] ?? ''

  if (currentCharacter === "'" && state.inSingle && nextCharacter === "'") {
    return splitDuckdbStatementsStep(sql, index + 2, appendDuckdbStatementBuffer(state, "''"))
  }

  if (currentCharacter === '"' && state.inDouble && nextCharacter === '"') {
    return splitDuckdbStatementsStep(sql, index + 2, appendDuckdbStatementBuffer(state, '""'))
  }

  if (currentCharacter === "'" && !state.inDouble) {
    return splitDuckdbStatementsStep(sql, index + 1, {
      ...appendDuckdbStatementBuffer(state, currentCharacter),
      inSingle: !state.inSingle,
    })
  }

  if (currentCharacter === '"' && !state.inSingle) {
    return splitDuckdbStatementsStep(sql, index + 1, {
      ...appendDuckdbStatementBuffer(state, currentCharacter),
      inDouble: !state.inDouble,
    })
  }

  return currentCharacter === ';' && !state.inSingle && !state.inDouble
    ? splitDuckdbStatementsStep(sql, index + 1, flushDuckdbStatementBuffer(state))
    : splitDuckdbStatementsStep(sql, index + 1, appendDuckdbStatementBuffer(state, currentCharacter))
}

const splitDuckdbStatements = (statement: string) => {
  return splitDuckdbStatementsStep(statement, 0, {buffer: '', inDouble: false, inSingle: false, statements: []})
    .statements
}

const runDuckdbSingleStatement = async (duckdbConnection: DuckDBConnection, statement: string) => {
  await duckdbConnection.run(statement)
}

const runDuckdbSingleStatementAndReadAll = async <T>(
  duckdbConnection: DuckDBConnection,
  statement: string,
  values?: DuckdbBoundValues,
  types?: DuckdbBoundTypes,
): Promise<T[]> => {
  const reader = await duckdbConnection.runAndReadAll(statement, values, types)
  return reader.getRowObjectsJson() as T[]
}

const runDuckdbStatementsDirect = async (
  duckdbConnection: DuckDBConnection,
  statements: string[],
  canRetryAfterRollback = true,
): Promise<void> => {
  try {
    const [currentStatement = ''] = statements

    if (!currentStatement) {
      return
    }

    await runDuckdbSingleStatement(duckdbConnection, currentStatement)
    return await runDuckdbStatementsDirect(duckdbConnection, statements.slice(1), canRetryAfterRollback)
  } catch (error) {
    const shouldRetryAfterRollback = canRetryAfterRollback && isDuckdbAbortedTransactionError(error)
    const shouldRollback = shouldRetryAfterRollback || hasDuckdbTransactionStart(statements)

    if (!shouldRollback) {
      throw error
    }

    const rollbackError = await getDuckdbRollbackError(duckdbConnection)

    if (rollbackError !== null) {
      throw getChainedDuckdbError(error, rollbackError, 'rollback failed')
    }

    if (!shouldRetryAfterRollback) {
      throw error
    }

    try {
      return await runDuckdbStatementsDirect(duckdbConnection, statements, false)
    } catch (retryError) {
      throw getChainedDuckdbError(error, retryError, 'rollback retry failed')
    }
  }
}

const runDuckdbStatementsAndReadLastDirect = async <T>(
  duckdbConnection: DuckDBConnection,
  statements: string[],
  canRetryAfterRollback = true,
): Promise<T[]> => {
  try {
    const [currentStatement = ''] = statements

    if (!currentStatement) {
      return []
    }

    if (statements.length === 1) {
      return await runDuckdbSingleStatementAndReadAll<T>(duckdbConnection, currentStatement)
    }

    await runDuckdbSingleStatement(duckdbConnection, currentStatement)
    return await runDuckdbStatementsAndReadLastDirect<T>(duckdbConnection, statements.slice(1), canRetryAfterRollback)
  } catch (error) {
    const shouldRetryAfterRollback = canRetryAfterRollback && isDuckdbAbortedTransactionError(error)
    const shouldRollback = shouldRetryAfterRollback || hasDuckdbTransactionStart(statements)

    if (!shouldRollback) {
      throw error
    }

    const rollbackError = await getDuckdbRollbackError(duckdbConnection)

    if (rollbackError !== null) {
      throw getChainedDuckdbError(error, rollbackError, 'rollback failed')
    }

    if (!shouldRetryAfterRollback) {
      throw error
    }

    try {
      return await runDuckdbStatementsAndReadLastDirect<T>(duckdbConnection, statements, false)
    } catch (retryError) {
      throw getChainedDuckdbError(error, retryError, 'rollback retry failed')
    }
  }
}

const hasDuckdbTransactionStart = (statements: string[]) => {
  return statements.some((statement) => {
    return /^BEGIN\b/i.test(statement.trim())
  })
}

const getDuckdbRollbackError = async (duckdbConnection?: DuckDBConnection): Promise<Error | null> => {
  try {
    await runDuckdbSingleStatement(duckdbConnection ?? getDuckdbConnection(), 'ROLLBACK')
    return null
  } catch (error) {
    return getNormalizedDuckdbError(error)
  }
}

const runDuckdbJsonQueryDirect = async <T>(statement: string): Promise<T[]> => {
  return runDuckdbStatementsAndReadLastDirect<T>(getDuckdbConnection(), splitDuckdbStatements(statement))
}

const runDuckdbStatementDirect = async (statement: string) => {
  await runDuckdbStatementsDirect(getDuckdbConnection(), splitDuckdbStatements(statement))
}

const runDuckdbBackgroundJsonQueryDirect = async <T>(statement: string): Promise<T[]> => {
  return runDuckdbStatementsAndReadLastDirect<T>(getDuckdbBackgroundConnection(), splitDuckdbStatements(statement))
}

const runDuckdbBackgroundStatementDirect = async (statement: string) => {
  await runDuckdbStatementsDirect(getDuckdbBackgroundConnection(), splitDuckdbStatements(statement))
}

export const getDuckdbRuntimeConfig = () => {
  return {...getDuckdbRuntimeConfigValue()}
}

export const getDuckdbBackgroundRuntimeDiagnostics = async (): Promise<DuckdbBackgroundRuntimeDiagnostics> => {
  const configured = getDuckdbRuntimeConfig()
  const [settingsRow] = await runDuckdbBackgroundJsonQuery<{
    memoryLimit: string | null
    preserveInsertionOrder: boolean | null
    tempDirectory: string | null
    threads: string | null
  }>(`
    SELECT
      current_setting('memory_limit') AS memoryLimit,
      current_setting('preserve_insertion_order') AS preserveInsertionOrder,
      current_setting('threads') AS threads,
      current_setting('temp_directory') AS tempDirectory
  `)

  return {
    configured,
    effective: {
      memoryLimit: settingsRow?.memoryLimit ?? null,
      preserveInsertionOrder: settingsRow?.preserveInsertionOrder ?? null,
      tempDirectory: settingsRow?.tempDirectory ?? null,
      threads: settingsRow?.threads ?? null,
    },
    instanceOptions: getDuckdbInstanceOptions(configured),
    queues: getDuckdbQueueRuntimeMetricsSnapshot(),
  }
}

export const getDuckdbQueueRuntimeMetricsSnapshot = (): DuckdbQueueRuntimeMetrics => {
  return {
    background: {
      lastDurationMs: duckdbServiceState.backgroundLastDurationMs,
      lastWaitMs: duckdbServiceState.backgroundLastWaitMs,
      maxQueueDepth: duckdbServiceState.backgroundMaxQueueDepth,
      queueDepth: duckdbServiceState.backgroundPendingCount,
      tasksCompleted: duckdbServiceState.backgroundTasksCompleted,
      tasksStarted: duckdbServiceState.backgroundTasksStarted,
      totalDurationMs: duckdbServiceState.backgroundTotalDurationMs,
      totalWaitMs: duckdbServiceState.backgroundTotalWaitMs,
    },
    main: {
      lastDurationMs: duckdbServiceState.duckdbLastDurationMs,
      lastWaitMs: duckdbServiceState.duckdbLastWaitMs,
      maxQueueDepth: duckdbServiceState.duckdbMaxQueueDepth,
      queueDepth: duckdbServiceState.duckdbPendingCount,
      tasksCompleted: duckdbServiceState.duckdbTasksCompleted,
      tasksStarted: duckdbServiceState.duckdbTasksStarted,
      totalDurationMs: duckdbServiceState.duckdbTotalDurationMs,
      totalWaitMs: duckdbServiceState.duckdbTotalWaitMs,
    },
  }
}

export const resetDuckdbServiceForTests = () => {
  const closeError = getCombinedCloseError([
    getCloseSyncError(
      duckdbServiceState.controlConnection === null
        ? null
        : () => {
            duckdbServiceState.controlConnection?.closeSync()
          },
    ),
    ...getAppendConnectionCloseErrors(duckdbServiceState.appendConnections),
    getCloseSyncError(
      duckdbServiceState.duckdbInstance === null
        ? null
        : () => {
            duckdbServiceState.duckdbInstance?.closeSync()
          },
    ),
  ])

  resetDuckdbRuntimeState()

  if (closeError) {
    throw closeError
  }
}

export const getDuckdbAppendRuntimeMetrics = (): DuckdbAppendRuntimeMetrics => {
  const queueDepthByLane = [...duckdbServiceState.appendPendingCountByLane]
  const maxQueueDepthByLane = [...duckdbServiceState.appendMaxQueueDepthByLane]

  return {
    batchesCompleted: duckdbServiceState.appendTotalBatchesCompleted,
    batchesStarted: duckdbServiceState.appendTotalBatchesStarted,
    laneCount: getDuckdbRuntimeConfigValue().appendLaneCount,
    lastDurationMs: duckdbServiceState.appendLastDurationMs,
    maxQueueDepth: maxQueueDepthByLane.reduce((maxCount, currentCount) => {
      return maxCount > currentCount ? maxCount : currentCount
    }, 0),
    maxQueueDepthByLane,
    queueDepth: getDuckdbAppendQueueDepth(),
    queueDepthByLane,
    totalDurationMs: duckdbServiceState.appendTotalDurationMs,
  }
}

export const runDuckdbJsonQuery = async <T>(statement: string): Promise<T[]> => {
  return withDuckdbStatementErrorContext({
    label: 'duckdb main query',
    statement,
    work: () => {
      return withNormalizedDuckdbError(() => {
        return enqueueDuckdbWork(async () => {
          await ensureStartedDuckdbProcess()
          return runDuckdbJsonQueryDirect<T>(statement)
        })
      })
    },
  })
}

export const runDuckdbStatement = async (statement: string) => {
  await withDuckdbStatementErrorContext({
    label: 'duckdb main statement',
    statement,
    work: () => {
      return withNormalizedDuckdbError(() => {
        return enqueueDuckdbWork(async () => {
          await ensureStartedDuckdbProcess()
          await runDuckdbStatementDirect(statement)
        })
      })
    },
  })
}

export const runDuckdbBackgroundJsonQuery = async <T>(statement: string): Promise<T[]> => {
  return withDuckdbStatementErrorContext({
    label: 'duckdb background query',
    statement,
    work: () => {
      return withNormalizedDuckdbError(() => {
        return waitForDuckdbAppendBarrier().then(() => {
          const enqueue = getDuckdbRuntimeConfigValue().serializeConcurrentWork
            ? enqueueDuckdbWork
            : enqueueDuckdbBackgroundWork

          return enqueue(async () => {
            await ensureStartedDuckdbProcess()
            return runDuckdbBackgroundJsonQueryDirect<T>(statement)
          })
        })
      })
    },
  })
}

export const runDuckdbBackgroundStatement = async (statement: string) => {
  await withDuckdbStatementErrorContext({
    label: 'duckdb background statement',
    statement,
    work: () => {
      return withNormalizedDuckdbError(() => {
        return waitForDuckdbAppendBarrier().then(() => {
          const enqueue = getDuckdbRuntimeConfigValue().serializeConcurrentWork
            ? enqueueDuckdbWork
            : enqueueDuckdbBackgroundWork

          return enqueue(async () => {
            await ensureStartedDuckdbProcess()
            await runDuckdbBackgroundStatementDirect(statement)
          })
        })
      })
    },
  })
}

export const runDuckdbAppendJsonQuery = async <T>(
  statement: string,
  values?: DuckdbBoundValues,
  types?: DuckdbBoundTypes,
): Promise<T[]> => {
  return withDuckdbStatementErrorContext({
    label: 'duckdb append query',
    statement,
    work: () => {
      return withNormalizedDuckdbError(async () => {
        await ensureStartedDuckdbProcess()
        await waitForDuckdbAppendBarrier()
        const appendLaneIndex = getNextDuckdbAppendLaneIndex()

        return getDuckdbRuntimeConfigValue().serializeConcurrentWork
          ? enqueueDuckdbWork(async () => {
              const startedAtMs = Date.now()

              incrementDuckdbAppendQueueDepth(appendLaneIndex)
              recordDuckdbAppendBatchStart()

              try {
                const appendConnection = getDuckdbAppendConnection(appendLaneIndex)

                return values === undefined && types === undefined
                  ? runDuckdbStatementsAndReadLastDirect<T>(appendConnection, splitDuckdbStatements(statement))
                  : runDuckdbSingleStatementAndReadAll<T>(appendConnection, statement, values, types)
              } finally {
                decrementDuckdbAppendQueueDepth(appendLaneIndex)
                recordDuckdbAppendBatchCompletion(Date.now() - startedAtMs)
              }
            })
          : enqueueDuckdbAppendLaneWork(appendLaneIndex, (appendConnection) => {
              return values === undefined && types === undefined
                ? runDuckdbStatementsAndReadLastDirect<T>(appendConnection, splitDuckdbStatements(statement))
                : runDuckdbSingleStatementAndReadAll<T>(appendConnection, statement, values, types)
            })
      })
    },
  })
}

export const runDuckdbTransaction = async <T>(work: (runner: DuckdbTransactionRunner) => Promise<T>): Promise<T> => {
  return withNormalizedDuckdbError(() => {
    return enqueueDuckdbWork(async () => {
      await ensureStartedDuckdbProcess()
      await runDuckdbStatementDirect('BEGIN TRANSACTION')

      try {
        const result = await work({
          queryJson: async <T>(statement: string) => {
            return runDuckdbJsonQueryDirect<T>(statement)
          },
          run: async (statement: string) => {
            await runDuckdbStatementDirect(statement)
          },
        })

        await runDuckdbStatementDirect('COMMIT')
        return result
      } catch (error) {
        const rollbackError = await getDuckdbRollbackError()

        throw rollbackError === null ? error : getChainedDuckdbError(error, rollbackError, 'rollback failed')
      }
    })
  })
}

export const runDuckdbMaintenance = async (command: 'checkpoint' | 'force_checkpoint') => {
  const statement = command === 'checkpoint' ? 'CHECKPOINT' : 'PRAGMA force_checkpoint'
  await withNormalizedDuckdbError(() => {
    return enqueueDuckdbWork(async () => {
      await ensureStartedDuckdbProcess()
      await withDuckdbAppendBarrier(async () => {
        await runDuckdbStatementDirect(statement)
      })
    })
  })
}

const hasDuckdbSnapshotWal = (snapshotWalPath: string) => {
  return Effect.tryPromise(() => {
    return access(snapshotWalPath).then(
      () => {
        return true
      },
      () => {
        return false
      },
    )
  })
}

const copyDuckdbSnapshot = (runtimeConfig: DuckdbRuntimeConfig): Effect.Effect<DuckdbSnapshot, unknown, never> => {
  return Effect.gen(function* () {
    if (runtimeConfig.databasePath === ':memory:') {
      yield* Effect.fail(new Error('DuckDB snapshots are not available for :memory: databases'))
    }

    yield* Effect.tryPromise(() => {
      return runDuckdbStatementDirect('CHECKPOINT')
    })

    const createdAt = new Date().toISOString()
    const snapshotName = `${basename(runtimeConfig.databasePath)}.${createdAt.replaceAll(':', '-')}.${randomUUID()}.duckdb`
    const snapshotPath = join(duckdbSnapshotDirectory, snapshotName)
    const walPath = `${runtimeConfig.databasePath}.wal`
    const snapshotWalPath = `${snapshotPath}.wal`

    yield* Effect.tryPromise(() => {
      return mkdir(duckdbSnapshotDirectory, {recursive: true})
    })
    yield* Effect.tryPromise(() => {
      return copyFile(runtimeConfig.databasePath, snapshotPath)
    })

    const hasWal = yield* hasDuckdbSnapshotWal(walPath)

    if (hasWal) {
      yield* Effect.tryPromise(() => {
        return copyFile(walPath, snapshotWalPath)
      })
    }

    return {createdAt, snapshotPath} satisfies DuckdbSnapshot
  })
}

export const createDuckdbSnapshot = async (): Promise<DuckdbSnapshot> => {
  return withNormalizedDuckdbError(() => {
    return enqueueDuckdbWork(async () => {
      await ensureStartedDuckdbProcess()
      return withDuckdbAppendBarrier(() => {
        return Effect.runPromise(copyDuckdbSnapshot(getDuckdbRuntimeConfigValue()))
      })
    })
  })
}

export const deleteDuckdbSnapshot = async (snapshotPath: string) => {
  await withNormalizedDuckdbError(async () => {
    const snapshotWalPath = `${snapshotPath}.wal`
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => {
          return rm(snapshotPath, {force: true})
        })
        yield* Effect.tryPromise(() => {
          return rm(snapshotWalPath, {force: true})
        })
      }),
    )
  })
}

export const closeDuckdbService = async () => {
  await enqueueDuckdbWork(async () => {
    await closeDuckdbServiceDirect()
  })
}

registerDuckdbOwnerDemotionHandler(async () => {
  if (duckdbServiceState.controlConnection !== null || duckdbServiceState.duckdbInstance !== null) {
    await closeDuckdbService()
  }
})
