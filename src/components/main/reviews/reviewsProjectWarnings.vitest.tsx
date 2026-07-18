// @vitest-environment happy-dom

import type {JSX} from 'solid-js'
import {render} from 'solid-js/web'
import {afterEach, beforeEach, expect, test, vi} from 'vitest'

import type {ReviewsWarningsData} from './reviewsWarningsQuery.ts'

const mockState = vi.hoisted(() => {
  return {warningsData: null as ReviewsWarningsData | null}
})

vi.mock('@tanstack/solid-query', () => {
  return {
    useQuery: () => {
      return {data: mockState.warningsData, isSuccess: mockState.warningsData !== null}
    },
  }
})

vi.mock('@tanstack/solid-router', () => {
  return {
    Link: (props: {children: JSX.Element; class?: string; params?: unknown; to: string}) => {
      return (
        <a class={props.class} href={props.to}>
          {props.children}
        </a>
      )
    },
  }
})

const getWarningsData = (indexing: Partial<ReviewsWarningsData['indexing']>): ReviewsWarningsData => {
  const queueMetrics = {
    lastDurationMs: null,
    lastWaitMs: null,
    maxQueueDepth: 0,
    queueDepth: 0,
    tasksCompleted: 0,
    tasksStarted: 0,
    totalDurationMs: 0,
    totalWaitMs: 0,
  }

  return {
    enabledPromptCount: 1,
    indexing: {
      activeConsumerCount: 0,
      activeWorkCount: 0,
      articleRefreshesPerMinute: null,
      blockedReason: null,
      diagnostics: {
        duckdbQueues: {background: queueMetrics, main: queueMetrics},
        largeRebuild: {currentPhase: null, lastCycle: null},
        processMemory: {rssBytes: 0},
        tempSpill: {available: false, error: null, fileCount: null, tempDirectory: null, totalBytes: null},
      },
      eligibleConsumerCount: 1,
      eligibleConsumerPresent: true,
      inFlightArticleRefreshCount: 0,
      inFlightProjectRefreshCount: 0,
      inFlightRefreshCount: 0,
      largeRebuild: null,
      lastProgressedAt: null,
      lastProcessedAt: null,
      lastStartedAt: null,
      oldestQueuedAt: '2026-04-02T12:00:00.000Z',
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
      serving: {readable: true, usable: true},
      status: 'refreshing',
      ...indexing,
    },
    projectId: 'project-1',
    scope: {hasAnyArticlesInScope: true},
  }
}

const renderWarnings = async (warningsData: ReviewsWarningsData) => {
  mockState.warningsData = warningsData
  const {ReviewsProjectWarnings} = await import('./reviewsProjectWarnings.tsx')

  const container = document.createElement('div')
  document.body.appendChild(container)
  const dispose = render(() => {
    return <ReviewsProjectWarnings projectId="project-1" />
  }, container)

  return {container, dispose}
}

beforeEach(() => {
  vi.resetModules()
  document.body.innerHTML = ''
  mockState.warningsData = null
})

afterEach(() => {
  document.body.innerHTML = ''
})

test('renders queued review indexing without active progress copy', async () => {
  const {container, dispose} = await renderWarnings(getWarningsData({progressState: 'queued'}))

  try {
    expect(container.textContent).toContain('Review indexing queued for project project-1')
    expect(container.textContent).not.toContain('Review indexing in progress')
  } finally {
    dispose()
  }
})

test('renders active review indexing only for processing progress', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({activeConsumerCount: 1, activeWorkCount: 1, progressState: 'processing'}),
  )

  try {
    expect(container.textContent).toContain('Review indexing in progress for project project-1')
  } finally {
    dispose()
  }
})

test('renders stalled review indexing without active progress copy', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({pendingProjectRefreshCount: 0, pendingRefreshCount: 0, progressState: 'stalled', status: 'stale'}),
  )

  try {
    expect(container.textContent).toContain('Review indexing stalled')
    expect(container.textContent).not.toContain('Review indexing in progress')
  } finally {
    dispose()
  }
})

test('renders blocked review indexing without active progress copy', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({
      blockedReason: 'waiting_for_maintenance_worker',
      eligibleConsumerCount: 0,
      eligibleConsumerPresent: false,
      progressState: 'blocked',
      status: 'blocked',
    }),
  )

  try {
    expect(container.textContent).toContain('Review indexing blocked: waiting for maintenance worker')
    expect(container.textContent).not.toContain('Review indexing in progress')
  } finally {
    dispose()
  }
})

test('renders automatic memory-pressure recovery without active progress copy', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({
      blockedReason: 'paused_by_policy',
      eligibleConsumerPresent: false,
      progressState: 'blocked',
      status: 'blocked',
    }),
  )

  try {
    expect(container.textContent).toContain('Review indexing recovering after memory pressure')
    expect(container.textContent).toContain('will resume review refresh work automatically')
    expect(container.textContent).not.toContain('Review indexing in progress')
  } finally {
    dispose()
  }
})

test('does not render legacy staged large rebuild progress in product warnings', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({
      largeRebuild: {
        cursorArticleCreatedAt: null,
        cursorArticleId: 'article-148',
        lastError: null,
        lastProgressedAt: '2026-04-02T12:12:00.000Z',
        lastStartedAt: '2026-04-02T12:05:00.000Z',
        operatorNote: null,
        progress: {remainingCurrentPhaseArticleCount: 12, rowsPerMinute: 600, scopeArticleCount: 148},
        rebuildPhase: 'review_article_serving',
        refreshStatus: 'idle',
        refreshToken: 5,
      },
      pendingArticleRefreshCount: 148,
      pendingRefreshCount: 149,
      queuedArticleRefreshCount: 148,
    }),
  )

  try {
    expect(container.textContent).not.toContain('Current phase articles')
    expect(container.textContent).not.toContain('Dirty article ACKs')
    expect(container.textContent).not.toContain('Large rebuild')
    expect(container.textContent).toContain('Article refreshes: processing 0, queued 148, 0/min')
  } finally {
    dispose()
  }
})

test('renders user-facing counts and progress timestamps for review indexing work', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({
      activeConsumerCount: 2,
      activeWorkCount: 2,
      cleanup: {inFlightGenerationCleanupCount: 1, lastProgressedAt: '2026-04-02T12:11:00.000Z'},
      dirtyMaterialization: {
        activeOwnerCount: 1,
        failedCount: 0,
        incompleteCount: 2,
        isActive: true,
        lastProgressedAt: '2026-04-02T12:10:00.000Z',
        oldestQueuedAt: '2026-04-02T12:00:00.000Z',
        pendingCount: 1,
        runningCount: 1,
        unreconciledCount: 0,
      },
      freshness: {
        dirtyToken: 8,
        hasIncompleteDirtyMaterialization: true,
        hasUnresolvedQuarantineBarrier: true,
        isFresh: false,
        lastCompletedDirtyToken: 6,
        refreshStatus: 'running',
        status: 'pending',
        unresolvedQuarantineBarrierCount: 1,
      },
      inFlightArticleRefreshCount: 2,
      inFlightProjectRefreshCount: 1,
      inFlightRefreshCount: 3,
      largeRebuild: {
        cursorArticleCreatedAt: null,
        cursorArticleId: null,
        lastError: null,
        lastProgressedAt: '2026-04-02T12:12:00.000Z',
        lastStartedAt: '2026-04-02T12:04:00.000Z',
        operatorNote: null,
        progress: {remainingCurrentPhaseArticleCount: 4, rowsPerMinute: null, scopeArticleCount: 9},
        rebuildPhase: 'review_article_rollup',
        refreshStatus: 'running',
        refreshToken: 8,
      },
      lastProgressedAt: '2026-04-02T12:12:00.000Z',
      lastStartedAt: '2026-04-02T12:04:00.000Z',
      pendingArticleRefreshCount: 2,
      pendingProjectRefreshCount: 1,
      pendingRefreshCount: 3,
      progressState: 'processing',
      quarantinedArticleRefreshCount: 1,
      quarantinedArticles: [
        {
          articleId: 'article-quarantined',
          createdAt: '2026-04-02T12:03:00.000Z',
          detectedBy: 'worker-1',
          error: 'Article refresh failed validation',
          updatedAt: '2026-04-02T12:09:00.000Z',
        },
      ],
      queuedArticleRefreshCount: 0,
      queuedProjectRefreshCount: 0,
    }),
  )

  try {
    expect(container.textContent).toContain('Project refreshes: processing 1, queued 0')
    expect(container.textContent).toContain('last progress')
    expect(container.textContent).not.toContain('Dirty materialization')
    expect(container.textContent).not.toContain('Quarantine')
    expect(container.textContent).not.toContain('last updated')
    expect(container.textContent).toContain('Cleanup: 1 old-generation cleanup job running')
    expect(container.textContent).not.toContain('Large rebuild')
  } finally {
    dispose()
  }
})

test('does not render admin-only diagnostics in the user indexing banner', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({
      activeConsumerCount: 1,
      activeWorkCount: 1,
      diagnostics: {
        duckdbQueues: {
          background: {
            lastDurationMs: 4,
            lastWaitMs: 3,
            maxQueueDepth: 7,
            queueDepth: 2,
            tasksCompleted: 11,
            tasksStarted: 12,
            totalDurationMs: 40,
            totalWaitMs: 30,
          },
          main: {
            lastDurationMs: 5,
            lastWaitMs: 25,
            maxQueueDepth: 9,
            queueDepth: 4,
            tasksCompleted: 21,
            tasksStarted: 22,
            totalDurationMs: 50,
            totalWaitMs: 250,
          },
        },
        largeRebuild: {
          currentPhase: {
            committedRowCount: 900,
            cycleCount: 3,
            durationMs: 60000,
            lastEndedAt: '2026-04-02T12:12:00.000Z',
            lastRssBytes: 123456789,
            lastTempSpill: {
              available: true,
              error: null,
              fileCount: 4,
              tempDirectory: '/tmp/review-diagnostics',
              totalBytes: 987654,
            },
            maxRssBytes: 123456789,
            maxTempSpillBytes: 987654,
            phase: 'review_article_serving',
            queueWaitMs: 25,
            rowsPerSecond: 15,
          },
          lastCycle: {
            endedAt: '2026-04-02T12:12:00.000Z',
            phase: 'review_article_serving',
            queueWaitMs: 25,
            rowsPerSecond: 15,
            rssBytes: 123456789,
            tempSpill: {
              available: true,
              error: null,
              fileCount: 4,
              tempDirectory: '/tmp/review-diagnostics',
              totalBytes: 987654,
            },
          },
        },
        processMemory: {rssBytes: 123456789},
        tempSpill: {
          available: true,
          error: null,
          fileCount: 4,
          tempDirectory: '/tmp/review-diagnostics',
          totalBytes: 987654,
        },
      },
      inFlightProjectRefreshCount: 1,
      inFlightRefreshCount: 1,
      progressState: 'processing',
      queuedProjectRefreshCount: 0,
    }),
  )

  try {
    expect(container.textContent).not.toContain('rows/sec')
    expect(container.textContent).not.toContain('RSS')
    expect(container.textContent).not.toContain('temp spill')
    expect(container.textContent).not.toContain('/tmp/review-diagnostics')
    expect(container.textContent).not.toContain('queue wait')
    expect(container.textContent).not.toContain('123456789')
  } finally {
    dispose()
  }
})

test('renders bounded cleanup while review index reads stay ready', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({
      cleanup: {inFlightGenerationCleanupCount: 1, lastProgressedAt: '2026-04-02T12:11:00.000Z'},
      pendingProjectRefreshCount: 0,
      pendingRefreshCount: 0,
      progressState: 'completed',
      queuedProjectRefreshCount: 0,
      queuedRefreshCount: 0,
      status: 'ready',
    }),
  )

  try {
    expect(container.textContent).toContain('Review cleanup in progress')
    expect(container.textContent).toContain('Current review pages remain usable')
    expect(container.textContent).toContain('Status: old index cleanup running')
    expect(container.textContent).toContain('Cleanup: 1 old-generation cleanup job running')
    expect(container.textContent).toContain('last progress')
  } finally {
    dispose()
  }
})

test('renders browser review-flow freshness diagnostics for stale indexing and unavailable states', async () => {
  const cases = [
    {
      expectedBody: 'Review indexing appears stalled because the review index is missing or stale',
      expectedTitle: 'Review indexing stalled',
      indexing: getWarningsData({
        pendingProjectRefreshCount: 0,
        pendingRefreshCount: 0,
        progressState: 'stalled',
        status: 'stale',
      }),
    },
    {
      expectedBody: 'Review lists may look partial or empty until indexing finishes.',
      expectedTitle: 'Review indexing in progress for project project-1',
      indexing: getWarningsData({activeConsumerCount: 1, activeWorkCount: 1, progressState: 'processing'}),
    },
    {
      expectedBody: 'The latest review index refresh failed.',
      expectedTitle: 'Review indexing failed',
      indexing: getWarningsData({progressState: 'failed', status: 'failed'}),
    },
  ]

  await cases.reduce(async (previous, testCase) => {
    await previous

    return renderWarnings(testCase.indexing).then(({container, dispose}) => {
      try {
        expect(container.textContent).toContain(testCase.expectedTitle)
        expect(container.textContent).toContain(testCase.expectedBody)
      } finally {
        dispose()
      }
    })
  }, Promise.resolve())
})
