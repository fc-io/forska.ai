export type ReviewsIndexingStatus = 'blocked' | 'failed' | 'not-needed' | 'ready' | 'refreshing' | 'stale'

export const getReviewsIndexingStatus = (params: {
  enabledPromptCount: number
  hasActionableFailures: boolean
  hasAnyArticlesInScope: boolean
  hasBlockedCandidateSnapshot: boolean
  hasReviewServingRows: boolean
  isReviewServingProjectorPaused: boolean
  isServerMutationWorkDisabled: boolean
  pendingRefreshCount: number
  runningRefreshCount: number
}): ReviewsIndexingStatus => {
  const shouldIndexReviews = params.enabledPromptCount > 0 && params.hasAnyArticlesInScope

  if (!shouldIndexReviews) {
    return 'not-needed'
  }

  if (params.hasActionableFailures) {
    return 'failed'
  }

  if (
    (params.isReviewServingProjectorPaused
      && (!params.hasReviewServingRows || params.pendingRefreshCount > 0 || params.runningRefreshCount > 0))
    || params.hasBlockedCandidateSnapshot
    || (params.isServerMutationWorkDisabled && params.pendingRefreshCount > 0 && params.runningRefreshCount === 0)
  ) {
    return 'blocked'
  }

  if (params.pendingRefreshCount > 0) {
    return 'refreshing'
  }

  return params.hasReviewServingRows ? 'ready' : 'stale'
}
