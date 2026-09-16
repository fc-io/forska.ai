import {Elysia, t} from 'elysia'

import type {DataSourceArticleChangeKind, DataSourceArticleChangeRunKind} from '../../db/schemaTypes.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getCovidencePackageConfig} from '../services/covidenceImportService.ts'
import {
  createDataSourceTrackingRepository,
  type DataSourceArticleChangeLogCursor,
  type DataSourceTrackingDatabaseRunner,
  getDataSourceArticleChangeLogRepository,
  getDataSourceReconciliationWorkRepository,
} from '../services/dataSourceTrackingRepository.ts'
import {getDataSourceTrackingSpoolRepository} from '../services/dataSourceTrackingSpoolRepository.ts'
import {getStructuredFileImportConfig} from '../services/structuredFileImportService.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

type AppDatabaseService = ReturnType<typeof getAppDatabaseService>
type AppTx = Parameters<AppDatabaseService['transaction']>[0] extends (runner: infer T) => Promise<unknown> ? T : never
type AppQueryRunner = Pick<AppTx, 'queryJson'>
type DataSourceTrackingSpoolRepositoryForRoutes = Pick<
  ReturnType<typeof getDataSourceTrackingSpoolRepository>,
  'rejectOpenWindowsForDataSource'
>
type DataSourceRow = {
  id: string
  title: string
  description: string | null
  importRoute: string | null
  cursor: string | null
  lastImportAt: unknown
  itemsAfterLastImport: number | null
  createdAt: unknown
  updatedAt: unknown
  dateFrom: unknown
  dateTo: unknown
  trackingEnabled?: boolean | null
  trackingReconcileScheduleMonths?: unknown
  trackingGranularity?: string | null
  trackingHighWaterCompletedAt?: unknown
  trackingActiveWindowStart?: unknown
  trackingActiveWindowEnd?: unknown
  trackingActiveCursor?: string | null
  trackingLastAttemptAt?: unknown
  trackingLastSuccessAt?: unknown
  trackingNextRunAfter?: unknown
  trackingLastReconciliationCompletedAt?: unknown
  trackingFailureCount?: number | null
  trackingLastError?: string | null
  trackingActiveRunKind?: string | null
  trackingActiveReconciliationAgeMonths?: number | null
  trackingPendingReconciliationCount?: number | null
  archived: boolean
}

type CovidenceProjectLinkRow = {importRoute: string; projectId: string}
type CovidencePromptLinkRow = {importRoute: string; promptId: string}
type StructuredFileConfig = NonNullable<ReturnType<typeof getSafeStructuredFileImportConfig>>
type CovidencePackageConfig = NonNullable<ReturnType<typeof getSafeCovidencePackageConfig>>
type DataSourceImportState = {
  covidencePackageConfig: CovidencePackageConfig | null
  immutable: boolean
  linkedProjectId: string | null
  linkedPromptIds: string[]
  reimportable: boolean
  structuredFileConfig: StructuredFileConfig | null
}

const covidencePromptLinksPerImportRouteLimit = 100
const defaultTrackingReconcileScheduleMonths = [3, 12, 24, 36]
const maxTrackingReconcileScheduleMonth = 120
const supportedTrackingImportRoutes = new Set([
  '/api/datasources/import/pubmed',
  '/api/datasources/import/europe-pmc-ppr',
])
let dataSourceTrackingSpoolRepositoryForTests: DataSourceTrackingSpoolRepositoryForRoutes | null = null

export const setDataSourceTrackingSpoolRepositoryForTests = (
  repository: DataSourceTrackingSpoolRepositoryForRoutes | null,
) => {
  dataSourceTrackingSpoolRepositoryForTests = repository
}

const getDataSourceTrackingSpoolRepositoryForRoute = () => {
  return dataSourceTrackingSpoolRepositoryForTests ?? getDataSourceTrackingSpoolRepository()
}

const getDataSourcesWorkloadContext = ({
  maxResultRows,
  operation,
}: {
  maxResultRows?: number
  operation: string
}): DuckdbWorkloadContext => {
  return {
    fallbackIntent: 'reject',
    maxResultRows,
    routeOrJobKey: `dataSources.${operation}`,
    workloadClass: 'owner.product.dataSources',
  }
}

const getTrackingReconcileScheduleMonths = (value: unknown): number[] => {
  const parsed = getJsonValue(value)

  if (!Array.isArray(parsed)) {
    return defaultTrackingReconcileScheduleMonths
  }

  const months = Array.from(
    new Set(
      parsed.filter((entry): entry is number => {
        return Number.isInteger(entry) && entry > 0 && entry <= maxTrackingReconcileScheduleMonth
      }),
    ),
  )

  return months.length > 0
    ? months.sort((left, right) => {
        return left - right
      })
    : defaultTrackingReconcileScheduleMonths
}

const normalizeTrackingReconcileScheduleMonthsForWrite = (months?: number[]) => {
  if (months === undefined || months.length === 0) {
    return defaultTrackingReconcileScheduleMonths
  }

  for (const month of months) {
    if (!Number.isInteger(month) || month <= 0 || month > maxTrackingReconcileScheduleMonth) {
      throw new Error(
        `Reconciliation schedule months must be integers between 1 and ${maxTrackingReconcileScheduleMonth}`,
      )
    }
  }

  return Array.from(new Set(months)).sort((left, right) => {
    return left - right
  })
}

const getTrackingReconcileScheduleMonthsSqlLiteral = (months?: number[]) => {
  return getSqlLiteral(JSON.stringify(normalizeTrackingReconcileScheduleMonthsForWrite(months)))
}

const isTrackingSupportedRoute = (importRoute: string | null | undefined) => {
  return Boolean(importRoute && supportedTrackingImportRoutes.has(importRoute))
}

const assertTrackingCanBeEnabled = (params: {
  dateFrom: Date | null
  importRoute: string | null
  trackingEnabled: boolean
}) => {
  if (!params.trackingEnabled) {
    return
  }

  if (!isTrackingSupportedRoute(params.importRoute)) {
    throw new Error('Continuous tracking is only supported for PubMed and Europe PMC PPR data sources')
  }

  if (!params.dateFrom) {
    throw new Error('Continuous tracking requires a start date')
  }
}

const getLatestClosedUtcDay = (now = new Date()) => {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

const millisecondsPerDay = 24 * 60 * 60 * 1000

const getUtcDayStart = (date: Date) => {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

const addUtcDays = (date: Date, days: number) => {
  return new Date(getUtcDayStart(date).getTime() + days * millisecondsPerDay)
}

const minDate = (left: Date, right: Date) => {
  return left.getTime() <= right.getTime() ? left : right
}

const areDateBoundsEqual = (left: Date | null, right: Date | null) => {
  return (left ? left.getTime() : null) === (right ? right.getTime() : null)
}

const areNumberListsEqual = (left: readonly number[], right: readonly number[]) => {
  return (
    left.length === right.length
    && left.every((value, index) => {
      return value === right[index]
    })
  )
}

const dataSourceArticleChangeKinds: DataSourceArticleChangeKind[] = [
  'article_added',
  'source_record_changed',
  'canonical_article_changed',
  'source_record_deleted',
  'source_record_restored',
]
const dataSourceArticleChangeRunKinds: DataSourceArticleChangeRunKind[] = [
  'incremental',
  'automatic_age_bucket',
  'manual_full_range',
]

type TrackingChangeCursorPayload = {createdAt: string; detectedAt: string; id: string}

const encodeTrackingChangeCursor = (row: {createdAt: Date; detectedAt: Date; id: string}): string => {
  const payload: TrackingChangeCursorPayload = {
    createdAt: row.createdAt.toISOString(),
    detectedAt: row.detectedAt.toISOString(),
    id: row.id,
  }

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

const decodeTrackingChangeCursor = (value: string | undefined): DataSourceArticleChangeLogCursor | null => {
  if (!value) {
    return null
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<TrackingChangeCursorPayload>
    if (!decoded.id || !decoded.createdAt || !decoded.detectedAt) {
      return null
    }

    const createdAt = new Date(decoded.createdAt)
    const detectedAt = new Date(decoded.detectedAt)
    if (Number.isNaN(createdAt.getTime()) || Number.isNaN(detectedAt.getTime())) {
      return null
    }

    return {createdAt, detectedAt, id: decoded.id}
  } catch {
    return null
  }
}

const parseEnumList = <T extends string>(value: string | undefined, allowedValues: readonly T[]): T[] | undefined => {
  if (!value) {
    return undefined
  }

  const allowed = new Set(allowedValues)
  const values = value
    .split(',')
    .map((entry) => {
      return entry.trim()
    })
    .filter((entry) => {
      return entry.length > 0
    })

  if (values.length === 0) {
    return undefined
  }

  for (const entry of values) {
    if (!allowed.has(entry as T)) {
      throw new Error(`Unsupported data source tracking filter: ${entry}`)
    }
  }

  return values as T[]
}

const parseBoundedInteger = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10)
  const normalized = Number.isFinite(parsed) ? parsed : fallback

  return Math.min(max, Math.max(min, normalized))
}

const parseOptionalDate = (value?: string | null) => {
  if (!value) {
    return null
  }
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return null
  }
  const isoDateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/
  const hasIsoDateOnlyMatch = isoDateOnlyPattern.exec(trimmedValue)
  const normalizedValue = hasIsoDateOnlyMatch ? `${trimmedValue}T00:00:00.000Z` : trimmedValue
  const parsedDate = new Date(normalizedValue)
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error('Invalid date value provided')
  }
  return parsedDate
}

const getSafeStructuredFileImportConfig = (cursorValue: unknown) => {
  if (typeof cursorValue !== 'string') {
    return null
  }

  try {
    return getStructuredFileImportConfig(cursorValue)
  } catch {
    return null
  }
}

const getSafeCovidencePackageConfig = (cursorValue: unknown) => {
  return typeof cursorValue === 'string' ? getCovidencePackageConfig(cursorValue) : null
}

const hasMutableDataSourceChanges = (body: {
  title?: string
  description?: string | null
  importRoute?: string | null
  dateFrom?: string | null
  dateTo?: string | null
  archived?: boolean
}) => {
  return [body.title, body.description, body.importRoute, body.dateFrom, body.dateTo].some((value) => {
    return value !== undefined
  })
}

const getCovidenceProjectIdByImportRoute = async (db: AppQueryRunner, importRoutes: string[]) => {
  const rows =
    importRoutes.length === 0
      ? []
      : await db.queryJson<CovidenceProjectLinkRow>(
          `
        SELECT DISTINCT ON (ir.route)
          ir.route AS importRoute,
          pir.project_id AS projectId
        FROM app.project_import_route pir
        INNER JOIN app.import_route ir ON ir.id = pir.import_route_id
        WHERE ir.route IN (${importRoutes
          .map((importRoute) => {
            return getSqlLiteral(importRoute)
          })
          .join(', ')})
        ORDER BY ir.route ASC, pir.project_id ASC
      `,
          getDataSourcesWorkloadContext({maxResultRows: importRoutes.length, operation: 'covidenceProjectLinks'}),
        )

  return new Map(
    rows.map((row) => {
      return [row.importRoute, row.projectId]
    }),
  )
}

const getCovidencePromptIdsByImportRoute = async (db: AppQueryRunner, importRoutes: string[]) => {
  const rows =
    importRoutes.length === 0
      ? []
      : await db.queryJson<CovidencePromptLinkRow>(
          `
        WITH selected_import_route AS (
          SELECT id, route
          FROM app.import_route
          WHERE route IN (${importRoutes
            .map((importRoute) => {
              return getSqlLiteral(importRoute)
            })
            .join(', ')})
        )
        SELECT
          selected_import_route.route AS importRoute,
          route_prompt.promptId
        FROM selected_import_route
        INNER JOIN LATERAL (
          SELECT
            pp.prompt_id AS promptId,
            pp.prompt_order AS promptOrder
          FROM app.project_import_route pir
          INNER JOIN app.project_prompt pp ON pp.project_id = pir.project_id
          WHERE pir.import_route_id = selected_import_route.id
            AND pp.archived = FALSE
            AND pp.enabled = TRUE
          ORDER BY pp.prompt_order ASC, pp.prompt_id ASC
          LIMIT ${covidencePromptLinksPerImportRouteLimit}
        ) route_prompt ON TRUE
        ORDER BY selected_import_route.route ASC, route_prompt.promptOrder ASC, route_prompt.promptId ASC
      `,
          getDataSourcesWorkloadContext({
            maxResultRows: importRoutes.length * covidencePromptLinksPerImportRouteLimit,
            operation: 'covidencePromptLinks',
          }),
        )

  return rows.reduce<Map<string, string[]>>((promptIdsByImportRoute, row) => {
    const existingPromptIds = promptIdsByImportRoute.get(row.importRoute) ?? []

    promptIdsByImportRoute.set(row.importRoute, [...existingPromptIds, row.promptId])

    return promptIdsByImportRoute
  }, new Map())
}

const getDataSourceImportState = (params: {
  covidenceProjectIdByImportRoute: Map<string, string>
  covidencePromptIdsByImportRoute: Map<string, string[]>
  importRoute: string | null
  cursor: string | null
}): DataSourceImportState => {
  const structuredFileConfig = getSafeStructuredFileImportConfig(params.cursor)
  const covidencePackageConfig = getSafeCovidencePackageConfig(params.cursor)
  const linkedProjectId =
    covidencePackageConfig && params.importRoute
      ? (params.covidenceProjectIdByImportRoute.get(params.importRoute) ?? null)
      : null
  const linkedPromptIds =
    covidencePackageConfig && params.importRoute
      ? (params.covidencePromptIdsByImportRoute.get(params.importRoute) ?? [])
      : []

  return {
    covidencePackageConfig,
    immutable: Boolean(structuredFileConfig || covidencePackageConfig),
    linkedProjectId,
    linkedPromptIds,
    reimportable: Boolean(covidencePackageConfig),
    structuredFileConfig,
  }
}

const normalizeDataSourceRow = <TRow extends Record<string, unknown>>(
  row: TRow,
  importState: DataSourceImportState,
) => {
  const {cursor, ...safeRow} = row
  const trackingGranularity = typeof row['trackingGranularity'] === 'string' ? row['trackingGranularity'] : null
  const trackingState = trackingGranularity
    ? {
        activeCursor: typeof row['trackingActiveCursor'] === 'string' ? row['trackingActiveCursor'] : null,
        activeReconciliationAgeMonths:
          typeof row['trackingActiveReconciliationAgeMonths'] === 'number'
            ? row['trackingActiveReconciliationAgeMonths']
            : null,
        activeRunKind: typeof row['trackingActiveRunKind'] === 'string' ? row['trackingActiveRunKind'] : null,
        activeWindowEnd: getDateValue(row['trackingActiveWindowEnd']),
        activeWindowStart: getDateValue(row['trackingActiveWindowStart']),
        failureCount: typeof row['trackingFailureCount'] === 'number' ? row['trackingFailureCount'] : 0,
        granularity: trackingGranularity,
        highWaterCompletedAt: getDateValue(row['trackingHighWaterCompletedAt']),
        lastAttemptAt: getDateValue(row['trackingLastAttemptAt']),
        lastError: typeof row['trackingLastError'] === 'string' ? row['trackingLastError'] : null,
        lastReconciliationCompletedAt: getDateValue(row['trackingLastReconciliationCompletedAt']),
        lastSuccessAt: getDateValue(row['trackingLastSuccessAt']),
        nextRunAfter: getDateValue(row['trackingNextRunAfter']),
        pendingReconciliationCount:
          typeof row['trackingPendingReconciliationCount'] === 'number' ? row['trackingPendingReconciliationCount'] : 0,
      }
    : null

  return {
    ...safeRow,
    ...importState,
    createdAt: getDateValue(row['createdAt']),
    updatedAt: getDateValue(row['updatedAt']),
    dateFrom: getDateValue(row['dateFrom']),
    dateTo: getDateValue(row['dateTo']),
    lastImportAt: getDateValue(row['lastImportAt']),
    trackingEnabled: Boolean(row['trackingEnabled']),
    trackingReconcileScheduleMonths: getTrackingReconcileScheduleMonths(row['trackingReconcileScheduleMonths']),
    trackingState,
    trackingSupported: isTrackingSupportedRoute(typeof row['importRoute'] === 'string' ? row['importRoute'] : null),
  }
}

const normalizeDataSourceRows = async <TRow extends DataSourceRow>(db: AppQueryRunner, rows: TRow[]) => {
  const covidenceImportRoutes = rows.flatMap((row) => {
    return row.importRoute && getSafeCovidencePackageConfig(row.cursor) ? [row.importRoute] : []
  })
  const [covidenceProjectIdByImportRoute, covidencePromptIdsByImportRoute] = await Promise.all([
    getCovidenceProjectIdByImportRoute(db, covidenceImportRoutes),
    getCovidencePromptIdsByImportRoute(db, covidenceImportRoutes),
  ])

  return rows.map((row) => {
    return normalizeDataSourceRow(
      row,
      getDataSourceImportState({
        covidenceProjectIdByImportRoute,
        covidencePromptIdsByImportRoute,
        cursor: row.cursor,
        importRoute: row.importRoute,
      }),
    )
  })
}

const getDataSourceRowSql = (dataSourceId: string) => {
  return `
    SELECT
      data_source.id,
      data_source.title,
      data_source.description,
      data_source.import_route AS importRoute,
      data_source.cursor,
      data_source.last_import_at AS lastImportAt,
      data_source.items_after_last_import AS itemsAfterLastImport,
      data_source.created_at AS createdAt,
      data_source.updated_at AS updatedAt,
      data_source.date_from AS dateFrom,
      data_source.date_to AS dateTo,
      data_source.tracking_enabled AS trackingEnabled,
      TO_JSON(data_source.tracking_reconcile_schedule_months) AS trackingReconcileScheduleMonths,
      tracking_state.granularity AS trackingGranularity,
      tracking_state.high_water_completed_at AS trackingHighWaterCompletedAt,
      tracking_state.active_window_start AS trackingActiveWindowStart,
      tracking_state.active_window_end AS trackingActiveWindowEnd,
      tracking_state.active_cursor AS trackingActiveCursor,
      tracking_state.last_attempt_at AS trackingLastAttemptAt,
      tracking_state.last_success_at AS trackingLastSuccessAt,
      tracking_state.next_run_after AS trackingNextRunAfter,
      tracking_state.last_reconciliation_completed_at AS trackingLastReconciliationCompletedAt,
      tracking_state.failure_count AS trackingFailureCount,
      tracking_state.last_error AS trackingLastError,
      tracking_state.active_run_kind AS trackingActiveRunKind,
      tracking_state.active_reconciliation_age_months AS trackingActiveReconciliationAgeMonths,
      COALESCE(reconciliation_work.pendingReconciliationCount, 0) AS trackingPendingReconciliationCount,
      data_source.archived
    FROM app.data_source data_source
    LEFT JOIN app.data_source_tracking_state tracking_state ON tracking_state.data_source_id = data_source.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::INTEGER AS pendingReconciliationCount
      FROM app.data_source_reconciliation_work work
      WHERE work.data_source_id = data_source.id
        AND work.status IN ('queued', 'running', 'failed')
    ) reconciliation_work ON TRUE
    WHERE data_source.id = '${escapeSqlString(dataSourceId)}'
    LIMIT 1
  `
}

const getDataSourceRow = async (db: AppQueryRunner, dataSourceId: string) => {
  const [row] = await db.queryJson<DataSourceRow>(
    getDataSourceRowSql(dataSourceId),
    getDataSourcesWorkloadContext({maxResultRows: 1, operation: 'detail'}),
  )
  return row ?? null
}

const updateDataSourceTx = async (tx: AppTx, params: {dataSourceId: string; updateParts: string[]}) => {
  await tx.run(
    `
    UPDATE app.data_source
    SET ${params.updateParts.join(', ')}
    WHERE id = '${escapeSqlString(params.dataSourceId)}'
  `,
    getDataSourcesWorkloadContext({operation: 'update'}),
  )

  return getDataSourceRow(tx, params.dataSourceId)
}

const createOrUpdateTrackingStateIfEnabled = async (params: {
  db: DataSourceTrackingDatabaseRunner
  dataSourceId: string
  importRoute: string | null
  trackingEnabled: boolean
}) => {
  if (!params.trackingEnabled || !params.importRoute) {
    return
  }

  await createDataSourceTrackingRepository(params.db).createOrUpdateTrackingState({
    dataSourceId: params.dataSourceId,
    granularity: 'day',
    route: params.importRoute,
  })
}

const resetTrackingStateAfterConfigurationChange = async (
  db: DataSourceTrackingDatabaseRunner,
  params: {dataSourceId: string; resetHighWater: boolean; resetReconciliationScheduler: boolean; resetWindow: boolean},
) => {
  const setParts = [
    'updated_at = current_timestamp',
    params.resetWindow ? 'active_window_start = NULL' : null,
    params.resetWindow ? 'active_window_end = NULL' : null,
    params.resetWindow ? 'active_cursor = NULL' : null,
    params.resetWindow ? 'active_run_kind = NULL' : null,
    params.resetWindow ? 'active_reconciliation_age_months = NULL' : null,
    params.resetWindow ? 'lease_owner = NULL' : null,
    params.resetWindow ? 'lease_expires_at = NULL' : null,
    params.resetHighWater ? 'high_water_completed_at = NULL' : null,
    params.resetReconciliationScheduler ? 'last_reconciliation_scheduler_at = NULL' : null,
  ].filter((part): part is string => {
    return part !== null
  })

  if (setParts.length <= 1) {
    return
  }

  await db.run(
    `
    UPDATE app.data_source_tracking_state
    SET ${setParts.join(', ')}
    WHERE data_source_id = ${getSqlLiteral(params.dataSourceId)}
  `,
    getDataSourcesWorkloadContext({operation: 'trackingStateConfigurationReset'}),
  )
}

const deleteReconciliationWorkOutsideBounds = async (
  db: DataSourceTrackingDatabaseRunner,
  params: {dataSourceId: string; dateFrom: Date | null; dateTo: Date | null},
) => {
  const startBoundary = params.dateFrom ? getUtcDayStart(params.dateFrom) : null
  const endBoundaryExclusive = params.dateTo ? addUtcDays(params.dateTo, 1) : null
  const stalePredicates = [
    startBoundary ? `period_start < ${getSqlLiteral(startBoundary)}` : null,
    endBoundaryExclusive ? `period_end > ${getSqlLiteral(endBoundaryExclusive)}` : null,
  ].filter((part): part is string => {
    return part !== null
  })

  if (stalePredicates.length === 0) {
    return
  }

  await db.run(
    `
    DELETE FROM app.data_source_reconciliation_work
    WHERE data_source_id = ${getSqlLiteral(params.dataSourceId)}
      AND status IN ('queued', 'running', 'failed')
      AND (${stalePredicates.join(' OR ')})
  `,
    getDataSourcesWorkloadContext({operation: 'trackingReconciliationWorkInvalidateBounds'}),
  )
}

const deleteReconciliationWorkForStaleRoute = async (
  db: DataSourceTrackingDatabaseRunner,
  params: {dataSourceId: string; route: string | null},
) => {
  await db.run(
    `
    DELETE FROM app.data_source_reconciliation_work
    WHERE data_source_id = ${getSqlLiteral(params.dataSourceId)}
      AND status IN ('queued', 'running', 'failed')
      AND ${params.route === null ? 'TRUE' : `(route IS NULL OR route <> ${getSqlLiteral(params.route)})`}
  `,
    getDataSourcesWorkloadContext({operation: 'trackingReconciliationWorkInvalidateRoute'}),
  )
}

const deleteReconciliationWorkForRemovedScheduleMonths = async (
  db: DataSourceTrackingDatabaseRunner,
  params: {dataSourceId: string; scheduleMonths: number[]},
) => {
  const keptMonths = [...new Set(params.scheduleMonths)].map((month) => {
    return Math.trunc(month)
  })
  const removedMonthPredicate =
    keptMonths.length === 0 ? 'TRUE' : `(age_months IS NULL OR age_months NOT IN (${keptMonths.join(', ')}))`

  await db.run(
    `
    DELETE FROM app.data_source_reconciliation_work
    WHERE data_source_id = ${getSqlLiteral(params.dataSourceId)}
      AND run_kind = 'automatic_age_bucket'
      AND status IN ('queued', 'running', 'failed')
      AND ${removedMonthPredicate}
  `,
    getDataSourcesWorkloadContext({operation: 'trackingReconciliationWorkInvalidateRemovedSchedule'}),
  )
}

export const dataSourcesRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/datasources', async () => {
    const rows = await getAppDatabaseService().queryJson<{
      archived: boolean
      id: string
      title: string
      description: string | null
      createdAt: unknown
      updatedAt: unknown
      dateFrom: unknown
      dateTo: unknown
      lastImportAt: unknown
      itemsAfterLastImport: number | null
      importRoute: string | null
      cursor: string | null
    }>(
      `
      SELECT
        data_source.id,
        data_source.title,
        data_source.description,
        data_source.created_at AS createdAt,
        data_source.updated_at AS updatedAt,
        data_source.date_from AS dateFrom,
        data_source.date_to AS dateTo,
        data_source.last_import_at AS lastImportAt,
        data_source.items_after_last_import AS itemsAfterLastImport,
        data_source.import_route AS importRoute,
        data_source.cursor,
        data_source.tracking_enabled AS trackingEnabled,
        TO_JSON(data_source.tracking_reconcile_schedule_months) AS trackingReconcileScheduleMonths,
        tracking_state.granularity AS trackingGranularity,
        tracking_state.high_water_completed_at AS trackingHighWaterCompletedAt,
        tracking_state.active_window_start AS trackingActiveWindowStart,
        tracking_state.active_window_end AS trackingActiveWindowEnd,
        tracking_state.active_cursor AS trackingActiveCursor,
        tracking_state.last_attempt_at AS trackingLastAttemptAt,
        tracking_state.last_success_at AS trackingLastSuccessAt,
        tracking_state.next_run_after AS trackingNextRunAfter,
        tracking_state.last_reconciliation_completed_at AS trackingLastReconciliationCompletedAt,
        tracking_state.failure_count AS trackingFailureCount,
        tracking_state.last_error AS trackingLastError,
        tracking_state.active_run_kind AS trackingActiveRunKind,
        tracking_state.active_reconciliation_age_months AS trackingActiveReconciliationAgeMonths,
        COALESCE(reconciliation_work.pendingReconciliationCount, 0) AS trackingPendingReconciliationCount,
        data_source.archived
      FROM app.data_source data_source
      LEFT JOIN app.data_source_tracking_state tracking_state ON tracking_state.data_source_id = data_source.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::INTEGER AS pendingReconciliationCount
        FROM app.data_source_reconciliation_work work
        WHERE work.data_source_id = data_source.id
          AND work.status IN ('queued', 'running', 'failed')
      ) reconciliation_work ON TRUE
      WHERE data_source.archived = FALSE
      ORDER BY data_source.created_at DESC
    `,
      getDataSourcesWorkloadContext({operation: 'listActive'}),
    )
    return {data: await normalizeDataSourceRows(getAppDatabaseService(), rows)}
  })
  .get('/api/datasources/archived', async () => {
    const rows = await getAppDatabaseService().queryJson<{
      archived: boolean
      id: string
      title: string
      description: string | null
      createdAt: unknown
      updatedAt: unknown
      dateFrom: unknown
      dateTo: unknown
      lastImportAt: unknown
      itemsAfterLastImport: number | null
      importRoute: string | null
      cursor: string | null
    }>(
      `
      SELECT
        data_source.id,
        data_source.title,
        data_source.description,
        data_source.created_at AS createdAt,
        data_source.updated_at AS updatedAt,
        data_source.date_from AS dateFrom,
        data_source.date_to AS dateTo,
        data_source.last_import_at AS lastImportAt,
        data_source.items_after_last_import AS itemsAfterLastImport,
        data_source.import_route AS importRoute,
        data_source.cursor,
        data_source.tracking_enabled AS trackingEnabled,
        TO_JSON(data_source.tracking_reconcile_schedule_months) AS trackingReconcileScheduleMonths,
        tracking_state.granularity AS trackingGranularity,
        tracking_state.high_water_completed_at AS trackingHighWaterCompletedAt,
        tracking_state.active_window_start AS trackingActiveWindowStart,
        tracking_state.active_window_end AS trackingActiveWindowEnd,
        tracking_state.active_cursor AS trackingActiveCursor,
        tracking_state.last_attempt_at AS trackingLastAttemptAt,
        tracking_state.last_success_at AS trackingLastSuccessAt,
        tracking_state.next_run_after AS trackingNextRunAfter,
        tracking_state.last_reconciliation_completed_at AS trackingLastReconciliationCompletedAt,
        tracking_state.failure_count AS trackingFailureCount,
        tracking_state.last_error AS trackingLastError,
        tracking_state.active_run_kind AS trackingActiveRunKind,
        tracking_state.active_reconciliation_age_months AS trackingActiveReconciliationAgeMonths,
        COALESCE(reconciliation_work.pendingReconciliationCount, 0) AS trackingPendingReconciliationCount,
        data_source.archived
      FROM app.data_source data_source
      LEFT JOIN app.data_source_tracking_state tracking_state ON tracking_state.data_source_id = data_source.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::INTEGER AS pendingReconciliationCount
        FROM app.data_source_reconciliation_work work
        WHERE work.data_source_id = data_source.id
          AND work.status IN ('queued', 'running', 'failed')
      ) reconciliation_work ON TRUE
      WHERE data_source.archived = TRUE
      ORDER BY data_source.created_at DESC
    `,
      getDataSourcesWorkloadContext({operation: 'listArchived'}),
    )
    return {data: await normalizeDataSourceRows(getAppDatabaseService(), rows)}
  })
  .get('/api/datasources/:id', async ({params}) => {
    const [entry] = await getAppDatabaseService().queryJson<{
      archived: boolean
      id: string
      title: string
      description: string | null
      importRoute: string | null
      cursor: string | null
      lastImportAt: unknown
      itemsAfterLastImport: number | null
      createdAt: unknown
      updatedAt: unknown
      dateFrom: unknown
      dateTo: unknown
    }>(
      `
      SELECT
        data_source.id,
        data_source.title,
        data_source.description,
        data_source.import_route AS importRoute,
        data_source.cursor,
        data_source.last_import_at AS lastImportAt,
        data_source.items_after_last_import AS itemsAfterLastImport,
        data_source.created_at AS createdAt,
        data_source.updated_at AS updatedAt,
        data_source.date_from AS dateFrom,
        data_source.date_to AS dateTo,
        data_source.tracking_enabled AS trackingEnabled,
        TO_JSON(data_source.tracking_reconcile_schedule_months) AS trackingReconcileScheduleMonths,
        tracking_state.granularity AS trackingGranularity,
        tracking_state.high_water_completed_at AS trackingHighWaterCompletedAt,
        tracking_state.active_window_start AS trackingActiveWindowStart,
        tracking_state.active_window_end AS trackingActiveWindowEnd,
        tracking_state.active_cursor AS trackingActiveCursor,
        tracking_state.last_attempt_at AS trackingLastAttemptAt,
        tracking_state.last_success_at AS trackingLastSuccessAt,
        tracking_state.next_run_after AS trackingNextRunAfter,
        tracking_state.last_reconciliation_completed_at AS trackingLastReconciliationCompletedAt,
        tracking_state.failure_count AS trackingFailureCount,
        tracking_state.last_error AS trackingLastError,
        tracking_state.active_run_kind AS trackingActiveRunKind,
        tracking_state.active_reconciliation_age_months AS trackingActiveReconciliationAgeMonths,
        COALESCE(reconciliation_work.pendingReconciliationCount, 0) AS trackingPendingReconciliationCount,
        data_source.archived
      FROM app.data_source data_source
      LEFT JOIN app.data_source_tracking_state tracking_state ON tracking_state.data_source_id = data_source.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::INTEGER AS pendingReconciliationCount
        FROM app.data_source_reconciliation_work work
        WHERE work.data_source_id = data_source.id
          AND work.status IN ('queued', 'running', 'failed')
      ) reconciliation_work ON TRUE
      WHERE data_source.id = '${escapeSqlString(params.id)}'
      LIMIT 1
    `,
      getDataSourcesWorkloadContext({maxResultRows: 1, operation: 'detail'}),
    )

    if (!entry) {
      throw new Error('Data source not found')
    }

    const [normalizedEntry] = await normalizeDataSourceRows(getAppDatabaseService(), [entry])

    return {data: normalizedEntry}
  })
  .post(
    '/api/datasources',
    async ({body}) => {
      const dateFrom = parseOptionalDate(body.dateFrom)
      const dateTo = parseOptionalDate(body.dateTo)
      if (dateFrom && dateTo && dateFrom > dateTo) {
        throw new Error('date_from must be on or before date_to')
      }
      const trackingEnabled = body.trackingEnabled ?? false
      const importRoute = body.importRoute ?? null
      const trackingReconcileScheduleMonths = normalizeTrackingReconcileScheduleMonthsForWrite(
        body.trackingReconcileScheduleMonths,
      )
      assertTrackingCanBeEnabled({dateFrom, importRoute, trackingEnabled})

      const createdRow = await getAppDatabaseService().transaction(
        async (tx) => {
          const [created] = await tx.queryJson<{
            id: string
            importRoute: string | null
            trackingEnabled: boolean | null
          }>(
            `
            INSERT INTO app.data_source (
              id,
              title,
              description,
              import_route,
              date_from,
              date_to,
              tracking_enabled,
              tracking_reconcile_schedule_months
            )
            VALUES (
              '${escapeSqlString(crypto.randomUUID())}',
              ${getSqlLiteral(body.title)},
              ${getSqlLiteral(body.description ?? null)},
              ${getSqlLiteral(importRoute)},
              ${getSqlLiteral(dateFrom)},
              ${getSqlLiteral(dateTo)},
              ${trackingEnabled ? 'TRUE' : 'FALSE'},
              CAST(${getTrackingReconcileScheduleMonthsSqlLiteral(trackingReconcileScheduleMonths)} AS JSON)
            )
            RETURNING
              id,
              import_route AS importRoute,
              tracking_enabled AS trackingEnabled
          `,
            getDataSourcesWorkloadContext({maxResultRows: 1, operation: 'create'}),
          )

          if (!created) {
            return null
          }

          await createOrUpdateTrackingStateIfEnabled({
            db: tx,
            dataSourceId: created.id,
            importRoute: created.importRoute,
            trackingEnabled: created.trackingEnabled ?? false,
          })

          return getDataSourceRow(tx, created.id)
        },
        getDataSourcesWorkloadContext({operation: 'createTransaction'}),
      )

      return {
        data: createdRow
          ? normalizeDataSourceRow(createdRow, {
              covidencePackageConfig: null,
              immutable: false,
              linkedProjectId: null,
              linkedPromptIds: [],
              reimportable: false,
              structuredFileConfig: null,
            })
          : null,
      }
    },
    {
      body: t.Object({
        title: t.String(),
        description: t.Optional(t.String()),
        importRoute: t.Optional(t.String()),
        dateFrom: t.Optional(t.String()),
        dateTo: t.Optional(t.String()),
        trackingEnabled: t.Optional(t.Boolean()),
        trackingReconcileScheduleMonths: t.Optional(t.Array(t.Number())),
      }),
    },
  )
  .patch(
    '/api/datasources/:id',
    async ({params, body}) => {
      const existing = await getDataSourceRow(getAppDatabaseService(), params.id)

      if (!existing) {
        throw new Error('Data source not found')
      }

      if (
        (getSafeStructuredFileImportConfig(existing.cursor) || getSafeCovidencePackageConfig(existing.cursor))
        && hasMutableDataSourceChanges(body)
      ) {
        throw new Error('Imported XML/JSON data sources are immutable and can only be archived')
      }

      const parsedDateFrom = body.dateFrom === undefined ? undefined : parseOptionalDate(body.dateFrom)
      const parsedDateTo = body.dateTo === undefined ? undefined : parseOptionalDate(body.dateTo)
      if (parsedDateFrom && parsedDateTo && parsedDateFrom > parsedDateTo) {
        throw new Error('date_from must be on or before date_to')
      }
      const nextDateFrom = parsedDateFrom === undefined ? getDateValue(existing.dateFrom) : parsedDateFrom
      const nextDateTo = parsedDateTo === undefined ? getDateValue(existing.dateTo) : parsedDateTo
      if (nextDateFrom && nextDateTo && nextDateFrom > nextDateTo) {
        throw new Error('date_from must be on or before date_to')
      }
      const nextImportRoute = body.importRoute === undefined ? existing.importRoute : body.importRoute
      const nextTrackingEnabled =
        body.trackingEnabled === undefined ? Boolean(existing.trackingEnabled) : body.trackingEnabled
      const existingDateFrom = getDateValue(existing.dateFrom)
      const existingDateTo = getDateValue(existing.dateTo)
      const trackingReconcileScheduleMonths =
        body.trackingReconcileScheduleMonths === undefined
          ? undefined
          : normalizeTrackingReconcileScheduleMonthsForWrite(body.trackingReconcileScheduleMonths)
      const existingTrackingReconcileScheduleMonths = getTrackingReconcileScheduleMonths(
        existing.trackingReconcileScheduleMonths,
      )
      const nextTrackingReconcileScheduleMonths =
        trackingReconcileScheduleMonths ?? existingTrackingReconcileScheduleMonths
      const trackingScheduleChanged =
        trackingReconcileScheduleMonths !== undefined
        && !areNumberListsEqual(trackingReconcileScheduleMonths, existingTrackingReconcileScheduleMonths)
      const dateBoundsChanged =
        !areDateBoundsEqual(existingDateFrom, nextDateFrom) || !areDateBoundsEqual(existingDateTo, nextDateTo)
      const startBoundaryMovedEarlier = Boolean(
        existingDateFrom
        && nextDateFrom
        && getUtcDayStart(nextDateFrom).getTime() < getUtcDayStart(existingDateFrom).getTime(),
      )
      const importRouteChanged = nextImportRoute !== existing.importRoute
      assertTrackingCanBeEnabled({
        dateFrom: nextDateFrom,
        importRoute: nextImportRoute,
        trackingEnabled: nextTrackingEnabled,
      })
      const updateParts = [
        `updated_at = current_timestamp`,
        body.title !== undefined ? `title = ${getSqlLiteral(body.title)}` : null,
        body.description !== undefined ? `description = ${getSqlLiteral(body.description)}` : null,
        body.importRoute !== undefined ? `import_route = ${getSqlLiteral(body.importRoute)}` : null,
        body.archived !== undefined ? `archived = ${body.archived ? 'TRUE' : 'FALSE'}` : null,
        parsedDateFrom !== undefined ? `date_from = ${getSqlLiteral(parsedDateFrom)}` : null,
        parsedDateTo !== undefined ? `date_to = ${getSqlLiteral(parsedDateTo)}` : null,
        body.trackingEnabled !== undefined ? `tracking_enabled = ${body.trackingEnabled ? 'TRUE' : 'FALSE'}` : null,
        body.trackingReconcileScheduleMonths !== undefined
          ? `tracking_reconcile_schedule_months = CAST(${getTrackingReconcileScheduleMonthsSqlLiteral(nextTrackingReconcileScheduleMonths)} AS JSON)`
          : null,
      ].filter((part): part is string => {
        return part !== null
      })

      const refreshed = await getAppDatabaseService().transaction(
        async (tx) => {
          const updated = await updateDataSourceTx(tx, {dataSourceId: params.id, updateParts})

          if (!updated) {
            return null
          }

          await createOrUpdateTrackingStateIfEnabled({
            db: tx,
            dataSourceId: updated.id,
            importRoute: updated.importRoute,
            trackingEnabled: updated.trackingEnabled ?? false,
          })

          await resetTrackingStateAfterConfigurationChange(tx, {
            dataSourceId: updated.id,
            resetHighWater: startBoundaryMovedEarlier || importRouteChanged,
            resetReconciliationScheduler: dateBoundsChanged || importRouteChanged || trackingScheduleChanged,
            resetWindow: dateBoundsChanged || importRouteChanged,
          })

          if (dateBoundsChanged) {
            await deleteReconciliationWorkOutsideBounds(tx, {
              dataSourceId: updated.id,
              dateFrom: nextDateFrom,
              dateTo: nextDateTo,
            })
          }

          if (trackingScheduleChanged) {
            await deleteReconciliationWorkForRemovedScheduleMonths(tx, {
              dataSourceId: updated.id,
              scheduleMonths: nextTrackingReconcileScheduleMonths,
            })
          }

          if (importRouteChanged) {
            await deleteReconciliationWorkForStaleRoute(tx, {dataSourceId: updated.id, route: updated.importRoute})
          }

          return getDataSourceRow(tx, updated.id)
        },
        getDataSourcesWorkloadContext({operation: 'updateTransaction'}),
      )

      if (refreshed && (dateBoundsChanged || importRouteChanged)) {
        getDataSourceTrackingSpoolRepositoryForRoute().rejectOpenWindowsForDataSource({
          dataSourceId: refreshed.id,
          error: 'Tracked data source configuration changed',
          now: new Date(),
        })
      }

      if (!refreshed) {
        throw new Error('Data source not found')
      }

      const [normalizedUpdated] = await normalizeDataSourceRows(getAppDatabaseService(), [refreshed])

      return {data: normalizedUpdated}
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        importRoute: t.Optional(t.Union([t.String(), t.Null()])),
        dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
        dateTo: t.Optional(t.Union([t.String(), t.Null()])),
        trackingEnabled: t.Optional(t.Boolean()),
        trackingReconcileScheduleMonths: t.Optional(t.Array(t.Number())),
        archived: t.Optional(t.Boolean()),
      }),
    },
  )
  .post('/api/datasources/:id/tracking/reconcile', async ({params}) => {
    const existing = await getDataSourceRow(getAppDatabaseService(), params.id)

    if (!existing) {
      throw new Error('Data source not found')
    }

    if (!existing.trackingEnabled) {
      throw new Error('Continuous tracking is not enabled for this data source')
    }

    const dateFrom = getDateValue(existing.dateFrom)
    const dateTo = getDateValue(existing.dateTo)
    assertTrackingCanBeEnabled({
      dateFrom,
      importRoute: existing.importRoute,
      trackingEnabled: Boolean(existing.trackingEnabled),
    })

    if (!dateFrom || !existing.importRoute) {
      throw new Error('Continuous tracking is not configured for this data source')
    }

    const periodStart = getUtcDayStart(dateFrom)
    const latestClosedDay = getLatestClosedUtcDay()
    const configuredEndExclusive = dateTo ? addUtcDays(dateTo, 1) : null
    const periodEnd = configuredEndExclusive ? minDate(configuredEndExclusive, latestClosedDay) : latestClosedDay

    if (periodEnd <= periodStart) {
      throw new Error('No closed provider window is available for reconciliation')
    }

    const work = await getDataSourceReconciliationWorkRepository().scheduleWork({
      ageMonths: null,
      dataSourceId: existing.id,
      periodEnd,
      periodStart,
      route: existing.importRoute,
      runKind: 'manual_full_range',
    })
    const refreshed = (await getDataSourceRow(getAppDatabaseService(), existing.id)) ?? existing
    const [dataSource] = await normalizeDataSourceRows(getAppDatabaseService(), [refreshed])

    return {data: {dataSource, work}}
  })
  .get(
    '/api/datasources/:id/tracking/changes',
    async ({params, query}) => {
      const limit = parseBoundedInteger(query.limit, 50, 1, 100)
      const after = decodeTrackingChangeCursor(query.after)
      const changes = await getDataSourceArticleChangeLogRepository().listChanges({
        after,
        changeKinds: parseEnumList(query.changeKind, dataSourceArticleChangeKinds),
        dataSourceId: params.id,
        limit: limit + 1,
        runKinds: parseEnumList(query.runKind, dataSourceArticleChangeRunKinds),
      })
      const items = changes.slice(0, limit)
      const hasMore = changes.length > limit
      const lastItem = items.at(-1)

      return {
        data: {
          after: query.after ?? null,
          hasMore,
          items,
          limit,
          nextCursor: hasMore && lastItem ? encodeTrackingChangeCursor(lastItem) : null,
        },
      }
    },
    {
      query: t.Object({
        after: t.Optional(t.String()),
        changeKind: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        runKind: t.Optional(t.String()),
      }),
    },
  )
  .delete('/api/datasources/:id', async ({params}) => {
    const archived = await getAppDatabaseService().transaction(
      async (tx) => {
        return updateDataSourceTx(tx, {
          dataSourceId: params.id,
          updateParts: ['archived = TRUE', 'updated_at = current_timestamp'],
        })
      },
      getDataSourcesWorkloadContext({operation: 'archiveTransaction'}),
    )

    if (!archived) {
      throw new Error('Data source not found')
    }

    return {success: true, id: archived.id}
  })
