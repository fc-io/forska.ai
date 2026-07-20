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
