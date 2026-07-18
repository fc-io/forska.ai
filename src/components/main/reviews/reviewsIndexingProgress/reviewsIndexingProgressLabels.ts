import type {ReviewsWarningsData} from '../reviewsWarningsQuery.ts'

type ReviewsIndexing = ReviewsWarningsData['indexing']

export const getProgressContainerClass = (compact: boolean) => {
  return compact ? 'mt-3 space-y-1 text-xs text-slate-600' : 'mt-3 space-y-1.5 text-xs text-slate-600'
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

const getSpeedLabel = (speedPerMinute: number | null) => {
  return speedPerMinute === null ? '0/min' : speedPerMinute < 1 ? '0/min' : `${Math.round(speedPerMinute)}/min`
}

const getCountLabel = (count: number) => {
  return count.toLocaleString()
}

const getLaneDescription = (processingCount: number, queuedCount: number, speedPerMinute: number | null) => {
  return `processing ${processingCount}, queued ${queuedCount}, ${getSpeedLabel(speedPerMinute)}`
}

const joinLabelParts = (parts: Array<string | null>) => {
  return parts
    .filter((part): part is string => {
      return part !== null
    })
    .join(', ')
}

export const getProjectRefreshLabel = (indexing: ReviewsIndexing) => {
  return joinLabelParts([
    getLaneDescription(
      indexing.inFlightProjectRefreshCount,
      indexing.queuedProjectRefreshCount,
      indexing.projectRefreshesPerMinute,
    ),
    getTimestampSuffix('last progress', indexing.lastProgressedAt),
    getTimestampSuffix('started', indexing.lastStartedAt),
  ])
}

export const getArticleRefreshLabel = (indexing: ReviewsIndexing) => {
  return joinLabelParts([
    getLaneDescription(
      indexing.inFlightArticleRefreshCount,
      indexing.queuedArticleRefreshCount,
      indexing.articleRefreshesPerMinute,
    ),
    getTimestampSuffix('last progress', indexing.lastProgressedAt),
  ])
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
      ? `${indexing.activeWorkCount} ${indexing.activeWorkCount === 1 ? 'refresh job' : 'refresh jobs'} actively processing`
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
