import {expect, test} from 'bun:test'

import {runDataSourceImportResumeCronWake} from './dataSourceImportResumeCron.ts'

test('data source import resume cron only runs on the DuckDB owner with the maintenance role', async () => {
  let wakeCallCount = 0
  const result = await runDataSourceImportResumeCronWake({
    shouldResumeImports: () => {
      return false
    },
    wake: async () => {
      wakeCallCount += 1
      throw new Error('resumer should not run')
    },
  })

  expect(result).toEqual({reason: 'maintenance-role', status: 'skipped'})
  expect(wakeCallCount).toBe(0)
})

test('data source import resume cron runs the resumer when the owner may resume imports', async () => {
  let wakeCallCount = 0
  const result = await runDataSourceImportResumeCronWake({
    shouldResumeImports: () => {
      return true
    },
    wake: async () => {
      wakeCallCount += 1
      return {attempts: [], stopped: []}
    },
  })

  expect(result).toEqual({result: {attempts: [], stopped: []}, status: 'ran'})
  expect(wakeCallCount).toBe(1)
})
