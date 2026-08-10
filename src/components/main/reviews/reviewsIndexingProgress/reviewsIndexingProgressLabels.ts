import type {ReviewsWarningsData} from '../reviewsWarningsQuery.ts'

type ReviewsIndexing = ReviewsWarningsData['indexing']

export const getProgressContainerClass = (compact: boolean) => {
  return compact
    ? 'mt-3 min-w-0 space-y-1 break-words text-xs text-slate-600'
    : 'mt-3 min-w-0 space-y-1.5 break-words text-xs text-slate-600'
}

const formatProgressTimestamp = (value: string | null) => {
  const parsed = value ? new Date(value) : null

  return parsed === null || Number.isNaN(parsed.getTime())
    ? null
    : new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(parsed)
}

const getTimestampSuffix = (label: string, value: string | null) => {
  const formatted = formatProgressTimestamp(value)

  return formatted === null ? null : `${label} ${formatted}`
}

const getCountLabel = (count: number) => {
  return count.toLocaleString()
}

const joinLabelParts = (parts: Array<string | null>) => {
  return parts
    .filter((part): part is string => {
      return part !== null
    })
    .join(', ')
}

const getCoverageCountLabel = (readyCount: number | null, totalCount: number) => {
  return readyCount === null
    ? `indexing ${getCountLabel(totalCount)} ${totalCount === 1 ? 'article' : 'articles'}`
    : `${getCountLabel(readyCount)} / ${getCountLabel(totalCount)} ${totalCount === 1 ? 'article' : 'articles'} ready`
}

export const getProjectRefreshLabel = (indexing: ReviewsIndexing) => {
  return joinLabelParts([
    getCoverageCountLabel(indexing.coverage.reviewPageReadyArticleCount, indexing.coverage.totalArticleCount),
    getTimestampSuffix('last progress', indexing.lastProgressedAt),
    getTimestampSuffix('started', indexing.lastStartedAt),
  ])
}

export const getArticleRefreshLabel = (indexing: ReviewsIndexing) => {
  return joinLabelParts([
    getCoverageCountLabel(indexing.coverage.detailReadyArticleCount, indexing.coverage.totalArticleCount),
    getTimestampSuffix('last progress', indexing.lastProgressedAt),
  ])
}

export const getSearchCoverageLabel = (indexing: ReviewsIndexing) => {
  return getCoverageCountLabel(indexing.coverage.searchReadyArticleCount, indexing.coverage.totalArticleCount)
}

export const getCleanupLabel = (indexing: ReviewsIndexing) => {
  const cleanupCount = indexing.cleanup?.inFlightGenerationCleanupCount ?? 0
  const cleanupLabel =
    cleanupCount === 0
      ? null
      : `${getCountLabel(cleanupCount)} old-generation cleanup ${cleanupCount === 1 ? 'job' : 'jobs'} running`

  return cleanupLabel === null
    ? null
    : joinLabelParts([cleanupLabel, getTimestampSuffix('last progress', indexing.cleanup?.lastProgressedAt ?? null)])
}

export const getIndexingStatusLabel = (indexing: ReviewsIndexing) => {
  return (indexing.cleanup?.inFlightGenerationCleanupCount ?? 0) > 0 && indexing.progressState === 'completed'
    ? 'old index cleanup running'
    : indexing.progressState === 'processing'
      ? 'maintenance worker is updating the review index'
      : indexing.progressState === 'queued'
        ? 'queued for the maintenance worker'
        : indexing.progressState === 'blocked' && indexing.blockedReason === 'paused_by_policy'
          ? 'recovering after memory pressure'
          : indexing.progressState === 'blocked'
            ? 'waiting for maintenance worker'
            : indexing.progressState === 'stalled'
              ? 'stalled with no active processing'
              : indexing.progressState === 'failed'
                ? 'failed'
                : 'completed'
}

export const shouldShowIndexingProgress = (indexing: ReviewsIndexing) => {
  return (
    indexing.status === 'refreshing'
    || indexing.status === 'blocked'
    || indexing.status === 'failed'
    || (indexing.cleanup?.inFlightGenerationCleanupCount ?? 0) > 0
  )
}
