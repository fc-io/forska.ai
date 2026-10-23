import type {ReviewsIndexingStatus} from './getReviewsIndexingStatus.ts'

type ReviewsIndexingProgressState = 'blocked' | 'completed' | 'failed' | 'processing' | 'queued' | 'stalled'

export const getReviewsIndexingProgressState = (params: {
  claimableRefreshCount: number
  hasRecentProgress: boolean
  inFlightRefreshCount: number
  status: ReviewsIndexingStatus
}): ReviewsIndexingProgressState => {
  return params.status === 'ready' || params.status === 'not-needed'
    ? 'completed'
    : params.status === 'failed'
      ? 'failed'
      : params.status === 'blocked'
        ? 'blocked'
        : params.status === 'refreshing' && params.inFlightRefreshCount > 0
          ? 'processing'
          : params.status === 'refreshing' && params.hasRecentProgress
            ? 'processing'
            : params.status === 'refreshing' && params.claimableRefreshCount > 0
              ? 'queued'
              : 'stalled'
}
