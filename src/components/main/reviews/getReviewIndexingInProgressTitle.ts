import type {ReviewsWarningsData} from './reviewsWarningsQuery.ts'

type ReviewIndexingBlockedReason = ReviewsWarningsData['indexing']['blockedReason']

export const getReviewIndexingInProgressTitle = (projectId: string) => {
  return `Review indexing in progress for project ${projectId}`
}

export const getReviewIndexingBlockedTitle = (blockedReason: ReviewIndexingBlockedReason) => {
  return blockedReason === 'paused_by_policy'
    ? 'Review indexing blocked: maintenance worker paused by low-memory policy'
    : 'Review indexing blocked: waiting for maintenance worker'
}

export const getReviewIndexingBlockedBody = (blockedReason: ReviewIndexingBlockedReason) => {
  return blockedReason === 'paused_by_policy'
    ? 'Review index work is queued, but this runtime is protecting the DuckDB memory cap by not starting review refresh work.'
    : 'Review index work is queued, but no eligible maintenance worker is currently draining it.'
}
