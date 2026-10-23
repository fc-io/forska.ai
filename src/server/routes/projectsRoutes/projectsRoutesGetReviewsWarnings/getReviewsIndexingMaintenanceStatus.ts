type ReviewsIndexingMaintenanceStatus = 'blocked' | 'failed' | 'idle' | 'processing'

export const getReviewsIndexingMaintenanceStatus = (params: {
  hasActionableFailures: boolean
  hasBlockedLiveWork: boolean
  hasLiveRefreshWork: boolean
}): ReviewsIndexingMaintenanceStatus => {
  return params.hasActionableFailures
    ? 'failed'
    : params.hasBlockedLiveWork
      ? 'blocked'
      : params.hasLiveRefreshWork
        ? 'processing'
        : 'idle'
}
