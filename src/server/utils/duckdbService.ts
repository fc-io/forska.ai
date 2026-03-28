import {randomUUID} from 'node:crypto'
import {mkdirSync} from 'node:fs'
import {access, copyFile, mkdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'

import {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api'
import {Effect} from 'effect'

import {getEnv} from './env.ts'
import {ensureDuckdbPathDirectory} from './getDuckdbPath.ts'
import {
  ensureCurrentDuckdbOwnerLease,
  registerWriterDemotionHandler,
  releaseCurrentDuckdbOwnerLease,
} from './serverRuntimeRole.ts'

type DuckdbRuntimeConfig = {
  appendLaneCount: number
  binary: string
  databasePath: string
  memoryLimit: string
  tempDirectory: string | null
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
type DuckdbTransactionRunner = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}
type DuckdbAppendBarrier = {promise: Promise<void>; resolve: () => void}

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
  backgroundQueue: Promise<void>
  controlConnection: DuckDBConnection | null
  duckdbInstance: DuckDBInstance | null
  duckdbQueue: Promise<void>
  duckdbRuntimeConfig: DuckdbRuntimeConfig | null
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
    backgroundQueue: Promise.resolve(),
    controlConnection: null,
    duckdbInstance: null,
    duckdbQueue: Promise.resolve(),
    duckdbRuntimeConfig: null,
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
    tempDirectory: getTrimmedValue(env.DUCKDB_TEMP_DIRECTORY),
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
    ? {memory_limit: runtimeConfig.memoryLimit}
    : {memory_limit: runtimeConfig.memoryLimit, temp_directory: runtimeConfig.tempDirectory}
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

const recoverDuckdbRuntimeAfterFatalError = async (error: unknown) => {
  if (duckdbFatalRecoveryPromise !== null) {
    return duckdbFatalRecoveryPromise
  }

  const normalizedError = getNormalizedDuckdbError(error)

  console.warn('[duckdb] restarting embedded runtime after fatal invalidation', normalizedError)

  duckdbFatalRecoveryPromise = closeDuckdbServiceDirect()
    .catch((closeError) => {
      console.warn('[duckdb] failed to close embedded runtime during fatal recovery', closeError)
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
  duckdbServiceState.backgroundQueue = Promise.resolve()
  duckdbServiceState.controlConnection = null
  duckdbServiceState.duckdbInstance = null
  duckdbServiceState.duckdbQueue = Promise.resolve()
  duckdbServiceState.duckdbRuntimeConfig = null
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
          process.exit(0)
        },
        (error) => {
          console.error(`[duckdb] shutdown failed on ${signal}`, error)
          process.exit(1)
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
    console.error('[duckdb] failed to clean up embedded runtime', closeError)
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

      console.warn('[duckdb] retrying startup after recoverable initialization failure', error)
      return startDuckdbProcess()
    })
    .finally(() => {
      duckdbServiceState.startupPromise = null
    })

  return duckdbServiceState.startupPromise
}

const enqueueDuckdbWork = async <T>(work: () => Promise<T>): Promise<T> => {
  const queuedWork = duckdbServiceState.duckdbQueue.then(work)
  duckdbServiceState.duckdbQueue = queuedWork.then(
    () => {
      return undefined
    },
    () => {
      return undefined
    },
  )
  return queuedWork
}

const enqueueDuckdbBackgroundWork = async <T>(work: () => Promise<T>): Promise<T> => {
  const queuedWork = duckdbServiceState.backgroundQueue.then(work)
  duckdbServiceState.backgroundQueue = queuedWork.then(
    () => {
      return undefined
    },
    () => {
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
): Promise<T[]> => {
  const reader = await duckdbConnection.runAndReadAll(statement)
  return reader.getRowObjectsJson() as T[]
}

const runDuckdbStatementsDirect = async (duckdbConnection: DuckDBConnection, statements: string[]): Promise<void> => {
  const [currentStatement = ''] = statements

  if (!currentStatement) {
    return
  }

  await runDuckdbSingleStatement(duckdbConnection, currentStatement)
  return runDuckdbStatementsDirect(duckdbConnection, statements.slice(1))
}

const runDuckdbStatementsAndReadLastDirect = async <T>(
  duckdbConnection: DuckDBConnection,
  statements: string[],
): Promise<T[]> => {
  const [currentStatement = ''] = statements

  if (!currentStatement) {
    return []
  }

  return statements.length === 1
    ? runDuckdbSingleStatementAndReadAll<T>(duckdbConnection, currentStatement)
    : runDuckdbSingleStatement(duckdbConnection, currentStatement).then(() => {
        return runDuckdbStatementsAndReadLastDirect<T>(duckdbConnection, statements.slice(1))
      })
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

const getDuckdbRollbackError = async (): Promise<Error | null> => {
  try {
    await runDuckdbStatementDirect('ROLLBACK')
    return null
  } catch (error) {
    return getNormalizedDuckdbError(error)
  }
}

export const getDuckdbRuntimeConfig = () => {
  return {...getDuckdbRuntimeConfigValue()}
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
  return withNormalizedDuckdbError(() => {
    return enqueueDuckdbWork(async () => {
      await ensureStartedDuckdbProcess()
      return runDuckdbJsonQueryDirect<T>(statement)
    })
  })
}

export const runDuckdbStatement = async (statement: string) => {
  await withNormalizedDuckdbError(() => {
    return enqueueDuckdbWork(async () => {
      await ensureStartedDuckdbProcess()
      await runDuckdbStatementDirect(statement)
    })
  })
}

export const runDuckdbBackgroundJsonQuery = async <T>(statement: string): Promise<T[]> => {
  return withNormalizedDuckdbError(() => {
    return waitForDuckdbAppendBarrier().then(() => {
      return enqueueDuckdbBackgroundWork(async () => {
        await ensureStartedDuckdbProcess()
        return runDuckdbBackgroundJsonQueryDirect<T>(statement)
      })
    })
  })
}

export const runDuckdbBackgroundStatement = async (statement: string) => {
  await withNormalizedDuckdbError(() => {
    return waitForDuckdbAppendBarrier().then(() => {
      return enqueueDuckdbBackgroundWork(async () => {
        await ensureStartedDuckdbProcess()
        await runDuckdbBackgroundStatementDirect(statement)
      })
    })
  })
}

export const runDuckdbAppendJsonQuery = async <T>(statement: string): Promise<T[]> => {
  return withNormalizedDuckdbError(async () => {
    await ensureStartedDuckdbProcess()
    await waitForDuckdbAppendBarrier()
    const appendLaneIndex = getNextDuckdbAppendLaneIndex()

    return enqueueDuckdbAppendLaneWork(appendLaneIndex, (appendConnection) => {
      return runDuckdbStatementsAndReadLastDirect<T>(appendConnection, splitDuckdbStatements(statement))
    })
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

registerWriterDemotionHandler(async () => {
  if (duckdbServiceState.controlConnection !== null || duckdbServiceState.duckdbInstance !== null) {
    await closeDuckdbService()
  }
})
