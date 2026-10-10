import {expect, test} from 'bun:test'

import {runComparisonProjectServingMaintenanceWorkerOnce} from './comparisonProjectServingMaintenanceWorker.ts'

test('comparison project serving maintenance worker skips while foreground DuckDB work is queued', async () => {
  let rebuildCalled = false
  const result = await runComparisonProjectServingMaintenanceWorkerOnce({
    getAppendQueueDepth: () => {
      return 0
    },
    getForegroundQueueDepth: () => {
      return 1
    },
    rebuildNextUnavailableComparisonProjectServing: async () => {
      rebuildCalled = true
      return {comparisonProjectId: 'comparison-1', rebuildResult: null, rebuilt: true}
    },
  })

  expect(result).toEqual({comparisonProjectId: null, reason: 'foreground-work-active', status: 'idle'})
  expect(rebuildCalled).toBe(false)
})

test('comparison project serving maintenance worker skips while append DuckDB work is queued', async () => {
  let rebuildCalled = false
  const result = await runComparisonProjectServingMaintenanceWorkerOnce({
    getAppendQueueDepth: () => {
      return 1
    },
    getForegroundQueueDepth: () => {
      return 0
    },
    rebuildNextUnavailableComparisonProjectServing: async () => {
      rebuildCalled = true
      return {comparisonProjectId: 'comparison-1', rebuildResult: null, rebuilt: true}
    },
  })

  expect(result).toEqual({comparisonProjectId: null, reason: 'foreground-work-active', status: 'idle'})
  expect(rebuildCalled).toBe(false)
})

test('comparison project serving maintenance worker drains one unavailable project when foreground queues are idle', async () => {
  const result = await runComparisonProjectServingMaintenanceWorkerOnce({
    getAppendQueueDepth: () => {
      return 0
    },
    getForegroundQueueDepth: () => {
      return 0
    },
    hasReviewServingRebuildWork: async () => {
      return false
    },
    rebuildNextUnavailableComparisonProjectServing: async () => {
      return {comparisonProjectId: 'comparison-1', rebuildResult: null, rebuilt: true}
    },
  })

  expect(result).toEqual({comparisonProjectId: 'comparison-1', rebuilt: true, status: 'processed'})
})

test('comparison project serving maintenance worker skips while review serving rebuild work is active', async () => {
  let rebuildCalled = false
  const result = await runComparisonProjectServingMaintenanceWorkerOnce({
    getAppendQueueDepth: () => {
      return 0
    },
    getForegroundQueueDepth: () => {
      return 0
    },
    hasReviewServingRebuildWork: async () => {
      return true
    },
    rebuildNextUnavailableComparisonProjectServing: async () => {
      rebuildCalled = true
      return {comparisonProjectId: 'comparison-1', rebuildResult: null, rebuilt: true}
    },
  })

  expect(result).toEqual({comparisonProjectId: null, reason: 'review-serving-work-active', status: 'idle'})
  expect(rebuildCalled).toBe(false)
})

test('comparison project serving maintenance worker stays idle when no comparison project needs rebuild', async () => {
  const result = await runComparisonProjectServingMaintenanceWorkerOnce({
    backfillNextComparisonJudgmentContext: async () => {
      return {comparisonProjectId: null, generation: null, status: 'idle' as const}
    },
    getAppendQueueDepth: () => {
      return 0
    },
    getForegroundQueueDepth: () => {
      return 0
    },
    hasReviewServingRebuildWork: async () => {
      return false
    },
    rebuildNextUnavailableComparisonProjectServing: async () => {
      return {comparisonProjectId: null, rebuildResult: null, rebuilt: false}
    },
  })

  expect(result).toEqual({comparisonProjectId: null, reason: 'no-unavailable-project', status: 'idle'})
})

test('comparison project serving maintenance worker backfills one missing judgment context when no rebuild is due', async () => {
  let backfillCalls = 0
  const result = await runComparisonProjectServingMaintenanceWorkerOnce({
    backfillNextComparisonJudgmentContext: async () => {
      backfillCalls += 1
      return {
        comparisonProjectId: 'comparison-1',
        generation: 4,
        judgmentContextId: 'context-1',
        status: 'written' as const,
      }
    },
    getAppendQueueDepth: () => {
      return 0
    },
    getForegroundQueueDepth: () => {
      return 0
    },
    hasReviewServingRebuildWork: async () => {
      return false
    },
    rebuildNextUnavailableComparisonProjectServing: async () => {
      return {comparisonProjectId: null, rebuildResult: null, rebuilt: false}
    },
  })

  expect(backfillCalls).toBe(1)
  expect(result).toEqual({
    comparisonProjectId: 'comparison-1',
    generation: 4,
    judgmentContextId: 'context-1',
    reason: 'judgment-context-backfilled',
    status: 'backfilled',
  })
})

test('comparison project serving maintenance worker rebuilds before it backfills judgment contexts', async () => {
  let backfillCalls = 0
  const result = await runComparisonProjectServingMaintenanceWorkerOnce({
    backfillNextComparisonJudgmentContext: async () => {
      backfillCalls += 1
      return {
        comparisonProjectId: 'comparison-2',
        generation: 1,
        judgmentContextId: 'context-2',
        status: 'written' as const,
      }
    },
    getAppendQueueDepth: () => {
      return 0
    },
    getForegroundQueueDepth: () => {
      return 0
    },
    hasReviewServingRebuildWork: async () => {
      return false
    },
    rebuildNextUnavailableComparisonProjectServing: async () => {
      return {comparisonProjectId: 'comparison-1', rebuildResult: null, rebuilt: true} as never
    },
  })

  expect(backfillCalls).toBe(0)
  expect(result).toEqual({comparisonProjectId: 'comparison-1', rebuilt: true, status: 'processed'})
})

test('comparison project serving maintenance worker reports a failed judgment context backfill with its ids', async () => {
  const nextAttemptAt = new Date('2026-10-10T12:01:00.000Z')
  const result = await runComparisonProjectServingMaintenanceWorkerOnce({
    backfillNextComparisonJudgmentContext: async () => {
      return {
        attempts: 1,
        comparisonProjectId: 'comparison-3',
        errorMessage: 'boom',
        generation: 7,
        nextAttemptAt,
        status: 'failed' as const,
      }
    },
    getAppendQueueDepth: () => {
      return 0
    },
    getForegroundQueueDepth: () => {
      return 0
    },
    hasReviewServingRebuildWork: async () => {
      return false
    },
    rebuildNextUnavailableComparisonProjectServing: async () => {
      return {comparisonProjectId: null, rebuildResult: null, rebuilt: false}
    },
  })

  expect(result).toEqual({
    attempts: 1,
    comparisonProjectId: 'comparison-3',
    errorMessage: 'boom',
    generation: 7,
    nextAttemptAt,
    reason: 'judgment-context-backfill-failed',
    status: 'idle',
  })
})

test('comparison project serving maintenance worker treats a skipped judgment context backfill as idle', async () => {
  const result = await runComparisonProjectServingMaintenanceWorkerOnce({
    backfillNextComparisonJudgmentContext: async () => {
      return {comparisonProjectId: 'comparison-4', generation: 2, status: 'skipped' as const}
    },
    getAppendQueueDepth: () => {
      return 0
    },
    getForegroundQueueDepth: () => {
      return 0
    },
    hasReviewServingRebuildWork: async () => {
      return false
    },
    rebuildNextUnavailableComparisonProjectServing: async () => {
      return {comparisonProjectId: null, rebuildResult: null, rebuilt: false}
    },
  })

  expect(result).toEqual({comparisonProjectId: null, reason: 'no-unavailable-project', status: 'idle'})
})
