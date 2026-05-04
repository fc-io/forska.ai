import {beforeEach, expect, test} from 'bun:test'

import {
  getProjectMartLargeRebuildCycleQueueDelta,
  getProjectMartLargeRebuildRuntimeMetrics,
  recordProjectMartLargeRebuildCycleMetric,
  resetProjectMartLargeRebuildRuntimeMetricsForTests,
} from './projectMartLargeRebuildRuntimeMetrics.ts'

type QueueRuntimeMetrics = Parameters<typeof getProjectMartLargeRebuildCycleQueueDelta>[0]['started']

const getQueueRuntimeMetrics = (params: {
  backgroundCompleted: number
  backgroundDuration: number
  backgroundStarted: number
  backgroundWait: number
  mainCompleted: number
  mainDuration: number
  mainStarted: number
  mainWait: number
}): QueueRuntimeMetrics => {
  return {
    background: {
      lastDurationMs: params.backgroundDuration,
      lastWaitMs: params.backgroundWait,
      maxQueueDepth: 2,
      queueDepth: 0,
      tasksCompleted: params.backgroundCompleted,
      tasksStarted: params.backgroundStarted,
      totalDurationMs: params.backgroundDuration,
      totalWaitMs: params.backgroundWait,
    },
    main: {
      lastDurationMs: params.mainDuration,
      lastWaitMs: params.mainWait,
      maxQueueDepth: 3,
      queueDepth: 0,
      tasksCompleted: params.mainCompleted,
      tasksStarted: params.mainStarted,
      totalDurationMs: params.mainDuration,
      totalWaitMs: params.mainWait,
    },
  }
}

beforeEach(() => {
  resetProjectMartLargeRebuildRuntimeMetricsForTests()
})

test('large rebuild runtime metrics keep deterministic bounded performance diagnostics', () => {
  const started = getQueueRuntimeMetrics({
    backgroundCompleted: 5,
    backgroundDuration: 500,
    backgroundStarted: 6,
    backgroundWait: 100,
    mainCompleted: 10,
    mainDuration: 600,
    mainStarted: 11,
    mainWait: 50,
  })
  const finished = getQueueRuntimeMetrics({
    backgroundCompleted: 7,
    backgroundDuration: 620,
    backgroundStarted: 8,
    backgroundWait: 130,
    mainCompleted: 13,
    mainDuration: 700,
    mainStarted: 14,
    mainWait: 70,
  })
  const duckdbQueues = getProjectMartLargeRebuildCycleQueueDelta({finished, started})

  expect(duckdbQueues.background.tasksCompletedDelta).toBe(2)
  expect(duckdbQueues.background.totalWaitMsDelta).toBe(30)
  expect(duckdbQueues.main.tasksCompletedDelta).toBe(3)
  expect(duckdbQueues.main.totalWaitMsDelta).toBe(20)

  recordProjectMartLargeRebuildCycleMetric({
    articleCount: 2_000_000,
    committedRowCount: 10,
    duckdbQueues,
    durationMs: 250,
    endedAt: '2026-05-04T12:00:00.250Z',
    error: null,
    lastCommittedCursor: {articleCreatedAt: '2026-04-02T12:00:00.000Z', articleId: 'article-10'},
    phase: 'review_article_serving',
    processMemory: {rssBytes: 777},
    projectId: 'project-2m',
    startedAt: '2026-05-04T12:00:00.000Z',
    status: 'progressed',
    tempSpill: {available: true, error: null, fileCount: 1, tempDirectory: '/tmp/rebuild2-spill', totalBytes: 4096},
    workerId: 'worker-1',
  })
  recordProjectMartLargeRebuildCycleMetric({
    articleCount: 2_000_000,
    committedRowCount: 5,
    duckdbQueues: null,
    durationMs: 250,
    endedAt: '2026-05-04T12:00:00.500Z',
    error: null,
    lastCommittedCursor: {articleCreatedAt: '2026-04-02T12:00:01.000Z', articleId: 'article-15'},
    phase: 'review_article_serving',
    processMemory: {rssBytes: 999},
    projectId: 'project-2m',
    queueWaitMs: 7,
    startedAt: '2026-05-04T12:00:00.250Z',
    status: 'progressed',
    tempSpill: {available: true, error: null, fileCount: 2, tempDirectory: '/tmp/rebuild2-spill', totalBytes: 8192},
    workerId: 'worker-1',
  })

  const metrics = getProjectMartLargeRebuildRuntimeMetrics()

  expect(metrics.totals.rowsProcessed).toBe(15)
  expect(metrics.recentCycles[0]).toMatchObject({
    articleCount: 2_000_000,
    committedRowCount: 10,
    queueWaitMs: 50,
    rowsPerSecond: 40,
    tempSpill: {totalBytes: 4096},
  })
  expect(metrics.perPhase).toEqual([
    {
      committedRowCount: 15,
      cycleCount: 2,
      durationMs: 500,
      lastCommittedCursor: {articleCreatedAt: '2026-04-02T12:00:01.000Z', articleId: 'article-15'},
      lastEndedAt: '2026-05-04T12:00:00.500Z',
      lastRssBytes: 999,
      lastTempSpill: {
        available: true,
        error: null,
        fileCount: 2,
        tempDirectory: '/tmp/rebuild2-spill',
        totalBytes: 8192,
      },
      maxRssBytes: 999,
      maxTempSpillBytes: 8192,
      phase: 'review_article_serving',
      queueWaitMs: 57,
      rowsPerSecond: 30,
    },
  ])
})
