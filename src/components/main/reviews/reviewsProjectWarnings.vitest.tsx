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
  return {
    enabledPromptCount: 1,
    indexing: {
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
      serving: {diagnostics: {}, manifest: {}, readable: true, usable: true},
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

test('renders DuckDB exclusive import pause without active progress copy', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({
      blockedReason: 'duckdb_exclusive_work_active',
      eligibleConsumerPresent: false,
      progressState: 'blocked',
      status: 'blocked',
    }),
  )

  try {
    expect(container.textContent).toContain('Review indexing paused during import')
    expect(container.textContent).toContain('using DuckDB exclusively')
    expect(container.textContent).not.toContain('Review indexing in progress')
  } finally {
    dispose()
  }
})

test('does not render retired large rebuild product warning copy', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({pendingArticleRefreshCount: 148, pendingRefreshCount: 149, queuedArticleRefreshCount: 148}),
  )

  try {
    expect(container.textContent).not.toContain('Current phase articles')
    expect(container.textContent).not.toContain('Dirty article ACKs')
    expect(container.textContent).not.toContain('Large rebuild')
    expect(container.textContent).toContain('Details: indexing 1 article')
    expect(container.textContent).not.toContain('0/min')
  } finally {
    dispose()
  }
})

test('renders unmeasured review indexing rates without implying zero throughput', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({progressState: 'processing', projectRefreshesPerMinute: null, queuedProjectRefreshCount: 1}),
  )

  try {
    expect(container.textContent).toContain('Review page: 0 / 1 article ready')
    expect(container.textContent).not.toContain('0/min')
  } finally {
    dispose()
  }
})

test('renders article coverage instead of rebuild chunk diagnostics', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({
      activeWorkCount: 2,
      coverage: {
        detailReadyArticleCount: 47,
        reviewPageReadyArticleCount: 92,
        searchReadyArticleCount: 24,
        totalArticleCount: 100,
      },
      inFlightProjectRefreshCount: 5,
      inFlightRefreshCount: 5,
      pendingProjectRefreshCount: 11,
      pendingRefreshCount: 11,
      progressState: 'processing',
      queuedProjectRefreshCount: 9,
      queuedRefreshCount: 9,
      serving: {
        diagnostics: {
          dirtyWork: {failedCount: 1, pendingCount: 2, runningCount: 1},
          rebuildChunks: {claimableCount: 3, expiredLeaseCount: 1, pendingCount: 7, runningCount: 3},
        },
        manifest: {},
        readable: true,
        usable: true,
      },
    }),
  )

  try {
    expect(container.textContent).toContain('Review page: 92 / 100 articles ready')
    expect(container.textContent).toContain('Details: 47 / 100 articles ready')
    expect(container.textContent).toContain('Search: 24 / 100 articles ready')
    expect(container.textContent).not.toContain('rebuild chunk')
    expect(container.textContent).not.toContain('dirty-work')
    expect(container.textContent).not.toContain('Project refreshes:')
  } finally {
    dispose()
  }
})

test('labels ready review page processing as background work', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({
      activeWorkCount: 1,
      coverage: {
        detailReadyArticleCount: 100,
        reviewPageReadyArticleCount: 100,
        searchReadyArticleCount: 42,
        totalArticleCount: 100,
      },
      progressState: 'processing',
    }),
  )

  try {
    expect(container.textContent).toContain('Background review indexing in progress')
    expect(container.textContent).toContain(
      'Review pages and details are ready. Search indexing is still catching up in the background.',
    )
    expect(container.textContent).toContain('Background work: updating search and enrichment in the background')
    expect(container.textContent).not.toContain('Review lists may look partial or empty')
    expect(container.textContent).not.toContain('Status: maintenance worker is updating the review index')
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
      inFlightArticleRefreshCount: 2,
      inFlightProjectRefreshCount: 1,
      inFlightRefreshCount: 3,
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
    expect(container.textContent).toContain('Review page: 0 / 1 article ready')
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
      inFlightProjectRefreshCount: 1,
      inFlightRefreshCount: 1,
      progressState: 'processing',
      queuedProjectRefreshCount: 0,
      serving: {
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
          processMemory: {rssBytes: 123456789},
          tempSpill: {
            available: true,
            error: null,
            fileCount: 4,
            tempDirectory: '/tmp/review-diagnostics',
            totalBytes: 987654,
          },
        },
        manifest: {},
        readable: true,
        usable: true,
      },
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
    expect(container.textContent).toContain('Indexing status: old index cleanup running')
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
