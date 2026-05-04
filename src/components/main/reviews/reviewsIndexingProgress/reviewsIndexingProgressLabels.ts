import type {ReviewsWarningsData} from '../reviewsWarningsQuery.ts'

type ReviewsIndexing = ReviewsWarningsData['indexing']

const largeRebuildPhaseOrder = [
  'project_scope_article',
  'judgment_fact',
  'prompt_answer_fact',
  'review_answer_dictionary',
  'review_article_filter_member',
  'review_article_rollup',
  'review_article_serving',
] as const

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

const getLatestTimestamp = (...values: Array<string | null>) => {
  const timestampValues = values.filter((value): value is string => {
    return typeof value === 'string' && value !== ''
  })

  return timestampValues.reduce<string | null>((latestValue, value) => {
    if (latestValue === null) {
      return value
    }

    return new Date(value).getTime() > new Date(latestValue).getTime() ? value : latestValue
  }, null)
}

const getSpeedLabel = (speedPerMinute: number | null) => {
  return speedPerMinute === null ? '0/min' : speedPerMinute < 1 ? '0/min' : `${Math.round(speedPerMinute)}/min`
}

const getLargeRebuildSpeedLabel = (speedPerMinute: number | null) => {
  return speedPerMinute === null ? 'measuring throughput' : getSpeedLabel(speedPerMinute)
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

export const getLargeRebuildArticleProgressLabel = (indexing: ReviewsIndexing) => {
  const progress = indexing.largeRebuild?.progress

  return progress === null || progress === undefined || progress.remainingCurrentPhaseArticleCount === null
    ? null
    : `remaining ${getCountLabel(progress.remainingCurrentPhaseArticleCount)} of ${getCountLabel(progress.scopeArticleCount)} in this phase, ${getLargeRebuildSpeedLabel(progress.rowsPerMinute)}`
}

export const getDirtyArticleAckLabel = (indexing: ReviewsIndexing) => {
  return indexing.largeRebuild === null || indexing.pendingArticleRefreshCount === 0
    ? null
    : `${getCountLabel(indexing.pendingArticleRefreshCount)} waiting until the staged rebuild finalizes`
}

export const getLargeRebuildPhaseLabel = (indexing: ReviewsIndexing) => {
  const rebuildPhase = indexing.largeRebuild?.rebuildPhase
  const phaseIndex = largeRebuildPhaseOrder.indexOf(rebuildPhase as (typeof largeRebuildPhaseOrder)[number])
  const phaseLabel =
    rebuildPhase === null || rebuildPhase === undefined
      ? null
      : phaseIndex === -1
        ? `current phase ${rebuildPhase}`
        : `current phase ${phaseIndex + 1} of ${largeRebuildPhaseOrder.length} (${rebuildPhase})`

  return phaseLabel === null
    ? null
    : joinLabelParts([phaseLabel, getTimestampSuffix('last progress', indexing.largeRebuild?.lastProgressedAt ?? null)])
}

export const getLargeRebuildPhaseNoteLabel = (indexing: ReviewsIndexing) => {
  return indexing.largeRebuild === null
    ? null
    : 'Article counts are per phase and reset when the rebuild advances; this is not a full restart.'
}

export const getLargeRebuildCursorLabel = (indexing: ReviewsIndexing) => {
  const cursorArticleId = indexing.largeRebuild?.cursorArticleId

  return cursorArticleId === null || cursorArticleId === undefined ? null : `resuming from article ${cursorArticleId}`
}

export const getLargeRebuildFailureLabel = (indexing: ReviewsIndexing) => {
  const lastError = indexing.largeRebuild?.lastError

  return lastError === null || lastError === undefined ? null : `last error: ${lastError}`
}

export const getDirtyMaterializationLabel = (indexing: ReviewsIndexing) => {
  const materialization = indexing.dirtyMaterialization
  const pendingLabel =
    materialization === undefined || materialization.incompleteCount === 0
      ? null
      : `${getCountLabel(materialization.incompleteCount)} project-wide dirty ${materialization.incompleteCount === 1 ? 'snapshot' : 'snapshots'} pending`

  return pendingLabel === null
    ? null
    : joinLabelParts([
        pendingLabel,
        getTimestampSuffix('last progress', materialization.lastProgressedAt),
        getTimestampSuffix('queued since', materialization.oldestQueuedAt),
      ])
}

export const getQuarantineBarrierLabel = (indexing: ReviewsIndexing) => {
  const quarantineCount = indexing.freshness?.unresolvedQuarantineBarrierCount ?? 0
  const latestQuarantineTimestamp = getLatestTimestamp(
    ...indexing.quarantinedArticles.map((article) => {
      return article.updatedAt ?? article.createdAt
    }),
  )
  const quarantineLabel =
    quarantineCount === 0
      ? null
      : `${getCountLabel(quarantineCount)} quarantined article ${quarantineCount === 1 ? 'barrier' : 'barriers'} blocking freshness`

  return quarantineLabel === null
    ? null
    : joinLabelParts([quarantineLabel, getTimestampSuffix('last updated', latestQuarantineTimestamp)])
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
          ? 'cooling down after memory pressure'
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
    || (indexing.status === 'failed' && getLargeRebuildFailureLabel(indexing) !== null)
    || (indexing.cleanup?.inFlightGenerationCleanupCount ?? 0) > 0
  )
}
