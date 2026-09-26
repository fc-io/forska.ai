import type {DuckdbTransactionRunner, DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'
import {getDataSourceImportErrorMessage, isTransientDataSourceImportError} from './dataSourceImportRetry.ts'

export type DataSourceImportTrigger = 'auto_resume' | 'auto_retry' | 'manual'
export type DataSourceImportStateStatus = 'completed' | 'failed' | 'running'
export type DataSourceImportResumeCandidate = {
  consecutiveFailureCount: number
  dataSourceId: string
  importRoute: string
  status: Exclude<DataSourceImportStateStatus, 'completed'>
}
export type DataSourceImportFailureResult = {
  consecutiveFailureCount: number
  nextRetryAt: Date | null
  transient: boolean
}

type DataSourceImportStateRunner = Pick<DuckdbTransactionRunner, 'queryJson' | 'run'>
type DataSourceImportStateDatabase = {
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
  run: (statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<void>
  transaction: <T>(
    operation: (runner: DataSourceImportStateRunner) => Promise<T>,
    workloadContext?: DuckdbWorkloadContext,
  ) => Promise<T>
}

export const dataSourceImportMaxConsecutiveFailures = 5
export const dataSourceImportAutoRetryDelaysMs = [60_000, 300_000, 900_000, 1_800_000] as const
export const resumableDataSourceImportRoutes = new Set([
  '/api/datasources/import/pubmed',
  '/api/datasources/import/europe-pmc-ppr',
  '/api/datasources/import/medrxiv',
  '/api/datasources/import/biorxiv',
  '/api/datasources/import/arxiv',
])

const maxLastErrorLength = 2000
const freshDataSourceImportCursors = new Set(['', '*', '0'])
const failureCountSqlByTrigger: Record<DataSourceImportTrigger, string> = {
  auto_resume: 'consecutive_failure_count + 1',
  auto_retry: 'consecutive_failure_count',
  manual: '0',
}

export const getDataSourceImportStateWorkloadContext = (operation: string): DuckdbWorkloadContext => {
  return {
    fallbackIntent: 'reject',
    routeOrJobKey: `dataSourceImport.state.${operation}`,
    workloadClass: 'background.importStore',
  }
}

export const isFreshDataSourceImportCursor = (cursor: string | null | undefined) => {
  return freshDataSourceImportCursors.has(cursor?.trim() ?? '')
}

export const getDataSourceImportAutoRetryDelayMs = (consecutiveFailureCount: number) => {
  const delayIndex = Math.min(Math.max(consecutiveFailureCount, 1), dataSourceImportAutoRetryDelaysMs.length) - 1

  return dataSourceImportAutoRetryDelaysMs[delayIndex] ?? dataSourceImportAutoRetryDelaysMs[0]
}

const getLastErrorSql = (error: unknown) => {
  return getSqlLiteral(getDataSourceImportErrorMessage(error).slice(0, maxLastErrorLength))
}

export const getDataSourceImportRunStartedSql = (input: {
  dataSourceId: string
  importRoute: string
  now: Date
  startsFresh: boolean
  trigger: DataSourceImportTrigger
}) => {
  const now = getTimestampLiteral(input.now)
  const isManual = input.trigger === 'manual'

  return `
    INSERT INTO app.data_source_import_state (
      data_source_id,
      import_route,
      status,
      run_trigger,
      started_at,
      run_started_at,
      last_progress_at,
      completed_at,
      failed_at,
      consecutive_failure_count,
      last_error,
      next_retry_at,
      updated_at
    ) VALUES (
      '${escapeSqlString(input.dataSourceId)}',
      '${escapeSqlString(input.importRoute)}',
      'running',
      '${input.trigger}',
      ${now},
      ${now},
      NULL,
      NULL,
      NULL,
      0,
      NULL,
      NULL,
      ${now}
    )
    ON CONFLICT (data_source_id) DO UPDATE SET
      import_route = EXCLUDED.import_route,
      status = 'running',
      run_trigger = EXCLUDED.run_trigger,
      started_at = ${input.startsFresh ? 'EXCLUDED.started_at' : 'started_at'},
      run_started_at = EXCLUDED.run_started_at,
      last_progress_at = ${input.startsFresh ? 'NULL' : 'last_progress_at'},
      completed_at = NULL,
      failed_at = ${isManual ? 'NULL' : 'failed_at'},
      consecutive_failure_count = ${failureCountSqlByTrigger[input.trigger]},
      last_error = ${isManual ? 'NULL' : 'last_error'},
      next_retry_at = NULL,
      updated_at = EXCLUDED.updated_at
  `
}

export const getDataSourceImportPageSavedSql = (input: {dataSourceId: string; now: Date}) => {
  const now = getTimestampLiteral(input.now)

  return `
    UPDATE app.data_source_import_state
    SET last_progress_at = ${now},
        consecutive_failure_count = 0,
        updated_at = ${now}
    WHERE data_source_id = '${escapeSqlString(input.dataSourceId)}'
  `
}

export const getDataSourceImportCompletedSql = (input: {dataSourceId: string; now: Date}) => {
  const now = getTimestampLiteral(input.now)

  return `
    UPDATE app.data_source_import_state
    SET status = 'completed',
        completed_at = ${now},
        failed_at = NULL,
        consecutive_failure_count = 0,
        last_error = NULL,
        next_retry_at = NULL,
        updated_at = ${now}
    WHERE data_source_id = '${escapeSqlString(input.dataSourceId)}'
  `
}

const getNextRetryAt = (input: {consecutiveFailureCount: number; now: Date; transient: boolean}) => {
  return input.transient && input.consecutiveFailureCount < dataSourceImportMaxConsecutiveFailures
    ? new Date(input.now.getTime() + getDataSourceImportAutoRetryDelayMs(input.consecutiveFailureCount))
    : null
}

const updateDataSourceImportRunFailed = async (
  tx: DataSourceImportStateRunner,
  input: {dataSourceId: string; error: unknown; now: Date; previousFailureCount: number},
): Promise<DataSourceImportFailureResult> => {
  const consecutiveFailureCount = input.previousFailureCount + 1
  const transient = isTransientDataSourceImportError(input.error)
  const nextRetryAt = getNextRetryAt({consecutiveFailureCount, now: input.now, transient})
  const now = getTimestampLiteral(input.now)

  await tx.run(`
    UPDATE app.data_source_import_state
    SET status = 'failed',
        failed_at = ${now},
        consecutive_failure_count = ${consecutiveFailureCount},
        last_error = ${getLastErrorSql(input.error)},
        next_retry_at = ${nextRetryAt ? getTimestampLiteral(nextRetryAt) : 'NULL'},
        updated_at = ${now}
    WHERE data_source_id = '${escapeSqlString(input.dataSourceId)}'
  `)

  return {consecutiveFailureCount, nextRetryAt, transient}
}

export const createDataSourceImportStateRepository = (
  database: DataSourceImportStateDatabase = getAppDatabaseService(),
) => {
  return {
    listResumeCandidates: async (input: {limit?: number; now: Date}) => {
      const rows = await database.queryJson<{
        consecutiveFailureCount: number | string
        dataSourceId: string
        importRoute: string
        status: 'failed' | 'running'
      }>(
        `
        SELECT
          state.data_source_id AS dataSourceId,
          COALESCE(data_source.import_route, state.import_route) AS importRoute,
          state.status,
          state.consecutive_failure_count AS consecutiveFailureCount
        FROM app.data_source_import_state state
        INNER JOIN app.data_source data_source ON data_source.id = state.data_source_id
        WHERE data_source.archived = FALSE
          AND (
            state.status = 'running'
            OR (
              state.status = 'failed'
              AND state.next_retry_at IS NOT NULL
              AND state.next_retry_at <= ${getTimestampLiteral(input.now)}
            )
          )
        ORDER BY COALESCE(state.last_progress_at, state.run_started_at) ASC, state.data_source_id ASC
        LIMIT ${input.limit ?? 100}
      `,
        getDataSourceImportStateWorkloadContext('listResumeCandidates'),
      )

      return rows.map((row): DataSourceImportResumeCandidate => {
        return {
          consecutiveFailureCount: Number(row.consecutiveFailureCount),
          dataSourceId: row.dataSourceId,
          importRoute: row.importRoute,
          status: row.status,
        }
      })
    },
    markRunFailed: async (input: {dataSourceId: string; error: unknown; now: Date}) => {
      return await database.transaction(async (tx) => {
        const [row] = await tx.queryJson<{consecutiveFailureCount: number | string}>(`
          SELECT consecutive_failure_count AS consecutiveFailureCount
          FROM app.data_source_import_state
          WHERE data_source_id = '${escapeSqlString(input.dataSourceId)}'
            AND status <> 'completed'
        `)

        return row
          ? await updateDataSourceImportRunFailed(tx, {
              ...input,
              previousFailureCount: Number(row.consecutiveFailureCount),
            })
          : null
      }, getDataSourceImportStateWorkloadContext('markRunFailed'))
    },
    markRunStarted: async (input: Parameters<typeof getDataSourceImportRunStartedSql>[0]) => {
      await database.run(
        getDataSourceImportRunStartedSql(input),
        getDataSourceImportStateWorkloadContext('markRunStarted'),
      )
    },
    markRunStopped: async (input: {dataSourceId: string; error: string; now: Date}) => {
      const now = getTimestampLiteral(input.now)

      await database.run(
        `
        UPDATE app.data_source_import_state
        SET status = 'failed',
            failed_at = ${now},
            last_error = ${getLastErrorSql(input.error)},
            next_retry_at = NULL,
            updated_at = ${now}
        WHERE data_source_id = '${escapeSqlString(input.dataSourceId)}'
          AND status = 'running'
      `,
        getDataSourceImportStateWorkloadContext('markRunStopped'),
      )
    },
  }
}

export type DataSourceImportStateRepository = ReturnType<typeof createDataSourceImportStateRepository>

export const getDataSourceImportStateRepository = () => {
  return createDataSourceImportStateRepository()
}
