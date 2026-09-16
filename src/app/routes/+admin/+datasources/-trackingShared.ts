import {apiClient} from '../../../../services/apiClient.ts'

export const defaultTrackingReconcileScheduleMonths = [3, 12, 24, 36] as const

export const supportedTrackingImportRoutes = new Set([
  '/api/datasources/import/pubmed',
  '/api/datasources/import/europe-pmc-ppr',
])

export type DataSourceTrackingState = {
  activeCursor?: string | null
  activeReconciliationAgeMonths?: number | null
  activeRunKind?: string | null
  activeWindowEnd?: string | null
  activeWindowStart?: string | null
  failureCount?: number | null
  granularity?: string | null
  highWaterCompletedAt?: string | null
  lastAttemptAt?: string | null
  lastError?: string | null
  lastReconciliationCompletedAt?: string | null
  lastSuccessAt?: string | null
  nextRunAfter?: string | null
  pendingReconciliationCount?: number | null
  pendingSpoolPageCount?: number | null
  readySpoolWindowCount?: number | null
}

export type DataSourceTrackingChangeKind =
  | 'article_added'
  | 'canonical_article_changed'
  | 'source_record_changed'
  | 'source_record_deleted'
  | 'source_record_restored'

export type DataSourceTrackingChangeRunKind = 'automatic_age_bucket' | 'incremental' | 'manual_full_range'

export type DataSourceTrackingChangeLogItem = {
  articleId: string | null
  changeKind: string
  changedFields?: unknown
  createdAt?: string | null
  detectedAt: string | null
  externalArticleId: string | null
  id?: string
  nextSnapshot?: unknown
  nextSourceRecordHash: string | null
  previousSnapshot?: unknown
  previousSourceRecordHash: string | null
  runKind: string
  sourceRecordKey: string | null
}

export type DataSourceTrackingChangesResult = {items: DataSourceTrackingChangeLogItem[]; total: number | null}

export type DataSourceTrackingChangesQuery = {
  changeKind?: string
  dataSourceId: string
  limit: number
  runKind?: string
}

type ApiResponse = {data?: unknown; error?: unknown}

type TrackingApi = {
  changes: {get: (params: {query: Record<string, number | string>}) => Promise<ApiResponse>}
  reconcile: {post: () => Promise<ApiResponse>}
}

type DataSourceTrackingApiClient = {api: {datasources: (params: {id: string}) => {tracking: TrackingApi}}}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getOptionalString = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const getOptionalNumber = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getTrackingApi = (dataSourceId: string) => {
  const client = apiClient as unknown as DataSourceTrackingApiClient
  return client.api.datasources({id: dataSourceId}).tracking
}

const getResponsePayload = (value: unknown) => {
  if (isRecord(value) && 'data' in value) {
    return value.data
  }
  return value
}

const normalizeTrackingChangeLogItem = (value: unknown): DataSourceTrackingChangeLogItem => {
  const row = isRecord(value) ? value : {}

  return {
    articleId: getOptionalString(row.articleId),
    changeKind: getOptionalString(row.changeKind) ?? 'source_record_changed',
    changedFields: row.changedFields,
    createdAt: getOptionalString(row.createdAt),
    detectedAt: getOptionalString(row.detectedAt),
    externalArticleId: getOptionalString(row.externalArticleId),
    id: getOptionalString(row.id) ?? undefined,
    nextSnapshot: row.nextSnapshot,
    nextSourceRecordHash: getOptionalString(row.nextSourceRecordHash) ?? getOptionalString(row.nextHash),
    previousSnapshot: row.previousSnapshot,
    previousSourceRecordHash: getOptionalString(row.previousSourceRecordHash) ?? getOptionalString(row.previousHash),
    runKind: getOptionalString(row.runKind) ?? 'incremental',
    sourceRecordKey: getOptionalString(row.sourceRecordKey),
  }
}

const normalizeTrackingChangesResponse = (value: unknown): DataSourceTrackingChangesResult => {
  const payload = getResponsePayload(value)
  const itemsValue = Array.isArray(payload) ? payload : isRecord(payload) ? payload.items : []
  const totalValue = isRecord(payload) ? (payload.total ?? payload.count) : null
  const items = Array.isArray(itemsValue) ? itemsValue.map(normalizeTrackingChangeLogItem) : []

  return {items, total: getOptionalNumber(totalValue)}
}

export const isTrackingSupportedImportRoute = (importRoute: string | null | undefined) => {
  return typeof importRoute === 'string' && supportedTrackingImportRoutes.has(importRoute)
}

export const normalizeTrackingScheduleMonths = (months: readonly number[] | null | undefined): number[] => {
  const normalized =
    months
      ?.filter((month) => {
        return Number.isInteger(month) && month > 0
      })
      .filter((month, index, list) => {
        return list.indexOf(month) === index
      })
      .sort((a, b) => {
        return a - b
      }) ?? []

  return normalized.length > 0 ? normalized : [...defaultTrackingReconcileScheduleMonths]
}

export const getTrackingAvailability = (params: {dateFrom: string | null | undefined; importRoute: string | null}) => {
  const importRoute = params.importRoute?.trim() ?? ''
  const dateFrom = params.dateFrom?.trim() ?? ''

  if (!importRoute) {
    return {
      canEnable: false,
      helperText: 'Choose PubMed or Europe PMC PPR as a built-in route before enabling continuous tracking.',
    }
  }

  if (!isTrackingSupportedImportRoute(importRoute)) {
    return {
      canEnable: false,
      helperText: 'Continuous tracking is only available for PubMed and Europe PMC PPR built-in routes in this slice.',
    }
  }

  if (!dateFrom) {
    return {
      canEnable: false,
      helperText: 'Set Date From before enabling continuous tracking; tracking needs a start boundary.',
    }
  }

  return {canEnable: true, helperText: 'Track new provider windows continuously from the configured start date.'}
}

export const getTrackingScheduleLabel = (months: readonly number[]) => {
  const normalized = normalizeTrackingScheduleMonths(months)
  return normalized
    .map((month) => {
      return `${month} month${month === 1 ? '' : 's'}`
    })
    .join(', ')
}

export const formatTrackingDateTime = (value: string | null | undefined) => {
  if (!value) {
    return 'Not recorded'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

export const getTrackingRangeLabel = (start: string | null | undefined, end: string | null | undefined) => {
  if (!start && !end) {
    return 'Not active'
  }

  return `${formatTrackingDateTime(start)} to ${formatTrackingDateTime(end)}`
}

const trackingChangeKindLabels: Record<string, string> = {
  article_added: 'Article added',
  canonical_article_changed: 'Canonical article changed',
  source_record_changed: 'Source record changed',
  source_record_deleted: 'Deleted from data source',
  source_record_restored: 'Source record restored',
}

const trackingRunKindLabels: Record<string, string> = {
  automatic_age_bucket: 'Automatic age bucket',
  incremental: 'Incremental',
  manual_full_range: 'Manual full range',
}

const humanizeSnakeCase = (value: string) => {
  const cleanedValue = value.replaceAll('_', ' ')
  return cleanedValue.charAt(0).toUpperCase() + cleanedValue.slice(1)
}

export const getTrackingChangeKindLabel = (value: string) => {
  return trackingChangeKindLabels[value] ?? humanizeSnakeCase(value)
}

export const getTrackingRunKindLabel = (value: string) => {
  return trackingRunKindLabels[value] ?? humanizeSnakeCase(value)
}

export const trackingChangeKindFilterOptions: Array<{label: string; value: string}> = [
  {label: 'All change kinds', value: ''},
  {label: 'Source record changed', value: 'source_record_changed'},
  {label: 'Canonical article changed', value: 'canonical_article_changed'},
  {label: 'Deleted from data source', value: 'source_record_deleted'},
  {label: 'Source record restored', value: 'source_record_restored'},
  {label: 'Article added', value: 'article_added'},
]

export const trackingRunKindFilterOptions: Array<{label: string; value: string}> = [
  {label: 'All run kinds', value: ''},
  {label: 'Incremental', value: 'incremental'},
  {label: 'Automatic age bucket', value: 'automatic_age_bucket'},
  {label: 'Manual full range', value: 'manual_full_range'},
]

export const runFullDataSourceTrackingReconciliation = async (dataSourceId: string) => {
  const response = await getTrackingApi(dataSourceId).reconcile.post()

  if (response.error) {
    console.error('Error running data source tracking reconciliation:', response.error)
    throw new Error('Failed to start full reconciliation')
  }

  return response.data
}

export const fetchDataSourceTrackingChanges = async (
  query: DataSourceTrackingChangesQuery,
): Promise<DataSourceTrackingChangesResult> => {
  const requestQuery: Record<string, number | string> = {limit: query.limit}

  if (query.changeKind) {
    requestQuery.changeKind = query.changeKind
  }

  if (query.runKind) {
    requestQuery.runKind = query.runKind
  }

  const response = await getTrackingApi(query.dataSourceId).changes.get({query: requestQuery})

  if (response.error) {
    console.error('Error fetching data source tracking changes:', response.error)
    throw new Error('Failed to fetch tracking changes')
  }

  return normalizeTrackingChangesResponse(response.data)
}
