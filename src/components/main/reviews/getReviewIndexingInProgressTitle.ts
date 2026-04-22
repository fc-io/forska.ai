import type {ReviewsWarningsData} from './reviewsWarningsQuery.ts'

type ReviewIndexingBlockedReason = ReviewsWarningsData['indexing']['blockedReason']

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
  return 'Review index work has not made progress recently even though a maintenance worker should be available.'
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
