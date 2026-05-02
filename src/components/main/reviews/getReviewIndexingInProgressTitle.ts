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
  return blockedReason === 'paused_by_policy'
    ? 'Review indexing cooling down after memory pressure'
    : 'Review indexing blocked: waiting for maintenance worker'
}

export const getReviewIndexingBlockedBody = (blockedReason: ReviewIndexingBlockedReason) => {
  return blockedReason === 'paused_by_policy'
    ? 'Review index work is queued, but the maintenance worker is cooling down after memory pressure before starting more review refresh work.'
    : 'Review index work is queued and waiting for a maintenance worker to become available.'
}

const hasOnlyArticleRefreshWork = (indexing: ReviewsWarningsData['indexing']) => {
  return indexing.pendingArticleRefreshCount > 0 && indexing.pendingProjectRefreshCount === 0
}

const getLargeRebuildPhase = (indexing: ReviewsWarningsData['indexing']) => {
  return indexing.largeRebuild?.rebuildPhase ?? null
}

const getLargeRebuildPhasedDescription = (state: 'active' | 'queued') => {
  return state === 'queued'
    ? 'This staged rebuild is queued for its current phase. Large rebuilds run several passes over the same article scope, so the article counter resets when the phase changes.'
    : 'This project is being rebuilt in bounded phases. Each phase scans the same article scope, so current-phase article counts reset when the rebuild advances.'
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

const getFailedReviewIndexingCopy = (indexing: ReviewsWarningsData['indexing']): ReviewIndexingCopy => {
  const phase = getLargeRebuildPhase(indexing)

  return phase
    ? {
        description: indexing.largeRebuild?.lastError
          ? `Large rebuild failed: ${indexing.largeRebuild.lastError}`
          : 'The staged large rebuild failed. Review lists may stay stale or incomplete until the maintenance worker retries it.',
        title: `Large rebuild failed: ${phase}`,
      }
    : {
        description:
          'The latest review index refresh failed. Results may stay stale or incomplete until the maintenance worker retries the review index.',
        title: 'Review indexing failed',
      }
}

const getQueuedReviewIndexingCopy = (params: ReviewIndexingCopyParams): ReviewIndexingCopy => {
  const phase = getLargeRebuildPhase(params.indexing)

  return phase
    ? {description: getLargeRebuildPhasedDescription('queued'), title: `Large rebuild phase queued: ${phase}`}
    : hasOnlyArticleRefreshWork(params.indexing)
      ? {
          description: getArticleRefreshQueuedDescription(params.surface),
          title: 'New judgments are queued for incorporation',
        }
      : {description: getReviewIndexingQueuedBody(), title: getReviewIndexingQueuedTitle(params.projectId)}
}

const getProcessingReviewIndexingCopy = (params: ReviewIndexingCopyParams): ReviewIndexingCopy => {
  const phase = getLargeRebuildPhase(params.indexing)

  return phase
    ? {description: getLargeRebuildPhasedDescription('active'), title: `Large rebuild phase in progress: ${phase}`}
    : hasOnlyArticleRefreshWork(params.indexing)
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
    ? getFailedReviewIndexingCopy(params.indexing)
    : params.indexing.status === 'blocked'
      ? {
          description: getReviewIndexingBlockedBody(params.indexing.blockedReason),
          title: getReviewIndexingBlockedTitle(params.indexing.blockedReason),
        }
      : params.indexing.progressState === 'stalled'
        ? {description: getReviewIndexingStalledBody(), title: getReviewIndexingStalledTitle()}
        : params.indexing.progressState === 'processing'
          ? getProcessingReviewIndexingCopy(params)
          : getQueuedReviewIndexingCopy(params)
}
