import {createHash} from 'node:crypto'

import type {
  DataSourceArticleChangeKind,
  DataSourceArticleChangeLogRecord,
  DataSourceArticleChangeRunKind,
  DataSourceReconciliationRunKind,
  DataSourceReconciliationWorkRecord,
  DataSourceReconciliationWorkStatus,
  DataSourceTrackingGranularity,
  DataSourceTrackingRunKind,
  DataSourceTrackingStateRecord,
} from '../../db/schemaTypes.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getJsonValue, getSqlLiteral} from './appQueryHelpers.ts'

export type DataSourceTrackingDatabaseRunner = {
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
  run: (statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<void>
}

type DataSourceTrackingStateRow = {
  activeCursor: string | null
  activeReconciliationAgeMonths: number | null
  activeRunKind: string | null
  activeWindowEnd: unknown
  activeWindowStart: unknown
  createdAt: unknown
  dataSourceId: string
  failureCount: number | null
  granularity: string
  highWaterCompletedAt: unknown
  lastAttemptAt: unknown
  lastError: string | null
  lastImportRunId: string | null
  lastReconciliationCompletedAt: unknown
  lastReconciliationSchedulerAt: unknown
  lastSuccessAt: unknown
  leaseExpiresAt: unknown
  leaseOwner: string | null
  nextRunAfter: unknown
  route: string
  updatedAt: unknown
}

type DataSourceReconciliationWorkRow = {
  ageMonths: number | null
  completedAt: unknown
  cursor: string | null
  dataSourceId: string
  failureCount: number | null
  id: string
  importRunId: string | null
  lastError: string | null
  leaseExpiresAt: unknown
  leaseOwner: string | null
  nextRetryAt: unknown
  periodEnd: unknown
  periodStart: unknown
  route: string
  runKind: string
  scheduledAt: unknown
  spoolWindowId: string | null
  startedAt: unknown
  status: string
  updatedAt: unknown
}

type DataSourceReconciliationScheduleSourceRow = {
  dataSourceId: string
  dateFrom: unknown
  dateTo: unknown
  lastReconciliationSchedulerAt: unknown
  route: string
  trackingReconcileScheduleMonths: unknown
}

type DataSourceArticleChangeLogRow = {
  articleId: string | null
  changeKind: string
  changedFields: unknown
  createdAt: unknown
  dataSourceId: string
  detectedAt: unknown
  externalArticleId: string | null
  id: string
  importRouteId: string | null
  importRunId: string | null
  nextSnapshot: unknown
  nextSourceRecordHash: string | null
  previousSnapshot: unknown
  previousSourceRecordHash: string | null
  route: string
  runKind: string
  sourceRecordKey: string | null
}

export type CreateOrUpdateTrackingStateInput = {
  dataSourceId: string
  granularity: DataSourceTrackingGranularity
  nextRunAfter?: Date | null
  route: string
}

export type UpdateTrackingStateInput = {
  activeCursor?: string | null
  activeReconciliationAgeMonths?: number | null
  activeRunKind?: DataSourceTrackingRunKind | null
  activeWindowEnd?: Date | null
  activeWindowStart?: Date | null
  granularity?: DataSourceTrackingGranularity
  lastImportRunId?: string | null
  lastReconciliationCompletedAt?: Date | null
  lastReconciliationSchedulerAt?: Date | null
  nextRunAfter?: Date | null
  route?: string
}

export type TrackingSuccessInput = {
  dataSourceId: string
  highWaterCompletedAt: Date
  importRunId?: string | null
  leaseOwner?: string | null
  nextRunAfter?: Date | null
  now?: Date
}

export type TrackingFailureInput = {
  dataSourceId: string
  error: string
  leaseOwner?: string | null
  nextRunAfter?: Date | null
  now?: Date
}

export type ReconciliationSuccessInput = {dataSourceId: string; importRunId?: string | null; now?: Date}

export type ScheduleReconciliationWorkInput = {
  ageMonths: number | null
  dataSourceId: string
  id?: string
  now?: Date
  periodEnd: Date
  periodStart: Date
  route: string
  runKind: DataSourceReconciliationRunKind
}

export type InsertArticleChangeLogInput = {
  articleId?: string | null
  changeKind: DataSourceArticleChangeKind
  changedFields?: unknown
  dataSourceId: string
  detectedAt?: Date
  externalArticleId?: string | null
  id?: string
  importRouteId?: string | null
  importRunId?: string | null
  nextSnapshot?: unknown
  nextSourceRecordHash?: string | null
  previousSnapshot?: unknown
  previousSourceRecordHash?: string | null
  route: string
  runKind: DataSourceArticleChangeRunKind
  sourceRecordKey?: string | null
}

export type DataSourceArticleChangeLogCursor = {createdAt: Date; detectedAt: Date; id: string}

const trackingRepositoryWorkload = (routeOrJobKey: string, maxResultRows?: number): DuckdbWorkloadContext => {
  return {fallbackIntent: 'reject', maxResultRows, routeOrJobKey, workloadClass: 'owner.dataSourceTrackingRepository'}
}

const defaultTrackingReconcileScheduleMonths = [3, 12, 24, 36]
const maxTrackingReconcileScheduleMonth = 120
const trackingStateSelectSql = `
  data_source_id AS dataSourceId,
  route,
  granularity,
  high_water_completed_at AS highWaterCompletedAt,
  active_window_start AS activeWindowStart,
  active_window_end AS activeWindowEnd,
  active_cursor AS activeCursor,
  last_attempt_at AS lastAttemptAt,
  last_success_at AS lastSuccessAt,
  next_run_after AS nextRunAfter,
  last_reconciliation_scheduler_at AS lastReconciliationSchedulerAt,
  last_reconciliation_completed_at AS lastReconciliationCompletedAt,
  failure_count AS failureCount,
  last_error AS lastError,
  active_run_kind AS activeRunKind,
  active_reconciliation_age_months AS activeReconciliationAgeMonths,
  lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt,
  last_import_run_id AS lastImportRunId,
  created_at AS createdAt,
  updated_at AS updatedAt
`
const trackingStateSelectSqlForStateAlias = `
  state.data_source_id AS dataSourceId,
  state.route,
  state.granularity,
  state.high_water_completed_at AS highWaterCompletedAt,
  state.active_window_start AS activeWindowStart,
  state.active_window_end AS activeWindowEnd,
  state.active_cursor AS activeCursor,
  state.last_attempt_at AS lastAttemptAt,
  state.last_success_at AS lastSuccessAt,
  state.next_run_after AS nextRunAfter,
  state.last_reconciliation_scheduler_at AS lastReconciliationSchedulerAt,
  state.last_reconciliation_completed_at AS lastReconciliationCompletedAt,
  state.failure_count AS failureCount,
  state.last_error AS lastError,
  state.active_run_kind AS activeRunKind,
  state.active_reconciliation_age_months AS activeReconciliationAgeMonths,
  state.lease_owner AS leaseOwner,
  state.lease_expires_at AS leaseExpiresAt,
  state.last_import_run_id AS lastImportRunId,
  state.created_at AS createdAt,
  state.updated_at AS updatedAt
`
const reconciliationWorkSelectSql = `
  id,
  data_source_id AS dataSourceId,
  route,
  run_kind AS runKind,
  age_months AS ageMonths,
  period_start AS periodStart,
  period_end AS periodEnd,
  spool_window_id AS spoolWindowId,
  cursor,
  status,
  failure_count AS failureCount,
  last_error AS lastError,
  next_retry_at AS nextRetryAt,
  lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt,
  import_run_id AS importRunId,
  scheduled_at AS scheduledAt,
  started_at AS startedAt,
  completed_at AS completedAt,
  updated_at AS updatedAt
`
const changeLogSelectSql = `
  id,
  data_source_id AS dataSourceId,
  route,
  import_route_id AS importRouteId,
  article_id AS articleId,
  external_article_id AS externalArticleId,
  source_record_key AS sourceRecordKey,
  change_kind AS changeKind,
  previous_source_record_hash AS previousSourceRecordHash,
  next_source_record_hash AS nextSourceRecordHash,
  TO_JSON(changed_fields) AS changedFields,
  TO_JSON(previous_snapshot) AS previousSnapshot,
  TO_JSON(next_snapshot) AS nextSnapshot,
  import_run_id AS importRunId,
  run_kind AS runKind,
  detected_at AS detectedAt,
  created_at AS createdAt
`

const getJsonSqlLiteral = (value: unknown): string => {
  return value === null || value === undefined ? 'NULL' : `CAST(${getSqlLiteral(JSON.stringify(value))} AS JSON)`
}

const getRequiredDateValue = (value: unknown, fieldName: string): Date => {
  const date = getDateValue(value)

  if (!date) {
    throw new Error(`Invalid ${fieldName}`)
  }

  return date
}

const getTrackingGranularity = (value: string): DataSourceTrackingGranularity => {
  if (value === 'day' || value === 'hour' || value === 'minute' || value === 'cursor') {
    return value
  }

  throw new Error(`Invalid data source tracking granularity: ${value}`)
}

const getTrackingRunKind = (value: string | null): DataSourceTrackingRunKind | null => {
  if (value === null || value === 'incremental' || value === 'reconciliation') {
    return value
  }

  throw new Error(`Invalid data source tracking run kind: ${value}`)
}

const getReconciliationRunKind = (value: string): DataSourceReconciliationRunKind => {
  if (value === 'automatic_age_bucket' || value === 'manual_full_range') {
    return value
  }

  throw new Error(`Invalid data source reconciliation run kind: ${value}`)
}

const getReconciliationWorkStatus = (value: string): DataSourceReconciliationWorkStatus => {
  if (value === 'queued' || value === 'running' || value === 'completed' || value === 'failed') {
    return value
  }

  throw new Error(`Invalid data source reconciliation work status: ${value}`)
}

const getArticleChangeKind = (value: string): DataSourceArticleChangeKind => {
  if (
    value === 'article_added'
    || value === 'source_record_changed'
    || value === 'canonical_article_changed'
    || value === 'source_record_deleted'
    || value === 'source_record_restored'
  ) {
    return value
  }

  throw new Error(`Invalid data source article change kind: ${value}`)
}

const getArticleChangeRunKind = (value: string): DataSourceArticleChangeRunKind => {
  if (value === 'incremental' || value === 'automatic_age_bucket' || value === 'manual_full_range') {
    return value
  }

  throw new Error(`Invalid data source article change run kind: ${value}`)
}

const getNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null
  }

  const numericValue = Number(value)

  return Number.isFinite(numericValue) ? numericValue : null
}

const getTrackingStateRecordFromRow = (row: DataSourceTrackingStateRow): DataSourceTrackingStateRecord => {
  return {
    activeCursor: row.activeCursor,
    activeReconciliationAgeMonths: getNumberOrNull(row.activeReconciliationAgeMonths),
    activeRunKind: getTrackingRunKind(row.activeRunKind),
    activeWindowEnd: getDateValue(row.activeWindowEnd),
    activeWindowStart: getDateValue(row.activeWindowStart),
    createdAt: getRequiredDateValue(row.createdAt, 'createdAt'),
    dataSourceId: row.dataSourceId,
    failureCount: Number(row.failureCount ?? 0),
    granularity: getTrackingGranularity(row.granularity),
    highWaterCompletedAt: getDateValue(row.highWaterCompletedAt),
    lastAttemptAt: getDateValue(row.lastAttemptAt),
    lastError: row.lastError,
    lastImportRunId: row.lastImportRunId,
    lastReconciliationCompletedAt: getDateValue(row.lastReconciliationCompletedAt),
    lastReconciliationSchedulerAt: getDateValue(row.lastReconciliationSchedulerAt),
    lastSuccessAt: getDateValue(row.lastSuccessAt),
    leaseExpiresAt: getDateValue(row.leaseExpiresAt),
    leaseOwner: row.leaseOwner,
    nextRunAfter: getDateValue(row.nextRunAfter),
    route: row.route,
    updatedAt: getRequiredDateValue(row.updatedAt, 'updatedAt'),
  }
}

const getReconciliationWorkRecordFromRow = (
  row: DataSourceReconciliationWorkRow,
): DataSourceReconciliationWorkRecord => {
  return {
    ageMonths: getNumberOrNull(row.ageMonths),
    completedAt: getDateValue(row.completedAt),
    cursor: row.cursor,
    dataSourceId: row.dataSourceId,
    failureCount: Number(row.failureCount ?? 0),
    id: row.id,
    importRunId: row.importRunId,
    lastError: row.lastError,
    leaseExpiresAt: getDateValue(row.leaseExpiresAt),
    leaseOwner: row.leaseOwner,
    nextRetryAt: getDateValue(row.nextRetryAt),
    periodEnd: getRequiredDateValue(row.periodEnd, 'periodEnd'),
    periodStart: getRequiredDateValue(row.periodStart, 'periodStart'),
    route: row.route,
    runKind: getReconciliationRunKind(row.runKind),
    scheduledAt: getRequiredDateValue(row.scheduledAt, 'scheduledAt'),
    spoolWindowId: row.spoolWindowId,
    startedAt: getDateValue(row.startedAt),
    status: getReconciliationWorkStatus(row.status),
    updatedAt: getRequiredDateValue(row.updatedAt, 'updatedAt'),
  }
}

const getArticleChangeLogRecordFromRow = (row: DataSourceArticleChangeLogRow): DataSourceArticleChangeLogRecord => {
  return {
    articleId: row.articleId,
    changeKind: getArticleChangeKind(row.changeKind),
    changedFields: getJsonValue(row.changedFields),
    createdAt: getRequiredDateValue(row.createdAt, 'createdAt'),
    dataSourceId: row.dataSourceId,
    detectedAt: getRequiredDateValue(row.detectedAt, 'detectedAt'),
    externalArticleId: row.externalArticleId,
    id: row.id,
    importRouteId: row.importRouteId,
    importRunId: row.importRunId,
    nextSnapshot: getJsonValue(row.nextSnapshot),
    nextSourceRecordHash: row.nextSourceRecordHash,
    previousSnapshot: getJsonValue(row.previousSnapshot),
    previousSourceRecordHash: row.previousSourceRecordHash,
    route: row.route,
    runKind: getArticleChangeRunKind(row.runKind),
    sourceRecordKey: row.sourceRecordKey,
  }
}

const getTrackingReconcileScheduleMonthsSqlLiteral = (months?: number[]) => {
  const normalized = Array.from(
    new Set(
      (months ?? defaultTrackingReconcileScheduleMonths).filter((month) => {
        return Number.isInteger(month) && month > 0 && month <= maxTrackingReconcileScheduleMonth
      }),
    ),
  )

  return getJsonSqlLiteral(normalized.length > 0 ? normalized : defaultTrackingReconcileScheduleMonths)
}

const getSetParts = (updates: UpdateTrackingStateInput, now: Date): string[] => {
  const setParts = [`updated_at = ${getSqlLiteral(now)}`]

  if (Object.hasOwn(updates, 'activeCursor')) {
    setParts.push(`active_cursor = ${getSqlLiteral(updates.activeCursor)}`)
  }

  if (Object.hasOwn(updates, 'activeReconciliationAgeMonths')) {
    setParts.push(`active_reconciliation_age_months = ${getSqlLiteral(updates.activeReconciliationAgeMonths)}`)
  }

  if (Object.hasOwn(updates, 'activeRunKind')) {
    setParts.push(`active_run_kind = ${getSqlLiteral(updates.activeRunKind)}`)
  }

  if (Object.hasOwn(updates, 'activeWindowEnd')) {
    setParts.push(`active_window_end = ${getSqlLiteral(updates.activeWindowEnd)}`)
  }

  if (Object.hasOwn(updates, 'activeWindowStart')) {
    setParts.push(`active_window_start = ${getSqlLiteral(updates.activeWindowStart)}`)
  }

  if (Object.hasOwn(updates, 'granularity')) {
    setParts.push(`granularity = ${getSqlLiteral(updates.granularity)}`)
  }

  if (Object.hasOwn(updates, 'lastImportRunId')) {
    setParts.push(`last_import_run_id = ${getSqlLiteral(updates.lastImportRunId)}`)
  }

  if (Object.hasOwn(updates, 'lastReconciliationCompletedAt')) {
    setParts.push(`last_reconciliation_completed_at = ${getSqlLiteral(updates.lastReconciliationCompletedAt)}`)
  }

  if (Object.hasOwn(updates, 'lastReconciliationSchedulerAt')) {
    setParts.push(`last_reconciliation_scheduler_at = ${getSqlLiteral(updates.lastReconciliationSchedulerAt)}`)
  }

  if (Object.hasOwn(updates, 'nextRunAfter')) {
    setParts.push(`next_run_after = ${getSqlLiteral(updates.nextRunAfter)}`)
  }

  if (Object.hasOwn(updates, 'route')) {
    setParts.push(`route = ${getSqlLiteral(updates.route)}`)
  }

  return setParts
}

const getLeaseOwnerClause = (leaseOwner: string | null | undefined) => {
  return leaseOwner ? `AND lease_owner = ${getSqlLiteral(leaseOwner)}` : ''
}

const getManualReconciliationAttemptId = () => {
  return `data-source-reconciliation-manual-${globalThis.crypto.randomUUID()}`
}

const millisecondsPerDay = 24 * 60 * 60 * 1000

const getUtcDayStart = (date: Date) => {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

const getUtcMonthStart = (date: Date) => {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

const addUtcMonths = (date: Date, months: number) => {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1))
}

const addUtcDays = (date: Date, days: number) => {
  return new Date(getUtcDayStart(date).getTime() + days * millisecondsPerDay)
}

const maxDate = (left: Date, right: Date) => {
  return left.getTime() >= right.getTime() ? left : right
}

const minDate = (left: Date, right: Date) => {
  return left.getTime() <= right.getTime() ? left : right
}

const getTrackingReconcileScheduleMonths = (value: unknown) => {
  const parsedValue = getJsonValue(value)
  const candidateMonths = Array.isArray(parsedValue) ? parsedValue : defaultTrackingReconcileScheduleMonths
  const months = Array.from(
    new Set(
      candidateMonths
        .map((month) => {
          return Number(month)
        })
        .filter((month) => {
          return Number.isInteger(month) && month > 0 && month <= maxTrackingReconcileScheduleMonth
        }),
    ),
  )

  return months.length > 0
    ? months.sort((left, right) => {
        return left - right
      })
    : defaultTrackingReconcileScheduleMonths
}

export const getDataSourceReconciliationWorkId = (input: {
  ageMonths: number | null
  dataSourceId: string
  periodEnd: Date
  periodStart: Date
  runKind: DataSourceReconciliationRunKind
}) => {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        ageMonths: input.ageMonths,
        dataSourceId: input.dataSourceId,
        periodEnd: input.periodEnd.toISOString(),
        periodStart: input.periodStart.toISOString(),
        runKind: input.runKind,
      }),
    )
    .digest('hex')

  return `data-source-reconciliation-${digest.slice(0, 32)}`
}

const getArticleChangeLogId = (input: InsertArticleChangeLogInput) => {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        articleId: input.articleId ?? null,
        changeKind: input.changeKind,
        dataSourceId: input.dataSourceId,
        externalArticleId: input.externalArticleId ?? null,
        nextSourceRecordHash: input.nextSourceRecordHash ?? null,
        previousSourceRecordHash: input.previousSourceRecordHash ?? null,
        route: input.route,
        runKind: input.runKind,
        sourceRecordKey: input.sourceRecordKey ?? null,
      }),
    )
    .digest('hex')

  return `data-source-change-${digest.slice(0, 32)}`
}

export const createDataSourceTrackingRepository = (
  database: DataSourceTrackingDatabaseRunner = getAppDatabaseService(),
) => {
  const getTrackingState = async (dataSourceId: string): Promise<DataSourceTrackingStateRecord | null> => {
    const [row] = await database.queryJson<DataSourceTrackingStateRow>(
      `
      SELECT ${trackingStateSelectSql}
      FROM app.data_source_tracking_state
      WHERE data_source_id = ${getSqlLiteral(dataSourceId)}
      LIMIT 1
    `,
      trackingRepositoryWorkload('dataSourceTracking.state.get', 1),
    )

    return row ? getTrackingStateRecordFromRow(row) : null
  }

  return {
    claimDueSource: async (input: {
      dataSourceId: string
      leaseExpiresAt: Date
      leaseOwner: string
      now?: Date
    }): Promise<DataSourceTrackingStateRecord | null> => {
      const now = input.now ?? new Date()
      const [row] = await database.queryJson<DataSourceTrackingStateRow>(
        `
        UPDATE app.data_source_tracking_state
        SET lease_owner = ${getSqlLiteral(input.leaseOwner)},
            lease_expires_at = ${getSqlLiteral(input.leaseExpiresAt)},
            last_attempt_at = ${getSqlLiteral(now)},
            updated_at = ${getSqlLiteral(now)}
        WHERE data_source_id = ${getSqlLiteral(input.dataSourceId)}
          AND (
            lease_owner IS NULL
            OR lease_expires_at IS NULL
            OR lease_expires_at <= ${getSqlLiteral(now)}
          )
          AND EXISTS (
            SELECT 1
            FROM app.data_source data_source
            WHERE data_source.id = app.data_source_tracking_state.data_source_id
              AND data_source.tracking_enabled = TRUE
              AND data_source.archived = FALSE
              AND (
                app.data_source_tracking_state.active_window_start IS NOT NULL
                OR data_source.date_to IS NULL
                OR app.data_source_tracking_state.high_water_completed_at IS NULL
                OR CAST((app.data_source_tracking_state.high_water_completed_at AT TIME ZONE 'UTC') AS DATE)
                  < CAST((data_source.date_to AT TIME ZONE 'UTC') AS DATE)
              )
          )
        RETURNING ${trackingStateSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.state.claimDueSource', 1),
      )

      return row ? getTrackingStateRecordFromRow(row) : null
    },
    claimImportLease: async (input: {
      dataSourceId: string
      leaseExpiresAt: Date
      leaseOwner: string
      now?: Date
    }): Promise<DataSourceTrackingStateRecord | null> => {
      const now = input.now ?? new Date()
      const [row] = await database.queryJson<DataSourceTrackingStateRow>(
        `
        UPDATE app.data_source_tracking_state
        SET lease_owner = ${getSqlLiteral(input.leaseOwner)},
            lease_expires_at = ${getSqlLiteral(input.leaseExpiresAt)},
            last_attempt_at = ${getSqlLiteral(now)},
            updated_at = ${getSqlLiteral(now)}
        WHERE data_source_id = ${getSqlLiteral(input.dataSourceId)}
          AND (
            lease_owner IS NULL
            OR lease_expires_at IS NULL
            OR lease_expires_at <= ${getSqlLiteral(now)}
          )
        RETURNING ${trackingStateSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.state.claimImportLease', 1),
      )

      return row ? getTrackingStateRecordFromRow(row) : null
    },
    createOrUpdateTrackingState: async (
      input: CreateOrUpdateTrackingStateInput,
    ): Promise<DataSourceTrackingStateRecord> => {
      const now = new Date()
      const [row] = await database.queryJson<DataSourceTrackingStateRow>(
        `
        INSERT INTO app.data_source_tracking_state (
          data_source_id,
          route,
          granularity,
          next_run_after,
          created_at,
          updated_at
        )
        VALUES (
          ${getSqlLiteral(input.dataSourceId)},
          ${getSqlLiteral(input.route)},
          ${getSqlLiteral(input.granularity)},
          ${getSqlLiteral(input.nextRunAfter ?? null)},
          ${getSqlLiteral(now)},
          ${getSqlLiteral(now)}
        )
        ON CONFLICT(data_source_id) DO UPDATE SET
          route = EXCLUDED.route,
          granularity = EXCLUDED.granularity,
          high_water_completed_at =
            CASE
              WHEN app.data_source_tracking_state.route <> EXCLUDED.route THEN NULL
              ELSE app.data_source_tracking_state.high_water_completed_at
            END,
          active_window_start =
            CASE
              WHEN app.data_source_tracking_state.route <> EXCLUDED.route THEN NULL
              ELSE app.data_source_tracking_state.active_window_start
            END,
          active_window_end =
            CASE
              WHEN app.data_source_tracking_state.route <> EXCLUDED.route THEN NULL
              ELSE app.data_source_tracking_state.active_window_end
            END,
          active_cursor =
            CASE
              WHEN app.data_source_tracking_state.route <> EXCLUDED.route THEN NULL
              ELSE app.data_source_tracking_state.active_cursor
            END,
          active_run_kind =
            CASE
              WHEN app.data_source_tracking_state.route <> EXCLUDED.route THEN NULL
              ELSE app.data_source_tracking_state.active_run_kind
            END,
          active_reconciliation_age_months =
            CASE
              WHEN app.data_source_tracking_state.route <> EXCLUDED.route THEN NULL
              ELSE app.data_source_tracking_state.active_reconciliation_age_months
            END,
          failure_count =
            CASE
              WHEN app.data_source_tracking_state.route <> EXCLUDED.route THEN 0
              ELSE app.data_source_tracking_state.failure_count
            END,
          last_error =
            CASE
              WHEN app.data_source_tracking_state.route <> EXCLUDED.route THEN NULL
              ELSE app.data_source_tracking_state.last_error
            END,
          next_run_after = EXCLUDED.next_run_after,
          updated_at = EXCLUDED.updated_at
        RETURNING ${trackingStateSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.state.createOrUpdate', 1),
      )

      if (!row) {
        throw new Error('Failed to create data source tracking state')
      }

      return getTrackingStateRecordFromRow(row)
    },
    getTrackingState,
    recordReconciliationSchedulerRun: async (input: {
      dataSourceId: string
      now?: Date
    }): Promise<DataSourceTrackingStateRecord | null> => {
      return (
        (
          await database.queryJson<DataSourceTrackingStateRow>(
            `
          UPDATE app.data_source_tracking_state
          SET last_reconciliation_scheduler_at = ${getSqlLiteral(input.now ?? new Date())},
              updated_at = ${getSqlLiteral(input.now ?? new Date())}
          WHERE data_source_id = ${getSqlLiteral(input.dataSourceId)}
          RETURNING ${trackingStateSelectSql}
        `,
            trackingRepositoryWorkload('dataSourceTracking.state.recordSchedulerRun', 1),
          )
        )
          .map(getTrackingStateRecordFromRow)
          .at(0) ?? null
      )
    },
    recordTrackingFailure: async (input: TrackingFailureInput): Promise<DataSourceTrackingStateRecord | null> => {
      const now = input.now ?? new Date()
      const [row] = await database.queryJson<DataSourceTrackingStateRow>(
        `
        UPDATE app.data_source_tracking_state
        SET failure_count = failure_count + 1,
            last_attempt_at = ${getSqlLiteral(now)},
            last_error = ${getSqlLiteral(input.error)},
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_run_after = ${getSqlLiteral(input.nextRunAfter ?? null)},
            updated_at = ${getSqlLiteral(now)}
        WHERE data_source_id = ${getSqlLiteral(input.dataSourceId)}
          ${getLeaseOwnerClause(input.leaseOwner)}
        RETURNING ${trackingStateSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.state.failure', 1),
      )

      return row ? getTrackingStateRecordFromRow(row) : null
    },
    recordTrackingSuccess: async (input: TrackingSuccessInput): Promise<DataSourceTrackingStateRecord | null> => {
      const now = input.now ?? new Date()
      const [row] = await database.queryJson<DataSourceTrackingStateRow>(
        `
        UPDATE app.data_source_tracking_state
        SET high_water_completed_at =
              CASE
                WHEN high_water_completed_at IS NULL THEN ${getSqlLiteral(input.highWaterCompletedAt)}
                WHEN high_water_completed_at < ${getSqlLiteral(input.highWaterCompletedAt)}
                  THEN ${getSqlLiteral(input.highWaterCompletedAt)}
                ELSE high_water_completed_at
              END,
            active_window_start = NULL,
            active_window_end = NULL,
            active_cursor = NULL,
            active_run_kind = NULL,
            active_reconciliation_age_months = NULL,
            failure_count = 0,
            last_error = NULL,
            last_success_at = ${getSqlLiteral(now)},
            next_run_after = ${getSqlLiteral(input.nextRunAfter ?? null)},
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_import_run_id = ${getSqlLiteral(input.importRunId ?? null)},
            updated_at = ${getSqlLiteral(now)}
        WHERE data_source_id = ${getSqlLiteral(input.dataSourceId)}
          ${getLeaseOwnerClause(input.leaseOwner)}
        RETURNING ${trackingStateSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.state.success', 1),
      )

      return row ? getTrackingStateRecordFromRow(row) : null
    },
    recordReconciliationSuccess: async (
      input: ReconciliationSuccessInput,
    ): Promise<DataSourceTrackingStateRecord | null> => {
      const now = input.now ?? new Date()
      const [row] = await database.queryJson<DataSourceTrackingStateRow>(
        `
        UPDATE app.data_source_tracking_state
        SET active_window_start = NULL,
            active_window_end = NULL,
            active_cursor = NULL,
            active_run_kind = NULL,
            active_reconciliation_age_months = NULL,
            failure_count = 0,
            last_error = NULL,
            last_reconciliation_completed_at = ${getSqlLiteral(now)},
            last_import_run_id = ${getSqlLiteral(input.importRunId ?? null)},
            updated_at = ${getSqlLiteral(now)}
        WHERE data_source_id = ${getSqlLiteral(input.dataSourceId)}
        RETURNING ${trackingStateSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.state.reconciliationSuccess', 1),
      )

      return row ? getTrackingStateRecordFromRow(row) : null
    },
    releaseSourceLease: async (input: {
      dataSourceId: string
      leaseOwner: string
      now?: Date
    }): Promise<DataSourceTrackingStateRecord | null> => {
      const [row] = await database.queryJson<DataSourceTrackingStateRow>(
        `
        UPDATE app.data_source_tracking_state
        SET lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ${getSqlLiteral(input.now ?? new Date())}
        WHERE data_source_id = ${getSqlLiteral(input.dataSourceId)}
          AND lease_owner = ${getSqlLiteral(input.leaseOwner)}
        RETURNING ${trackingStateSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.state.release', 1),
      )

      return row ? getTrackingStateRecordFromRow(row) : null
    },
    renewSourceLease: async (input: {
      dataSourceId: string
      leaseExpiresAt: Date
      leaseOwner: string
      now?: Date
    }): Promise<DataSourceTrackingStateRecord | null> => {
      const now = input.now ?? new Date()
      const [row] = await database.queryJson<DataSourceTrackingStateRow>(
        `
        UPDATE app.data_source_tracking_state
        SET lease_expires_at = ${getSqlLiteral(input.leaseExpiresAt)},
            updated_at = ${getSqlLiteral(now)}
        WHERE data_source_id = ${getSqlLiteral(input.dataSourceId)}
          AND lease_owner = ${getSqlLiteral(input.leaseOwner)}
          AND EXISTS (
            SELECT 1
            FROM app.data_source data_source
            WHERE data_source.id = app.data_source_tracking_state.data_source_id
              AND data_source.tracking_enabled = TRUE
              AND data_source.archived = FALSE
          )
        RETURNING ${trackingStateSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.state.renewLease', 1),
      )

      return row ? getTrackingStateRecordFromRow(row) : null
    },
    selectDueSources: async (input: {
      limit: number
      now?: Date
      routes?: string[]
    }): Promise<DataSourceTrackingStateRecord[]> => {
      const now = input.now ?? new Date()
      const routeClause =
        input.routes && input.routes.length > 0
          ? `AND state.route IN (${input.routes.map(getSqlLiteral).join(', ')})`
          : ''
      const rows = await database.queryJson<DataSourceTrackingStateRow>(
        `
        SELECT ${trackingStateSelectSqlForStateAlias}
        FROM app.data_source_tracking_state state
        INNER JOIN app.data_source data_source ON data_source.id = state.data_source_id
        WHERE data_source.tracking_enabled = TRUE
          AND data_source.archived = FALSE
          AND (
            state.active_window_start IS NOT NULL
            OR data_source.date_to IS NULL
            OR state.high_water_completed_at IS NULL
            OR CAST((state.high_water_completed_at AT TIME ZONE 'UTC') AS DATE)
              < CAST((data_source.date_to AT TIME ZONE 'UTC') AS DATE)
          )
          AND (state.next_run_after IS NULL OR state.next_run_after <= ${getSqlLiteral(now)})
          AND (
            state.lease_owner IS NULL
            OR state.lease_expires_at IS NULL
            OR state.lease_expires_at <= ${getSqlLiteral(now)}
          )
          ${routeClause}
        ORDER BY state.next_run_after ASC NULLS FIRST, state.updated_at ASC, state.data_source_id ASC
        LIMIT ${Math.max(0, Math.trunc(input.limit))}
      `,
        trackingRepositoryWorkload('dataSourceTracking.state.selectDue', input.limit),
      )

      return rows.map(getTrackingStateRecordFromRow)
    },
    setTrackingEnabled: async (input: {
      dataSourceId: string
      enabled: boolean
      reconcileScheduleMonths?: number[]
    }): Promise<void> => {
      await database.run(
        `
        UPDATE app.data_source
        SET tracking_enabled = ${getSqlLiteral(input.enabled)},
            tracking_reconcile_schedule_months = ${
              input.reconcileScheduleMonths === undefined
                ? 'tracking_reconcile_schedule_months'
                : getTrackingReconcileScheduleMonthsSqlLiteral(input.reconcileScheduleMonths)
            },
            updated_at = ${getSqlLiteral(new Date())}
        WHERE id = ${getSqlLiteral(input.dataSourceId)}
      `,
        trackingRepositoryWorkload('dataSourceTracking.state.setEnabled'),
      )
    },
    startTrackingWindow: async (input: {
      activeCursor?: string | null
      ageMonths?: number | null
      dataSourceId: string
      runKind: DataSourceTrackingRunKind
      windowEnd: Date
      windowStart: Date
    }): Promise<DataSourceTrackingStateRecord | null> => {
      return (
        (
          await database.queryJson<DataSourceTrackingStateRow>(
            `
          UPDATE app.data_source_tracking_state
          SET active_window_start = ${getSqlLiteral(input.windowStart)},
              active_window_end = ${getSqlLiteral(input.windowEnd)},
              active_cursor = ${getSqlLiteral(input.activeCursor ?? null)},
              active_run_kind = ${getSqlLiteral(input.runKind)},
              active_reconciliation_age_months = ${getSqlLiteral(input.ageMonths ?? null)},
              updated_at = ${getSqlLiteral(new Date())}
          WHERE data_source_id = ${getSqlLiteral(input.dataSourceId)}
          RETURNING ${trackingStateSelectSql}
        `,
            trackingRepositoryWorkload('dataSourceTracking.state.startWindow', 1),
          )
        )
          .map(getTrackingStateRecordFromRow)
          .at(0) ?? null
      )
    },
    updateTrackingState: async (
      dataSourceId: string,
      updates: UpdateTrackingStateInput,
      now = new Date(),
    ): Promise<DataSourceTrackingStateRecord | null> => {
      const setParts = getSetParts(updates, now)
      const [row] = await database.queryJson<DataSourceTrackingStateRow>(
        `
        UPDATE app.data_source_tracking_state
        SET ${setParts.join(', ')}
        WHERE data_source_id = ${getSqlLiteral(dataSourceId)}
        RETURNING ${trackingStateSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.state.update', 1),
      )

      return row ? getTrackingStateRecordFromRow(row) : null
    },
  }
}

export const createDataSourceReconciliationWorkRepository = (
  database: DataSourceTrackingDatabaseRunner = getAppDatabaseService(),
) => {
  const getWorkById = async (id: string): Promise<DataSourceReconciliationWorkRecord | null> => {
    const [row] = await database.queryJson<DataSourceReconciliationWorkRow>(
      `
      SELECT ${reconciliationWorkSelectSql}
      FROM app.data_source_reconciliation_work
      WHERE id = ${getSqlLiteral(id)}
      LIMIT 1
    `,
      trackingRepositoryWorkload('dataSourceTracking.reconciliation.get', 1),
    )

    return row ? getReconciliationWorkRecordFromRow(row) : null
  }

  return {
    claimNextWork: async (input: {
      leaseExpiresAt: Date
      leaseOwner: string
      now?: Date
      route?: string
    }): Promise<DataSourceReconciliationWorkRecord | null> => {
      const now = input.now ?? new Date()
      const routeClause = input.route ? `AND work.route = ${getSqlLiteral(input.route)}` : ''
      const [row] = await database.queryJson<DataSourceReconciliationWorkRow>(
        `
        WITH claim AS (
          SELECT work.id
          FROM app.data_source_reconciliation_work work
          INNER JOIN app.data_source data_source ON data_source.id = work.data_source_id
          WHERE work.status IN ('queued', 'failed', 'running')
            AND data_source.tracking_enabled = TRUE
            AND data_source.archived = FALSE
            AND data_source.import_route = work.route
            AND (
              work.run_kind <> 'automatic_age_bucket'
              OR (
                work.age_months IS NOT NULL
                AND json_contains(data_source.tracking_reconcile_schedule_months, CAST(work.age_months AS JSON))
              )
            )
            AND (
              work.status != 'failed'
              OR work.next_retry_at IS NULL
              OR work.next_retry_at <= ${getSqlLiteral(now)}
            )
            AND (
              work.status != 'running'
              OR work.lease_owner IS NULL
              OR work.lease_expires_at IS NULL
              OR work.lease_expires_at <= ${getSqlLiteral(now)}
            )
            ${routeClause}
          ORDER BY work.scheduled_at ASC, work.period_start ASC, work.id ASC
          LIMIT 1
        )
        UPDATE app.data_source_reconciliation_work
        SET status = 'running',
            lease_owner = ${getSqlLiteral(input.leaseOwner)},
            lease_expires_at = ${getSqlLiteral(input.leaseExpiresAt)},
            started_at = COALESCE(started_at, ${getSqlLiteral(now)}),
            updated_at = ${getSqlLiteral(now)}
        FROM claim
        WHERE data_source_reconciliation_work.id = claim.id
	        RETURNING ${reconciliationWorkSelectSql}
	      `,
        trackingRepositoryWorkload('dataSourceTracking.reconciliation.claim', 1),
      )

      return row ? getReconciliationWorkRecordFromRow(row) : null
    },
    getWorkById,
    markWorkCompleted: async (input: {
      id: string
      importRunId?: string | null
      leaseOwner?: string | null
      now?: Date
      spoolWindowId?: string | null
    }): Promise<DataSourceReconciliationWorkRecord | null> => {
      const now = input.now ?? new Date()
      const [row] = await database.queryJson<DataSourceReconciliationWorkRow>(
        `
        UPDATE app.data_source_reconciliation_work
        SET status = 'completed',
            completed_at = ${getSqlLiteral(now)},
            failure_count = 0,
            last_error = NULL,
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            import_run_id = ${getSqlLiteral(input.importRunId ?? null)},
            spool_window_id = COALESCE(${getSqlLiteral(input.spoolWindowId ?? null)}, spool_window_id),
            updated_at = ${getSqlLiteral(now)}
        WHERE id = ${getSqlLiteral(input.id)}
          ${getLeaseOwnerClause(input.leaseOwner)}
        RETURNING ${reconciliationWorkSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.reconciliation.completed', 1),
      )

      return row ? getReconciliationWorkRecordFromRow(row) : null
    },
    markWorkCompletedForSpoolWindow: async (input: {
      importRunId?: string | null
      now?: Date
      spoolWindowId: string
    }): Promise<DataSourceReconciliationWorkRecord | null> => {
      const now = input.now ?? new Date()
      const [row] = await database.queryJson<DataSourceReconciliationWorkRow>(
        `
        UPDATE app.data_source_reconciliation_work
        SET status = 'completed',
            completed_at = ${getSqlLiteral(now)},
            failure_count = 0,
            last_error = NULL,
            next_retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            import_run_id = ${getSqlLiteral(input.importRunId ?? null)},
            updated_at = ${getSqlLiteral(now)}
        WHERE spool_window_id = ${getSqlLiteral(input.spoolWindowId)}
        RETURNING ${reconciliationWorkSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.reconciliation.completedForSpoolWindow', 1),
      )

      return row ? getReconciliationWorkRecordFromRow(row) : null
    },
    markWorkFailed: async (input: {
      error: string
      id: string
      leaseOwner?: string | null
      nextRetryAt?: Date | null
      now?: Date
    }): Promise<DataSourceReconciliationWorkRecord | null> => {
      const now = input.now ?? new Date()
      const [row] = await database.queryJson<DataSourceReconciliationWorkRow>(
        `
        UPDATE app.data_source_reconciliation_work
        SET status = 'failed',
            failure_count = failure_count + 1,
            last_error = ${getSqlLiteral(input.error)},
            next_retry_at = ${getSqlLiteral(input.nextRetryAt ?? null)},
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ${getSqlLiteral(now)}
        WHERE id = ${getSqlLiteral(input.id)}
          ${getLeaseOwnerClause(input.leaseOwner)}
        RETURNING ${reconciliationWorkSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.reconciliation.failed', 1),
      )

      return row ? getReconciliationWorkRecordFromRow(row) : null
    },
    markWorkFailedForSpoolWindow: async (input: {
      error: string
      nextRetryAt?: Date | null
      now?: Date
      spoolWindowId: string
    }): Promise<DataSourceReconciliationWorkRecord | null> => {
      const now = input.now ?? new Date()
      const [row] = await database.queryJson<DataSourceReconciliationWorkRow>(
        `
        UPDATE app.data_source_reconciliation_work
        SET status = 'failed',
            failure_count = failure_count + 1,
            last_error = ${getSqlLiteral(input.error)},
            next_retry_at = ${getSqlLiteral(input.nextRetryAt ?? null)},
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ${getSqlLiteral(now)}
        WHERE spool_window_id = ${getSqlLiteral(input.spoolWindowId)}
        RETURNING ${reconciliationWorkSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.reconciliation.failedForSpoolWindow', 1),
      )

      return row ? getReconciliationWorkRecordFromRow(row) : null
    },
    releaseWorkLease: async (input: {
      id: string
      leaseOwner: string
      now?: Date
    }): Promise<DataSourceReconciliationWorkRecord | null> => {
      const [row] = await database.queryJson<DataSourceReconciliationWorkRow>(
        `
        UPDATE app.data_source_reconciliation_work
        SET lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ${getSqlLiteral(input.now ?? new Date())}
        WHERE id = ${getSqlLiteral(input.id)}
          AND lease_owner = ${getSqlLiteral(input.leaseOwner)}
        RETURNING ${reconciliationWorkSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.reconciliation.release', 1),
      )

      return row ? getReconciliationWorkRecordFromRow(row) : null
    },
    renewWorkLease: async (input: {
      id: string
      leaseExpiresAt: Date
      leaseOwner: string
      now?: Date
    }): Promise<DataSourceReconciliationWorkRecord | null> => {
      const now = input.now ?? new Date()
      const [row] = await database.queryJson<DataSourceReconciliationWorkRow>(
        `
	        UPDATE app.data_source_reconciliation_work
	        SET lease_expires_at = ${getSqlLiteral(input.leaseExpiresAt)},
	            updated_at = ${getSqlLiteral(now)}
	        WHERE id = ${getSqlLiteral(input.id)}
	          AND lease_owner = ${getSqlLiteral(input.leaseOwner)}
	          AND status = 'running'
	          AND EXISTS (
	            SELECT 1
	            FROM app.data_source data_source
	            WHERE data_source.id = app.data_source_reconciliation_work.data_source_id
	              AND data_source.tracking_enabled = TRUE
	              AND data_source.archived = FALSE
	              AND data_source.import_route = app.data_source_reconciliation_work.route
	          )
	        RETURNING ${reconciliationWorkSelectSql}
	      `,
        trackingRepositoryWorkload('dataSourceTracking.reconciliation.renewLease', 1),
      )

      return row ? getReconciliationWorkRecordFromRow(row) : null
    },
    scheduleDueMonthlyAgeBucketWork: async (
      input: {maxMonths?: number; maxScheduledWork?: number; maxSources?: number; now?: Date; routes?: string[]} = {},
    ): Promise<DataSourceReconciliationWorkRecord[]> => {
      const now = input.now ?? new Date()
      const currentSchedulerMonth = getUtcMonthStart(now)
      const maxMonths = Math.max(1, Math.floor(input.maxMonths ?? 12))
      const maxScheduledWork = Math.max(1, Math.floor(input.maxScheduledWork ?? 1_000))
      const maxSources = Math.max(1, Math.floor(input.maxSources ?? 500))
      const routeClause =
        input.routes && input.routes.length > 0
          ? `AND data_source.import_route IN (${input.routes.map(getSqlLiteral).join(', ')})`
          : ''
      const scheduledWork: DataSourceReconciliationWorkRecord[] = []
      const schedulerBatchSize = 500
      let afterDataSourceId: string | null = null
      let processedSourceCount = 0

      while (processedSourceCount < maxSources && scheduledWork.length < maxScheduledWork) {
        const afterClause = afterDataSourceId ? `AND data_source.id > ${getSqlLiteral(afterDataSourceId)}` : ''
        const pageLimit = Math.min(schedulerBatchSize, maxSources - processedSourceCount)
        const sourceRows: DataSourceReconciliationScheduleSourceRow[] =
          await database.queryJson<DataSourceReconciliationScheduleSourceRow>(
            `
          SELECT
            data_source.id AS dataSourceId,
            data_source.import_route AS route,
            data_source.date_from AS dateFrom,
            data_source.date_to AS dateTo,
            TO_JSON(data_source.tracking_reconcile_schedule_months) AS trackingReconcileScheduleMonths,
            state.last_reconciliation_scheduler_at AS lastReconciliationSchedulerAt
          FROM app.data_source data_source
          INNER JOIN app.data_source_tracking_state state ON state.data_source_id = data_source.id
          WHERE data_source.tracking_enabled = TRUE
            AND data_source.archived = FALSE
            AND data_source.import_route IS NOT NULL
            AND (
              state.last_reconciliation_scheduler_at IS NULL
              OR DATE_TRUNC('month', state.last_reconciliation_scheduler_at) < ${getSqlLiteral(currentSchedulerMonth)}
            )
            ${routeClause}
            ${afterClause}
          ORDER BY data_source.id ASC
          LIMIT ${pageLimit}
        `,
            trackingRepositoryWorkload('dataSourceTracking.reconciliation.scheduleDueMonthly.page', pageLimit),
          )

        if (sourceRows.length === 0) {
          break
        }

        for (const source of sourceRows) {
          if (processedSourceCount >= maxSources || scheduledWork.length >= maxScheduledWork) {
            break
          }

          processedSourceCount += 1
          const rawDateFrom = getDateValue(source.dateFrom)
          const dateFrom = rawDateFrom ? getUtcDayStart(rawDateFrom) : null

          if (!dateFrom) {
            await database.run(
              `
              UPDATE app.data_source_tracking_state
              SET last_reconciliation_scheduler_at = ${getSqlLiteral(now)},
                  updated_at = ${getSqlLiteral(now)}
              WHERE data_source_id = ${getSqlLiteral(source.dataSourceId)}
            `,
              trackingRepositoryWorkload('dataSourceTracking.reconciliation.scheduleDueMonthly.recordSkipped'),
            )
            continue
          }

          const dateTo = getDateValue(source.dateTo)
          const lastSchedulerMonth = getDateValue(source.lastReconciliationSchedulerAt)
          const firstSchedulerMonth = lastSchedulerMonth
            ? addUtcMonths(getUtcMonthStart(lastSchedulerMonth), 1)
            : currentSchedulerMonth
          const scheduleMonths = getTrackingReconcileScheduleMonths(source.trackingReconcileScheduleMonths)
          let processedMonthCount = 0
          let lastProcessedSchedulerMonth: Date | null = null

          for (
            let schedulerMonth = firstSchedulerMonth;
            schedulerMonth.getTime() <= currentSchedulerMonth.getTime();
            schedulerMonth = addUtcMonths(schedulerMonth, 1)
          ) {
            if (processedMonthCount >= maxMonths || scheduledWork.length >= maxScheduledWork) {
              break
            }

            for (const ageMonths of scheduleMonths) {
              const targetMonthStart = addUtcMonths(schedulerMonth, -ageMonths)
              const targetMonthEnd = addUtcMonths(targetMonthStart, 1)
              const periodStart = maxDate(targetMonthStart, dateFrom)
              const periodEnd = dateTo ? minDate(targetMonthEnd, addUtcDays(getUtcDayStart(dateTo), 1)) : targetMonthEnd

              if (periodEnd.getTime() <= periodStart.getTime()) {
                continue
              }

              const id = getDataSourceReconciliationWorkId({
                ageMonths,
                dataSourceId: source.dataSourceId,
                periodEnd,
                periodStart,
                runKind: 'automatic_age_bucket',
              })

              await database.run(
                `
                INSERT INTO app.data_source_reconciliation_work (
                  id,
                  data_source_id,
                  route,
                  run_kind,
                  age_months,
                  period_start,
                  period_end,
                  status,
                  scheduled_at,
                  updated_at
                )
                VALUES (
                  ${getSqlLiteral(id)},
                  ${getSqlLiteral(source.dataSourceId)},
                  ${getSqlLiteral(source.route)},
                  'automatic_age_bucket',
                  ${getSqlLiteral(ageMonths)},
                  ${getSqlLiteral(periodStart)},
                  ${getSqlLiteral(periodEnd)},
                  'queued',
                  ${getSqlLiteral(now)},
                  ${getSqlLiteral(now)}
                )
                ON CONFLICT(id) DO NOTHING
              `,
                trackingRepositoryWorkload('dataSourceTracking.reconciliation.scheduleDueMonthly.insert'),
              )

              const work = await getWorkById(id)

              if (work) {
                scheduledWork.push(work)
              }
            }

            processedMonthCount += 1
            lastProcessedSchedulerMonth = schedulerMonth
          }

          if (lastProcessedSchedulerMonth) {
            await database.run(
              `
              UPDATE app.data_source_tracking_state
              SET last_reconciliation_scheduler_at = ${getSqlLiteral(lastProcessedSchedulerMonth)},
                  updated_at = ${getSqlLiteral(now)}
              WHERE data_source_id = ${getSqlLiteral(source.dataSourceId)}
            `,
              trackingRepositoryWorkload('dataSourceTracking.reconciliation.scheduleDueMonthly.recordRun'),
            )
          }
        }

        afterDataSourceId = sourceRows[sourceRows.length - 1]?.dataSourceId ?? afterDataSourceId
      }

      return scheduledWork
    },
    scheduleWork: async (input: ScheduleReconciliationWorkInput): Promise<DataSourceReconciliationWorkRecord> => {
      const now = input.now ?? new Date()
      const id =
        input.id
        ?? (input.runKind === 'manual_full_range'
          ? getManualReconciliationAttemptId()
          : getDataSourceReconciliationWorkId({
              ageMonths: input.ageMonths,
              dataSourceId: input.dataSourceId,
              periodEnd: input.periodEnd,
              periodStart: input.periodStart,
              runKind: input.runKind,
            }))

      if (!input.id && input.runKind === 'manual_full_range') {
        const [activeManualWork] = await database.queryJson<DataSourceReconciliationWorkRow>(
          `
	          SELECT ${reconciliationWorkSelectSql}
	          FROM app.data_source_reconciliation_work
	          WHERE data_source_id = ${getSqlLiteral(input.dataSourceId)}
	            AND route = ${getSqlLiteral(input.route)}
	            AND run_kind = 'manual_full_range'
	            AND period_start = ${getSqlLiteral(input.periodStart)}
	            AND period_end = ${getSqlLiteral(input.periodEnd)}
	            AND status IN ('queued', 'running', 'failed')
	          ORDER BY scheduled_at DESC, id DESC
	          LIMIT 1
	        `,
          trackingRepositoryWorkload('dataSourceTracking.reconciliation.scheduleManual.getActive', 1),
        )

        if (activeManualWork) {
          return getReconciliationWorkRecordFromRow(activeManualWork)
        }
      }

      await database.run(
        `
        INSERT INTO app.data_source_reconciliation_work (
          id,
          data_source_id,
          route,
          run_kind,
          age_months,
          period_start,
          period_end,
          status,
          scheduled_at,
          updated_at
        )
        VALUES (
          ${getSqlLiteral(id)},
          ${getSqlLiteral(input.dataSourceId)},
          ${getSqlLiteral(input.route)},
          ${getSqlLiteral(input.runKind)},
          ${getSqlLiteral(input.ageMonths)},
          ${getSqlLiteral(input.periodStart)},
          ${getSqlLiteral(input.periodEnd)},
          'queued',
          ${getSqlLiteral(now)},
          ${getSqlLiteral(now)}
        )
        ON CONFLICT(id) DO NOTHING
      `,
        trackingRepositoryWorkload('dataSourceTracking.reconciliation.schedule'),
      )

      const row = await getWorkById(id)

      if (!row) {
        throw new Error('Failed to schedule data source reconciliation work')
      }

      return row
    },
    updateWorkSpoolProgress: async (input: {
      cursor?: string | null
      id: string
      now?: Date
      spoolWindowId?: string | null
    }): Promise<DataSourceReconciliationWorkRecord | null> => {
      const now = input.now ?? new Date()
      const setParts = [`updated_at = ${getSqlLiteral(now)}`]

      if (Object.hasOwn(input, 'cursor')) {
        setParts.push(`cursor = ${getSqlLiteral(input.cursor)}`)
      }

      if (Object.hasOwn(input, 'spoolWindowId')) {
        setParts.push(`spool_window_id = ${getSqlLiteral(input.spoolWindowId)}`)
      }

      const [row] = await database.queryJson<DataSourceReconciliationWorkRow>(
        `
        UPDATE app.data_source_reconciliation_work
        SET ${setParts.join(', ')}
        WHERE id = ${getSqlLiteral(input.id)}
        RETURNING ${reconciliationWorkSelectSql}
      `,
        trackingRepositoryWorkload('dataSourceTracking.reconciliation.spoolProgress', 1),
      )

      return row ? getReconciliationWorkRecordFromRow(row) : null
    },
  }
}

export const createDataSourceArticleChangeLogRepository = (
  database: DataSourceTrackingDatabaseRunner = getAppDatabaseService(),
) => {
  const getChangeById = async (id: string): Promise<DataSourceArticleChangeLogRecord | null> => {
    const [row] = await database.queryJson<DataSourceArticleChangeLogRow>(
      `
      SELECT ${changeLogSelectSql}
      FROM app.data_source_article_change_log
      WHERE id = ${getSqlLiteral(id)}
      LIMIT 1
    `,
      trackingRepositoryWorkload('dataSourceTracking.changeLog.get', 1),
    )

    return row ? getArticleChangeLogRecordFromRow(row) : null
  }

  return {
    getChangeById,
    insertChange: async (input: InsertArticleChangeLogInput): Promise<DataSourceArticleChangeLogRecord> => {
      const now = new Date()
      const id = input.id ?? getArticleChangeLogId(input)
      const detectedAt = input.detectedAt ?? now

      await database.run(
        `
        INSERT INTO app.data_source_article_change_log (
          id,
          data_source_id,
          route,
          import_route_id,
          article_id,
          external_article_id,
          source_record_key,
          change_kind,
          previous_source_record_hash,
          next_source_record_hash,
          changed_fields,
          previous_snapshot,
          next_snapshot,
          import_run_id,
          run_kind,
          detected_at,
          created_at
        )
        VALUES (
          ${getSqlLiteral(id)},
          ${getSqlLiteral(input.dataSourceId)},
          ${getSqlLiteral(input.route)},
          ${getSqlLiteral(input.importRouteId ?? null)},
          ${getSqlLiteral(input.articleId ?? null)},
          ${getSqlLiteral(input.externalArticleId ?? null)},
          ${getSqlLiteral(input.sourceRecordKey ?? null)},
          ${getSqlLiteral(input.changeKind)},
          ${getSqlLiteral(input.previousSourceRecordHash ?? null)},
          ${getSqlLiteral(input.nextSourceRecordHash ?? null)},
          ${getJsonSqlLiteral(input.changedFields ?? null)},
          ${getJsonSqlLiteral(input.previousSnapshot ?? null)},
          ${getJsonSqlLiteral(input.nextSnapshot ?? null)},
          ${getSqlLiteral(input.importRunId ?? null)},
          ${getSqlLiteral(input.runKind)},
          ${getSqlLiteral(detectedAt)},
          ${getSqlLiteral(now)}
        )
        ON CONFLICT(id) DO NOTHING
      `,
        trackingRepositoryWorkload('dataSourceTracking.changeLog.insert'),
      )

      const row = await getChangeById(id)

      if (!row) {
        throw new Error('Failed to insert data source article change log row')
      }

      return row
    },
    listChanges: async (input: {
      after?: DataSourceArticleChangeLogCursor | null
      changeKinds?: DataSourceArticleChangeKind[]
      dataSourceId: string
      limit: number
      runKinds?: DataSourceArticleChangeRunKind[]
    }): Promise<DataSourceArticleChangeLogRecord[]> => {
      const filters = [`data_source_id = ${getSqlLiteral(input.dataSourceId)}`]

      if (input.changeKinds && input.changeKinds.length > 0) {
        filters.push(`change_kind IN (${input.changeKinds.map(getSqlLiteral).join(', ')})`)
      }

      if (input.runKinds && input.runKinds.length > 0) {
        filters.push(`run_kind IN (${input.runKinds.map(getSqlLiteral).join(', ')})`)
      }

      if (input.after) {
        filters.push(`
          (
            detected_at < ${getSqlLiteral(input.after.detectedAt)}
            OR (
              detected_at = ${getSqlLiteral(input.after.detectedAt)}
              AND created_at < ${getSqlLiteral(input.after.createdAt)}
            )
            OR (
              detected_at = ${getSqlLiteral(input.after.detectedAt)}
              AND created_at = ${getSqlLiteral(input.after.createdAt)}
              AND id > ${getSqlLiteral(input.after.id)}
            )
          )
        `)
      }

      const rows = await database.queryJson<DataSourceArticleChangeLogRow>(
        `
        SELECT ${changeLogSelectSql}
        FROM app.data_source_article_change_log
        WHERE ${filters.join(' AND ')}
        ORDER BY detected_at DESC, created_at DESC, id ASC
        LIMIT ${Math.max(0, Math.trunc(input.limit))}
      `,
        trackingRepositoryWorkload('dataSourceTracking.changeLog.list', input.limit),
      )

      return rows.map(getArticleChangeLogRecordFromRow)
    },
  }
}

export const dataSourceTrackingRepository = createDataSourceTrackingRepository()
export const dataSourceReconciliationWorkRepository = createDataSourceReconciliationWorkRepository()
export const dataSourceArticleChangeLogRepository = createDataSourceArticleChangeLogRepository()

export const getDataSourceTrackingRepository = () => {
  return dataSourceTrackingRepository
}

export const getDataSourceReconciliationWorkRepository = () => {
  return dataSourceReconciliationWorkRepository
}

export const getDataSourceArticleChangeLogRepository = () => {
  return dataSourceArticleChangeLogRepository
}
