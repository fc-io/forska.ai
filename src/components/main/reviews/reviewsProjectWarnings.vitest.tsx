// @vitest-environment happy-dom

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
    Link: (props: {children: unknown; class?: string; params?: unknown; to: string}) => {
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
      eligibleConsumerCount: 1,
      eligibleConsumerPresent: true,
      inFlightArticleRefreshCount: 0,
      inFlightProjectRefreshCount: 0,
      inFlightRefreshCount: 0,
      largeRebuild: null,
      lastProgressedAt: null,
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
      recoveryContext: null,
      recoveryMode: 'none',
      requiredConsumerRole: 'maintenance-worker',
      retryAfterAt: null,
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

test('renders memory-pressure cooldown without active progress copy', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({
      blockedReason: 'paused_by_policy',
      eligibleConsumerPresent: false,
      progressState: 'blocked',
      status: 'blocked',
    }),
  )

  try {
    expect(container.textContent).toContain('Review indexing cooling down after memory pressure')
    expect(container.textContent).toContain('cooling down after memory pressure')
    expect(container.textContent).not.toContain('Review indexing in progress')
  } finally {
    dispose()
  }
})

test('renders staged large rebuild progress separately from dirty article ACKs', async () => {
  const {container, dispose} = await renderWarnings(
    getWarningsData({
      largeRebuild: {
        cursorArticleCreatedAt: null,
        cursorArticleId: 'article-148',
        lastError: null,
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
    expect(container.textContent).toContain('Current phase articles: remaining 12 of 148 in this phase, 600/min')
    expect(container.textContent).toContain('Dirty article ACKs: 148 waiting until the staged rebuild finalizes')
    expect(container.textContent).toContain('Large rebuild: current phase 6 of 6 (review_article_serving)')
    expect(container.textContent).toContain('Article counts are per phase and reset when the rebuild advances')
    expect(container.textContent).not.toContain('Article refreshes: processing 0, queued 148, 0/min')
  } finally {
    dispose()
  }
})
