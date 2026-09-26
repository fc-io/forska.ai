import {formatDate} from 'date-fns'

export type DataSourceImportStatusView = {
  completedAt: string | null
  consecutiveFailureCount: number
  failedAt: string | null
  fetchedCount: number
  lastError: string | null
  lastProgressAt: string | null
  nextRetryAt: string | null
  progressFromStart: boolean
  runStartedAt: string | null
  runStartFetchedCount: number
  status: 'completed' | 'failed' | 'interrupted' | 'running'
  storedCount: number
  totalCount: number | null
}

export const dataSourcesImportPollIntervalMs = 15_000

const importStatuses = new Set<string>(['completed', 'failed', 'interrupted', 'running'])
const millisecondsPerMinute = 60_000

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getIsoString = (value: unknown) => {
  return value instanceof Date ? value.toISOString() : typeof value === 'string' && value !== '' ? value : null
}

const getNumber = (value: unknown) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const isImportStatus = (value: unknown): value is DataSourceImportStatusView['status'] => {
  return typeof value === 'string' && importStatuses.has(value)
}

const getImportStatusView = (
  value: Record<string, unknown>,
  status: DataSourceImportStatusView['status'],
): DataSourceImportStatusView => {
  return {
    completedAt: getIsoString(value.completedAt),
    consecutiveFailureCount: getNumber(value.consecutiveFailureCount),
    failedAt: getIsoString(value.failedAt),
    fetchedCount: getNumber(value.fetchedCount),
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    lastProgressAt: getIsoString(value.lastProgressAt),
    nextRetryAt: getIsoString(value.nextRetryAt),
    progressFromStart: value.progressFromStart === true,
    runStartedAt: getIsoString(value.runStartedAt),
    runStartFetchedCount: getNumber(value.runStartFetchedCount),
    status,
    storedCount: getNumber(value.storedCount),
    totalCount: typeof value.totalCount === 'number' && Number.isFinite(value.totalCount) ? value.totalCount : null,
  }
}

export const normalizeDataSourceImportStatus = (value: unknown): DataSourceImportStatusView | null => {
  return isRecord(value) && isImportStatus(value.status) ? getImportStatusView(value, value.status) : null
}

export const hasRunningDataSourceImport = (
  entries: ReadonlyArray<{importStatus: DataSourceImportStatusView | null}> | undefined,
) => {
  return (entries ?? []).some((entry) => {
    return entry.importStatus?.status === 'running'
  })
}

export const getDataSourcesRefetchInterval = (
  entries: ReadonlyArray<{importStatus: DataSourceImportStatusView | null}> | undefined,
) => {
  return hasRunningDataSourceImport(entries) ? dataSourcesImportPollIntervalMs : false
}

export const getImportActionLabel = (importStatus: DataSourceImportStatusView | null) => {
  return importStatus?.status === 'failed' || importStatus?.status === 'interrupted' ? 'Resume' : 'New Import'
}

export const formatImportStatusTime = (value: string | null) => {
  return value ? formatDate(new Date(value), 'yyyy-MM-dd HH:mm') : 'Not recorded'
}

const getProgressPercentLabel = (fetchedCount: number, totalCount: number) => {
  return `${Math.min(100, (fetchedCount / totalCount) * 100).toFixed(1)}%`
}

const getStoredOfTotalLabel = (importStatus: DataSourceImportStatusView, totalCount: number) => {
  return `Stored ${importStatus.storedCount.toLocaleString()} of ${totalCount.toLocaleString()} (${getProgressPercentLabel(importStatus.fetchedCount, totalCount)})`
}

const getStoredWithoutTotalLabel = (importStatus: DataSourceImportStatusView) => {
  return importStatus.progressFromStart
    ? `Stored ${importStatus.storedCount.toLocaleString()}`
    : `Stored ${importStatus.storedCount.toLocaleString()} since the import was resumed (earlier progress was not recorded)`
}

export const getImportProgressLabel = (importStatus: DataSourceImportStatusView) => {
  const totalCount = importStatus.totalCount

  return totalCount !== null && totalCount > 0 && importStatus.progressFromStart
    ? getStoredOfTotalLabel(importStatus, totalCount)
    : getStoredWithoutTotalLabel(importStatus)
}

const getRunRatePerMs = (importStatus: DataSourceImportStatusView) => {
  const runFetchedCount = importStatus.fetchedCount - importStatus.runStartFetchedCount
  const elapsedMs =
    importStatus.lastProgressAt && importStatus.runStartedAt
      ? Date.parse(importStatus.lastProgressAt) - Date.parse(importStatus.runStartedAt)
      : 0

  return runFetchedCount > 0 && elapsedMs > 0 ? runFetchedCount / elapsedMs : null
}

const formatRemainingDuration = (remainingMs: number) => {
  const minutes = Math.max(1, Math.round(remainingMs / millisecondsPerMinute))
  const hours = Math.floor(minutes / 60)

  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`
}

const getRemainingCount = (importStatus: DataSourceImportStatusView) => {
  return importStatus.totalCount !== null && importStatus.progressFromStart
    ? importStatus.totalCount - importStatus.fetchedCount
    : 0
}

export const getImportEtaLabel = (importStatus: DataSourceImportStatusView) => {
  const remainingCount = getRemainingCount(importStatus)
  const ratePerMs = getRunRatePerMs(importStatus)

  return remainingCount > 0 && ratePerMs !== null
    ? `about ${formatRemainingDuration(remainingCount / ratePerMs)} left at the current rate`
    : null
}

export const getImportRetryLabel = (importStatus: DataSourceImportStatusView) => {
  return importStatus.nextRetryAt
    ? `Retrying automatically at ${formatImportStatusTime(importStatus.nextRetryAt)}.`
    : 'Automatic retries stopped. Resume continues from the saved cursor.'
}
