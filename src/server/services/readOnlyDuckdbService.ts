import {existsSync} from 'node:fs'

import {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api'

import {
  type DuckdbWorkloadContext,
  getReadOnlyDuckdbRuntimeOptions,
  runDuckdbBackgroundJsonQuery,
  runMeasuredDuckdbJsonWorkload,
} from '../utils/duckdbService.ts'
import {getEnv} from '../utils/env.ts'
import {canCurrentServerOwnDuckdb} from '../utils/serverRuntimeRole.ts'

export type ReadOnlyDuckdbContext = 'api-read-only' | 'judge-worker'

type ReadOnlyDuckdbRuntimeConfig = {databasePath: string; memoryLimit: string}

type ReadOnlyDuckdbServiceState = {
  connection: DuckDBConnection | null
  databasePath: string | null
  duckdbInstance: DuckDBInstance | null
  pendingCount: number
  queue: Promise<void>
  startupPromise: Promise<DuckDBConnection> | null
}

declare global {
  var __forskaReadOnlyDuckdbServiceState: ReadOnlyDuckdbServiceState | undefined
}

const disabledReadOnlyDuckdbValues = new Set(['1', 'disabled', 'true', 'untrusted', 'yes'])
const unsafeSqlPattern =
  /(^|[\s;(])(alter|attach|call|checkpoint|copy|create|delete|detach|drop|export|import|insert|install|load|reset|set|truncate|update|vacuum)\b/i

const getReadOnlyDuckdbServiceState = () => {
  globalThis.__forskaReadOnlyDuckdbServiceState ??= {
    connection: null,
    databasePath: null,
    duckdbInstance: null,
    pendingCount: 0,
    queue: Promise.resolve(),
    startupPromise: null,
  }

  return globalThis.__forskaReadOnlyDuckdbServiceState
}

const readOnlyDuckdbServiceState = getReadOnlyDuckdbServiceState()

const getReadOnlyDuckdbRuntimeConfig = (): ReadOnlyDuckdbRuntimeConfig => {
  const env = getEnv()

  return {databasePath: env.DUCKDB_PATH, memoryLimit: env.DUCKDB_MEMORY_LIMIT}
}

const getNormalizedDisableValue = (value: string | undefined) => {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

const getTrimmedValue = (value: string | null | undefined) => {
  return String(value ?? '').trim()
}

const isApiOwnerProxyConfigured = (context: ReadOnlyDuckdbContext | undefined) => {
  return context === 'api-read-only' && getTrimmedValue(getEnv().SERVER_DUCKDB_OWNER_URL) !== ''
}

export const isLiveReadOnlyDuckdbTrusted = (context?: ReadOnlyDuckdbContext) => {
  const disabledByPrimaryFlag = disabledReadOnlyDuckdbValues.has(
    getNormalizedDisableValue(process.env.FORSKA_DISABLE_LIVE_READ_ONLY_DUCKDB),
  )
  const disabledByBackendFlag = getNormalizedDisableValue(process.env.FORSKA_OWNERLESS_READ_ONLY_DUCKDB) === 'disabled'

  return !disabledByPrimaryFlag && !disabledByBackendFlag && !isApiOwnerProxyConfigured(context)
}

const getReadOnlyDuckdbUnavailableError = (context: ReadOnlyDuckdbContext, message: string) => {
  return new Error(`[${context}] live read-only DuckDB unavailable: ${message}`)
}

const assertReadOnlyDuckdbIsConfigured = (
  context: ReadOnlyDuckdbContext,
  runtimeConfig: ReadOnlyDuckdbRuntimeConfig,
) => {
  if (!isLiveReadOnlyDuckdbTrusted(context)) {
    throw getReadOnlyDuckdbUnavailableError(context, 'live read-only DuckDB is disabled or untrusted')
  }

  if (runtimeConfig.databasePath === ':memory:') {
    throw getReadOnlyDuckdbUnavailableError(context, 'DUCKDB_PATH=:memory: is not ownerless-readable')
  }

  if (!existsSync(runtimeConfig.databasePath)) {
    throw getReadOnlyDuckdbUnavailableError(context, `database file does not exist at ${runtimeConfig.databasePath}`)
  }
}

export const assertReadOnlyDuckdbSql = (context: ReadOnlyDuckdbContext, statement: string) => {
  const trimmed = statement.trim()
  const withoutTrailingSemicolon = trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed

  if (withoutTrailingSemicolon === '') {
    throw new Error(`[${context}] read-only DuckDB query cannot be empty`)
  }

  if (withoutTrailingSemicolon.includes(';')) {
    throw new Error(`[${context}] read-only DuckDB helper accepts exactly one statement`)
  }

  if (withoutTrailingSemicolon.match(unsafeSqlPattern) !== null) {
    throw new Error(`[${context}] read-only DuckDB helper rejected a write-capable statement`)
  }
}

const closeReadOnlyDuckdbServiceDirect = () => {
  const activeConnection = readOnlyDuckdbServiceState.connection
  const activeInstance = readOnlyDuckdbServiceState.duckdbInstance

  readOnlyDuckdbServiceState.connection = null
  readOnlyDuckdbServiceState.databasePath = null
  readOnlyDuckdbServiceState.duckdbInstance = null
  readOnlyDuckdbServiceState.startupPromise = null

  activeConnection?.closeSync()
  activeInstance?.closeSync()
}

const createReadOnlyDuckdbInstance = async (runtimeConfig: ReadOnlyDuckdbRuntimeConfig) => {
  return DuckDBInstance.create(
    runtimeConfig.databasePath,
    getReadOnlyDuckdbRuntimeOptions({memoryLimit: runtimeConfig.memoryLimit}),
  )
}

const startReadOnlyDuckdbService = async (context: ReadOnlyDuckdbContext): Promise<DuckDBConnection> => {
  const runtimeConfig = getReadOnlyDuckdbRuntimeConfig()

  assertReadOnlyDuckdbIsConfigured(context, runtimeConfig)

  if (
    readOnlyDuckdbServiceState.connection
    && readOnlyDuckdbServiceState.duckdbInstance
    && readOnlyDuckdbServiceState.databasePath === runtimeConfig.databasePath
  ) {
    return readOnlyDuckdbServiceState.connection
  }

  if (
    readOnlyDuckdbServiceState.connection
    || readOnlyDuckdbServiceState.duckdbInstance
    || readOnlyDuckdbServiceState.databasePath !== null
  ) {
    closeReadOnlyDuckdbServiceDirect()
  }

  const duckdbInstance = await createReadOnlyDuckdbInstance(runtimeConfig)
  const connection = await duckdbInstance.connect()

  readOnlyDuckdbServiceState.connection = connection
  readOnlyDuckdbServiceState.databasePath = runtimeConfig.databasePath
  readOnlyDuckdbServiceState.duckdbInstance = duckdbInstance

  return connection
}

const ensureReadOnlyDuckdbServiceStarted = async (context: ReadOnlyDuckdbContext) => {
  if (readOnlyDuckdbServiceState.startupPromise !== null) {
    return readOnlyDuckdbServiceState.startupPromise
  }

  readOnlyDuckdbServiceState.startupPromise = startReadOnlyDuckdbService(context).finally(() => {
    readOnlyDuckdbServiceState.startupPromise = null
  })

  return readOnlyDuckdbServiceState.startupPromise
}

const enqueueReadOnlyDuckdbWork = async <T>(work: () => Promise<T>): Promise<T> => {
  readOnlyDuckdbServiceState.pendingCount += 1
  const queuedWork = readOnlyDuckdbServiceState.queue.then(work)

  readOnlyDuckdbServiceState.queue = queuedWork.then(
    () => {
      readOnlyDuckdbServiceState.pendingCount = Math.max(0, readOnlyDuckdbServiceState.pendingCount - 1)
      return undefined
    },
    () => {
      readOnlyDuckdbServiceState.pendingCount = Math.max(0, readOnlyDuckdbServiceState.pendingCount - 1)
      return undefined
    },
  )

  return queuedWork
}

const runEphemeralReadOnlyDuckdbJsonQuery = async <T>(context: ReadOnlyDuckdbContext, statement: string) => {
  const connection = await ensureReadOnlyDuckdbServiceStarted(context)

  try {
    const reader = await connection.runAndReadAll(statement)

    return reader.getRowObjectsJson() as T[]
  } finally {
    closeReadOnlyDuckdbServiceDirect()
  }
}

const shouldUseOwnerGuardedReadPath = () => {
  return canCurrentServerOwnDuckdb()
}

const runOwnerGuardedReadQuery = async <T>(
  context: ReadOnlyDuckdbContext,
  statement: string,
  workloadContext?: DuckdbWorkloadContext,
) => {
  if (!shouldUseOwnerGuardedReadPath()) {
    throw getReadOnlyDuckdbUnavailableError(context, 'owner guarded read path is not available')
  }

  return runDuckdbBackgroundJsonQuery<T>(statement, workloadContext)
}

export const runReadOnlyDuckdbJsonQuery = async <T>(
  context: ReadOnlyDuckdbContext,
  statement: string,
  workloadContext?: DuckdbWorkloadContext,
): Promise<T[]> => {
  assertReadOnlyDuckdbSql(context, statement)

  if (shouldUseOwnerGuardedReadPath()) {
    return runOwnerGuardedReadQuery<T>(context, statement, workloadContext)
  }

  const queueDepthAtStart = readOnlyDuckdbServiceState.pendingCount

  return enqueueReadOnlyDuckdbWork(() => {
    return runMeasuredDuckdbJsonWorkload({
      operation: 'readOnlyQuery',
      queue: 'readOnly',
      queueDepthAtStart,
      workloadContext,
      work: () => {
        return runEphemeralReadOnlyDuckdbJsonQuery<T>(context, statement)
      },
    })
  })
}

export const validateReadOnlyDuckdbService = async (context: ReadOnlyDuckdbContext): Promise<void> => {
  await runReadOnlyDuckdbJsonQuery(context, 'SELECT 1 AS value')
}

export const closeReadOnlyDuckdbService = async (): Promise<void> => {
  await enqueueReadOnlyDuckdbWork(async () => {
    closeReadOnlyDuckdbServiceDirect()
  })
}

export const resetReadOnlyDuckdbServiceForTests = () => {
  closeReadOnlyDuckdbServiceDirect()
  readOnlyDuckdbServiceState.pendingCount = 0
  readOnlyDuckdbServiceState.queue = Promise.resolve()
}
