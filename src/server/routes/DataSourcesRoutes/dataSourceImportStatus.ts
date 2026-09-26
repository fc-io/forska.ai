import {getDateValue} from '../../services/appQueryHelpers.ts'
import {
  isFreshDataSourceImportCursor,
  resumableDataSourceImportRoutes,
} from '../../services/dataSourceImportStateRepository.ts'
import type {DuckdbWorkloadContext} from '../../utils/duckdbService.ts'

type DataSourceImportStateRow = {
  completedAt: unknown
  consecutiveFailureCount: number | string | null
  dataSourceId: string
  failedAt: unknown
  fetchedCount: number | string | null
  lastError: string | null
  lastProgressAt: unknown
  nextRetryAt: unknown
  progressFromStart: boolean | null
  runStartedAt: unknown
  runStartFetchedCount: number | string | null
  runTrigger: string | null
  startedAt: unknown
  status: string
  storedCount: number | string | null
  totalCount: number | string | null
}

type DataSourceImportStateQueryRunner = {
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
}

type RecordedDataSourceImportStatus = 'completed' | 'failed' | 'running'

const recordedImportStatuses = new Set<string>(['completed', 'failed', 'running'])

const getCount = (value: number | string | null | undefined) => {
  const count = Number(value ?? 0)

  return Number.isFinite(count) ? count : 0
}

const getNullableCount = (value: number | string | null | undefined) => {
  return value === null || value === undefined ? null : getCount(value)
}

const isRecordedImportStatus = (status: string): status is RecordedDataSourceImportStatus => {
  return recordedImportStatuses.has(status)
}

const getRecordedImportStatus = (state: DataSourceImportStateRow, status: RecordedDataSourceImportStatus) => {
  return {
    completedAt: getDateValue(state.completedAt),
    consecutiveFailureCount: getCount(state.consecutiveFailureCount),
    failedAt: getDateValue(state.failedAt),
    fetchedCount: getCount(state.fetchedCount),
    lastError: state.lastError,
    lastProgressAt: getDateValue(state.lastProgressAt),
    nextRetryAt: getDateValue(state.nextRetryAt),
    progressFromStart: Boolean(state.progressFromStart),
    runStartedAt: getDateValue(state.runStartedAt),
    runStartFetchedCount: getCount(state.runStartFetchedCount),
    runTrigger: state.runTrigger,
    startedAt: getDateValue(state.startedAt),
    status: status as RecordedDataSourceImportStatus | 'interrupted',
    storedCount: getCount(state.storedCount),
    totalCount: getNullableCount(state.totalCount),
  }
}

type DataSourceImportStatus = ReturnType<typeof getRecordedImportStatus>

const interruptedImportStatus: DataSourceImportStatus = {
  completedAt: null,
  consecutiveFailureCount: 0,
  failedAt: null,
  fetchedCount: 0,
  lastError: null,
  lastProgressAt: null,
  nextRetryAt: null,
  progressFromStart: false,
  runStartedAt: null,
  runStartFetchedCount: 0,
  runTrigger: null,
  startedAt: null,
  status: 'interrupted',
  storedCount: 0,
  totalCount: null,
}

const isInterruptedImportWithoutState = (dataSource: {cursor: string | null; importRoute: string | null}) => {
  return Boolean(
    dataSource.importRoute
    && resumableDataSourceImportRoutes.has(dataSource.importRoute)
    && !isFreshDataSourceImportCursor(dataSource.cursor),
  )
}

const getStatelessImportStatus = (dataSource: {cursor: string | null; importRoute: string | null}) => {
  return isInterruptedImportWithoutState(dataSource) ? interruptedImportStatus : null
}

export const getDataSourceImportStatus = (
  dataSource: {cursor: string | null; importRoute: string | null},
  state: DataSourceImportStateRow | undefined,
): DataSourceImportStatus | null => {
  return state && isRecordedImportStatus(state.status)
    ? getRecordedImportStatus(state, state.status)
    : getStatelessImportStatus(dataSource)
}

export const getDataSourceImportStatesById = async (
  db: DataSourceImportStateQueryRunner,
  workloadContext: DuckdbWorkloadContext,
) => {
  const rows = await db.queryJson<DataSourceImportStateRow>(
    `
    SELECT
      data_source_id AS dataSourceId,
      status,
      run_trigger AS runTrigger,
      started_at AS startedAt,
      run_started_at AS runStartedAt,
      last_progress_at AS lastProgressAt,
      completed_at AS completedAt,
      failed_at AS failedAt,
      consecutive_failure_count AS consecutiveFailureCount,
      last_error AS lastError,
      next_retry_at AS nextRetryAt,
      total_count AS totalCount,
      fetched_count AS fetchedCount,
      stored_count AS storedCount,
      run_start_fetched_count AS runStartFetchedCount,
      progress_from_start AS progressFromStart
    FROM app.data_source_import_state
  `,
    workloadContext,
  )

  return new Map(
    rows.map((row) => {
      return [row.dataSourceId, row]
    }),
  )
}
