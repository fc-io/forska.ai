import type {ReviewsWarningsData} from './reviewsWarningsQuery.ts'

type ReviewIndexingBlockedReason = ReviewsWarningsData['indexing']['blockedReason']
type ReviewIndexingCopySurface = 'banner' | 'judgedEmpty' | 'unassessedEmpty'
type ReviewIndexingCopy = {description: string; title: string}
type ReviewIndexingCopyParams = {
  indexing: ReviewsWarningsData['indexing']
  projectId: string
  surface: ReviewIndexingCopySurface
}

export const getReviewIndexingInProgressTitle = (projectId: string) => {
  return `Review indexing in progress for project ${projectId}`
}

export const getReviewIndexingQueuedTitle = (projectId: string) => {
  return `Review indexing queued for project ${projectId}`
}

export const getReviewIndexingQueuedBody = () => {
  return 'Review index work is queued and waiting for the maintenance worker to pick up the next batch.'
}

export const getReviewIndexingStalledTitle = () => {
  return 'Review indexing stalled'
}

export const getReviewIndexingStalledBody = () => {
  return 'Review indexing appears stalled because the review index is missing or stale and no active processing is being reported.'
}

export const getReviewIndexingBlockedTitle = (blockedReason: ReviewIndexingBlockedReason) => {
  return blockedReason === 'quarantine_barrier'
    ? 'Review indexing blocked by quarantined article'
    : blockedReason === 'paused_by_policy'
      ? 'Review indexing cooling down after memory pressure'
      : 'Review indexing blocked: waiting for maintenance worker'
}

export const getReviewIndexingBlockedBody = (blockedReason: ReviewIndexingBlockedReason) => {
  return blockedReason === 'quarantine_barrier'
    ? 'One or more article refreshes are quarantined. Review lists keep using the current index until the quarantined work is resolved.'
    : blockedReason === 'paused_by_policy'
      ? 'Review index work is queued, but the maintenance worker is cooling down after memory pressure before starting more review refresh work.'
      : 'Review index work is queued and waiting for a maintenance worker to become available.'
}

const hasOnlyArticleRefreshWork = (indexing: ReviewsWarningsData['indexing']) => {
  return indexing.pendingArticleRefreshCount > 0 && indexing.pendingProjectRefreshCount === 0
}

const hasCleanupWork = (indexing: ReviewsWarningsData['indexing']) => {
  return (indexing.cleanup?.inFlightGenerationCleanupCount ?? 0) > 0
}

const getArticleRefreshQueuedDescription = (surface: ReviewIndexingCopySurface) => {
  return surface === 'unassessedEmpty'
    ? "New judgments are queued to be folded into this project's review index. This list may change once the backlog clears."
    : "New judgments are queued to be folded into this project's review index. Counts and article lists may change once the backlog clears."
}

const getArticleRefreshProcessingDescription = (surface: ReviewIndexingCopySurface) => {
  return surface === 'unassessedEmpty'
    ? 'New judgments are still being folded into this project. This list may change as the backlog clears.'
    : 'New judgments are still being folded into this project. Articles and counts here may change as the backlog clears.'
}

const getProjectRefreshProcessingDescription = (surface: ReviewIndexingCopySurface) => {
  return surface === 'unassessedEmpty'
    ? 'This project has scoped articles, but the review index is actively processing. The unassessed list may appear empty until indexing finishes.'
    : surface === 'judgedEmpty'
      ? 'This project has scoped articles, but the review index is actively processing. Articles with judgments may appear here soon.'
      : 'This project has scoped articles, but the review index is actively processing in the maintenance worker. Review lists may look partial or empty until indexing finishes.'
}

const getFailedReviewIndexingCopy = (): ReviewIndexingCopy => {
  return {
    description:
      'The latest review index refresh failed. Results may stay stale or incomplete until the maintenance worker retries the review index.',
    title: 'Review indexing failed',
  }
}

const getCleanupReviewIndexingCopy = (): ReviewIndexingCopy => {
  return {
    description:
      'Old review index generations are being cleaned up in bounded batches. Current review pages remain usable while cleanup finishes.',
    title: 'Review cleanup in progress',
  }
}

const getQueuedReviewIndexingCopy = (params: ReviewIndexingCopyParams): ReviewIndexingCopy => {
  return hasOnlyArticleRefreshWork(params.indexing)
    ? {
        description: getArticleRefreshQueuedDescription(params.surface),
        title: 'New judgments are queued for incorporation',
      }
    : {description: getReviewIndexingQueuedBody(), title: getReviewIndexingQueuedTitle(params.projectId)}
}

const getProcessingReviewIndexingCopy = (params: ReviewIndexingCopyParams): ReviewIndexingCopy => {
  return hasOnlyArticleRefreshWork(params.indexing)
    ? {
        description: getArticleRefreshProcessingDescription(params.surface),
        title: 'New judgments are still being incorporated',
      }
    : {
        description: getProjectRefreshProcessingDescription(params.surface),
        title: getReviewIndexingInProgressTitle(params.projectId),
      }
}

export const getReviewIndexingStateCopy = (params: ReviewIndexingCopyParams): ReviewIndexingCopy => {
  return params.indexing.status === 'failed'
    ? getFailedReviewIndexingCopy()
    : params.indexing.status === 'blocked'
      ? {
          description: getReviewIndexingBlockedBody(params.indexing.blockedReason),
          title: getReviewIndexingBlockedTitle(params.indexing.blockedReason),
        }
      : params.indexing.progressState === 'stalled'
        ? {description: getReviewIndexingStalledBody(), title: getReviewIndexingStalledTitle()}
        : params.indexing.progressState === 'processing'
          ? getProcessingReviewIndexingCopy(params)
          : hasCleanupWork(params.indexing)
            ? getCleanupReviewIndexingCopy()
            : getQueuedReviewIndexingCopy(params)
}
