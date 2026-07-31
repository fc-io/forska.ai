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
  return speedPerMinute === null ? null : speedPerMinute < 1 ? '<1/min' : `${Math.round(speedPerMinute)}/min`
}

const getCountLabel = (count: number) => {
  return count.toLocaleString()
}

const formatCountNoun = (count: number, singular: string, plural: string) => {
  return `${getCountLabel(count)} ${count === 1 ? singular : plural}`
}

const getLaneDescription = (processingCount: number, queuedCount: number, speedPerMinute: number | null) => {
  return joinLabelParts([`processing ${processingCount}`, `queued ${queuedCount}`, getSpeedLabel(speedPerMinute)])
}

const getProjectDiagnosticsCounts = (indexing: ReviewsIndexing) => {
  const dirtyWork = indexing.serving.diagnostics.dirtyWork
  const rebuildChunks = indexing.serving.diagnostics.rebuildChunks

  if (dirtyWork === undefined && rebuildChunks === undefined) {
    return null
  }

  const expiredRebuildChunkLeaseCount = Math.min(
    rebuildChunks?.runningCount ?? 0,
    rebuildChunks?.expiredLeaseCount ?? 0,
  )
  const runningRebuildChunkCount = Math.max(0, (rebuildChunks?.runningCount ?? 0) - expiredRebuildChunkLeaseCount)
  const queuedRebuildChunkCount = rebuildChunks?.claimableCount ?? 0
  const dirtyBacklogCount =
    (dirtyWork?.pendingCount ?? 0) + (dirtyWork?.runningCount ?? 0) + (dirtyWork?.failedCount ?? 0)

  return {dirtyBacklogCount, queuedRebuildChunkCount, runningRebuildChunkCount}
}

const getProjectDiagnosticsDescription = (indexing: ReviewsIndexing) => {
  const counts = getProjectDiagnosticsCounts(indexing)

  if (counts === null) {
    return getLaneDescription(
      indexing.inFlightProjectRefreshCount,
      indexing.queuedProjectRefreshCount,
      indexing.projectRefreshesPerMinute,
    )
  }

  return joinLabelParts([
    `${formatCountNoun(counts.runningRebuildChunkCount, 'rebuild chunk', 'rebuild chunks')} running`,
    `${formatCountNoun(counts.queuedRebuildChunkCount, 'rebuild chunk', 'rebuild chunks')} queued`,
    counts.dirtyBacklogCount === 0
      ? null
      : `${formatCountNoun(counts.dirtyBacklogCount, 'dirty-work item', 'dirty-work items')} in backlog`,
    getSpeedLabel(indexing.projectRefreshesPerMinute),
  ])
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
    getProjectDiagnosticsDescription(indexing),
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
