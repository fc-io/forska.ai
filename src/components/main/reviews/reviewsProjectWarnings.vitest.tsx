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
  const {container, dispose} = await renderWarnings(getWarningsData({progressState: 'stalled'}))

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
