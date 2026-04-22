import {expect, test} from 'bun:test'

import {
  getReviewIndexingBlockedBody,
  getReviewIndexingBlockedTitle,
  getReviewIndexingInProgressTitle,
  getReviewIndexingQueuedBody,
  getReviewIndexingQueuedTitle,
  getReviewIndexingStalledBody,
  getReviewIndexingStalledTitle,
  getReviewIndexingStateCopy,
} from './getReviewIndexingInProgressTitle.ts'
import type {ReviewsWarningsData} from './reviewsWarningsQuery.ts'

const getIndexing = (overrides: Partial<ReviewsWarningsData['indexing']>): ReviewsWarningsData['indexing'] => {
  return {
    activeConsumerCount: 0,
    activeWorkCount: 0,
    articleRefreshesPerMinute: null,
    blockedReason: null,
    eligibleConsumerCount: 1,
    eligibleConsumerPresent: true,
    inFlightArticleRefreshCount: 0,
    inFlightProjectRefreshCount: 0,
    inFlightRefreshCount: 0,
    largeRebuild: null,
    lastProgressedAt: null,
    lastStartedAt: null,
    oldestQueuedAt: null,
    pendingArticleRefreshCount: 0,
    pendingProjectRefreshCount: 1,
    pendingRefreshCount: 1,
    progressState: 'queued',
    projectRefreshesPerMinute: null,
    queuedArticleRefreshCount: 0,
    queuedProjectRefreshCount: 1,
    queuedRefreshCount: 1,
    recoveryContext: null,
    recoveryMode: 'none',
    requiredConsumerRole: 'maintenance-worker',
    retryAfterAt: null,
    status: 'refreshing',
    ...overrides,
  }
}

test('review indexing queued copy does not claim active progress', () => {
  expect(getReviewIndexingQueuedTitle('project-1')).toBe('Review indexing queued for project project-1')
  expect(getReviewIndexingQueuedTitle('project-1')).not.toContain('in progress')
  expect(getReviewIndexingQueuedBody()).toContain('queued')

  const copy = getReviewIndexingStateCopy({
    indexing: getIndexing({progressState: 'queued'}),
    projectId: 'project-1',
    surface: 'banner',
  })
  expect(copy.title).toBe('Review indexing queued for project project-1')
  expect(copy.title).not.toContain('in progress')
})

test('review indexing progress copy is reserved for active progress', () => {
  expect(getReviewIndexingInProgressTitle('project-1')).toBe('Review indexing in progress for project project-1')

  const copy = getReviewIndexingStateCopy({
    indexing: getIndexing({activeWorkCount: 1, progressState: 'processing'}),
    projectId: 'project-1',
    surface: 'banner',
  })
  expect(copy.title).toBe('Review indexing in progress for project project-1')
})

test('review indexing stalled copy does not claim active progress', () => {
  expect(getReviewIndexingStalledTitle()).toBe('Review indexing stalled')
  expect(getReviewIndexingStalledTitle()).not.toContain('in progress')
  expect(getReviewIndexingStalledBody()).toContain('no active processing')

  const copy = getReviewIndexingStateCopy({
    indexing: getIndexing({
      pendingProjectRefreshCount: 0,
      pendingRefreshCount: 0,
      progressState: 'stalled',
      status: 'stale',
    }),
    projectId: 'project-1',
    surface: 'banner',
  })
  expect(copy.title).toBe('Review indexing stalled')
  expect(copy.title).not.toContain('in progress')
})

test('review indexing blocked copy distinguishes worker wait from memory cooldown', () => {
  expect(getReviewIndexingBlockedTitle('waiting_for_maintenance_worker')).toBe(
    'Review indexing blocked: waiting for maintenance worker',
  )
  expect(getReviewIndexingBlockedBody('waiting_for_maintenance_worker')).toContain('waiting for a maintenance worker')
  expect(getReviewIndexingBlockedTitle('paused_by_policy')).toBe('Review indexing cooling down after memory pressure')
  expect(getReviewIndexingBlockedBody('paused_by_policy')).toContain('cooling down after memory pressure')
})
