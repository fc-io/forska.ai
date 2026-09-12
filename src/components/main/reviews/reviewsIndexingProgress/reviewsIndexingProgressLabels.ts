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

const hasReadyReviewRows = (indexing: ReviewsIndexing) => {
  const totalArticleCount = indexing.coverage.totalArticleCount
  return totalArticleCount > 0 && indexing.coverage.rowReadyArticleCount === totalArticleCount
}

const hasReadyReviewCounts = (indexing: ReviewsIndexing) => {
  const totalArticleCount = indexing.coverage.totalArticleCount
  return totalArticleCount > 0 && indexing.coverage.countReadyArticleCount === totalArticleCount
}

const hasReadyReviewFilters = (indexing: ReviewsIndexing) => {
  const totalArticleCount = indexing.coverage.totalArticleCount
  return totalArticleCount > 0 && indexing.coverage.filterReadyArticleCount === totalArticleCount
}

const hasReadyReviewDetails = (indexing: ReviewsIndexing) => {
  const totalArticleCount = indexing.coverage.totalArticleCount
  return totalArticleCount > 0 && indexing.coverage.detailReadyArticleCount === totalArticleCount
}

const hasReadyReviewSearch = (indexing: ReviewsIndexing) => {
  const totalArticleCount = indexing.coverage.totalArticleCount
  const searchReadyArticleCount = indexing.coverage.searchReadyArticleCount

  return searchReadyArticleCount === null
    ? indexing.search.availability === 'unavailable'
    : totalArticleCount > 0 && searchReadyArticleCount === totalArticleCount
}

const hasReadyReviewSurfaces = (indexing: ReviewsIndexing) => {
  return (
    hasReadyReviewRows(indexing)
    && hasReadyReviewCounts(indexing)
    && hasReadyReviewFilters(indexing)
    && hasReadyReviewDetails(indexing)
    && hasReadyReviewSearch(indexing)
  )
}

const getMissingReadyRowTierNames = (indexing: ReviewsIndexing) => {
  return [
    hasReadyReviewCounts(indexing) ? null : 'counts',
    hasReadyReviewFilters(indexing) ? null : 'filters',
    hasReadyReviewDetails(indexing) ? null : 'details',
    hasReadyReviewSearch(indexing) ? null : 'search',
  ].filter((tierName): tierName is string => {
    return tierName !== null
  })
}

const getJoinedTierNames = (tierNames: readonly string[]) => {
  return tierNames.length <= 2
    ? tierNames.join(' and ')
    : `${tierNames.slice(0, -1).join(', ')} and ${tierNames.at(-1)}`
}

const getReadyRowsProcessingLabel = (indexing: ReviewsIndexing) => {
  const missingTierNames = getMissingReadyRowTierNames(indexing)

  return missingTierNames.length === 0
    ? 'running background maintenance'
    : `updating ${getJoinedTierNames(missingTierNames)} in the background`
}

const getReadyRowsQueuedLabel = (indexing: ReviewsIndexing) => {
  const missingTierNames = getMissingReadyRowTierNames(indexing)

  return missingTierNames.length === 0 ? 'background maintenance queued' : `${getJoinedTierNames(missingTierNames)} queued`
}

export const getProjectRefreshLabel = (indexing: ReviewsIndexing) => {
  return joinLabelParts([
    getCoverageCountLabel(indexing.coverage.rowReadyArticleCount, indexing.coverage.totalArticleCount),
    getTimestampSuffix('last progress', indexing.lastProgressedAt),
    getTimestampSuffix('started', indexing.lastStartedAt),
  ])
}

export const getCountRefreshLabel = (indexing: ReviewsIndexing) => {
  return getCoverageCountLabel(indexing.coverage.countReadyArticleCount, indexing.coverage.totalArticleCount)
}

export const getFilterRefreshLabel = (indexing: ReviewsIndexing) => {
  return getCoverageCountLabel(indexing.coverage.filterReadyArticleCount, indexing.coverage.totalArticleCount)
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
  if ((indexing.cleanup?.inFlightGenerationCleanupCount ?? 0) > 0 && indexing.progressState === 'completed') {
    return 'old index cleanup running'
  }

  if (indexing.progressState === 'processing') {
    if (hasReadyReviewSurfaces(indexing)) {
      return 'running background maintenance'
    }

    return hasReadyReviewRows(indexing)
      ? getReadyRowsProcessingLabel(indexing)
      : 'maintenance worker is updating the review row index'
  }

  if (indexing.progressState === 'queued') {
    if (hasReadyReviewSurfaces(indexing)) {
      return 'background maintenance queued'
    }

    return hasReadyReviewRows(indexing) ? getReadyRowsQueuedLabel(indexing) : 'queued for the maintenance worker'
  }

  return indexing.progressState === 'blocked' && indexing.blockedReason === 'paused_by_policy'
    ? 'recovering after memory pressure'
    : indexing.progressState === 'blocked'
      ? 'waiting for maintenance worker'
      : indexing.progressState === 'stalled'
        ? 'stalled with no active processing'
        : indexing.progressState === 'failed'
          ? 'failed'
          : 'completed'
}

export const getIndexingStatusHeading = (indexing: ReviewsIndexing) => {
  return hasReadyReviewRows(indexing)
    && (indexing.progressState === 'processing' || indexing.progressState === 'queued')
    ? 'Background work'
    : 'Indexing status'
}

export const shouldShowIndexingProgress = (indexing: ReviewsIndexing) => {
  return (
    indexing.status === 'refreshing'
    || indexing.status === 'blocked'
    || indexing.status === 'failed'
    || (indexing.cleanup?.inFlightGenerationCleanupCount ?? 0) > 0
  )
}
