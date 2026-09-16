import {expect, test} from 'bun:test'

import {runDataSourceTrackingCronWake} from './dataSourceTrackingCron.ts'

test('data source tracking cron respects the maintenance role gate', async () => {
  let wakeCallCount = 0
  const result = await runDataSourceTrackingCronWake({
    shouldRunMaintenanceLoops: () => {
      return false
    },
    worker: {
      wake: async () => {
        wakeCallCount += 1
        throw new Error('worker should not run')
      },
    },
  })

  expect(result).toEqual({reason: 'maintenance-role', status: 'skipped'})
  expect(wakeCallCount).toBe(0)
})

test('data source tracking cron runs the worker when maintenance is allowed', async () => {
  let wakeCallCount = 0
  const result = await runDataSourceTrackingCronWake({
    shouldRunMaintenanceLoops: () => {
      return true
    },
    worker: {
      wake: async () => {
        wakeCallCount += 1
        return {
          backpressureActive: false,
          claimedSourceCount: 0,
          dueSourceCount: 0,
          ingestedWindowCount: 0,
          ingestResults: [],
          reason: 'ran',
          sourceResults: [],
        }
      },
    },
  })

  expect(result.status).toBe('ran')
  expect(wakeCallCount).toBe(1)
})
