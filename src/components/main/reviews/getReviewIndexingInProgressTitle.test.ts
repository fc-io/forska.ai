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
    coverage: {
      detailReadyArticleCount: null,
      reviewPageReadyArticleCount: 0,
      searchReadyArticleCount: null,
      totalArticleCount: 1,
    },
    eligibleConsumerCount: 1,
    eligibleConsumerPresent: true,
    inFlightArticleRefreshCount: 0,
    inFlightProjectRefreshCount: 0,
    inFlightRefreshCount: 0,
    lastProgressedAt: null,
    lastProcessedAt: null,
    lastStartedAt: null,
    maintenance: {
      hasActionableFailures: false,
      hasHistoricalFailures: false,
      status: 'processing',
      terminalDirtyWorkCount: 0,
      terminalQuarantineCount: 0,
      terminalRebuildChunkCount: 0,
    },
    oldestQueuedAt: null,
    pendingArticleRefreshCount: 0,
    pendingProjectRefreshCount: 1,
    pendingRefreshCount: 1,
    progressState: 'queued',
    projectRefreshesPerMinute: null,
    queuedArticleRefreshCount: 0,
    queuedProjectRefreshCount: 1,
    queuedRefreshCount: 1,
    quarantinedArticleRefreshCount: 0,
    quarantinedArticles: [],
    recoveryContext: null,
    recoveryMode: 'none',
    requiredConsumerRole: 'maintenance-worker',
    retryAfterAt: null,
    serving: {diagnostics: {}, manifest: {}, readable: true, usable: true},
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

test('ready review pages describe processing as background work', () => {
  const copy = getReviewIndexingStateCopy({
    indexing: getIndexing({
      activeWorkCount: 1,
      coverage: {
        detailReadyArticleCount: 100,
        reviewPageReadyArticleCount: 100,
        searchReadyArticleCount: 42,
        totalArticleCount: 100,
      },
      progressState: 'processing',
    }),
    projectId: 'project-1',
    surface: 'banner',
  })

  expect(copy.title).toBe('Background review indexing in progress')
  expect(copy.description).toBe(
    'Review pages and details are ready. Search indexing is still catching up in the background.',
  )
  expect(copy.description).not.toContain('partial or empty')
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

test('review indexing blocked copy distinguishes worker wait from automatic memory recovery', () => {
  expect(getReviewIndexingBlockedTitle('duckdb_exclusive_work_active')).toBe('Review indexing paused during import')
  expect(getReviewIndexingBlockedBody('duckdb_exclusive_work_active')).toContain('using DuckDB exclusively')
  expect(getReviewIndexingBlockedTitle('waiting_for_maintenance_worker')).toBe(
    'Review indexing blocked: waiting for maintenance worker',
  )
  expect(getReviewIndexingBlockedBody('waiting_for_maintenance_worker')).toContain('waiting for a maintenance worker')
  expect(getReviewIndexingBlockedTitle('paused_by_policy')).toBe('Review indexing recovering after memory pressure')
  expect(getReviewIndexingBlockedBody('paused_by_policy')).toContain('will resume review refresh work automatically')
})

test('cleanup copy keeps ready review pages usable', () => {
  const copy = getReviewIndexingStateCopy({
    indexing: getIndexing({
      cleanup: {inFlightGenerationCleanupCount: 1, lastProgressedAt: '2026-04-02T12:11:00.000Z'},
      pendingProjectRefreshCount: 0,
      pendingRefreshCount: 0,
      progressState: 'completed',
      queuedProjectRefreshCount: 0,
      queuedRefreshCount: 0,
      status: 'ready',
    }),
    projectId: 'project-1',
    surface: 'banner',
  })

  expect(copy.title).toBe('Review cleanup in progress')
  expect(copy.description).toContain('Current review pages remain usable')
})
