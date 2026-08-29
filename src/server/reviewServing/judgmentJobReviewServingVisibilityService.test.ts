import {expect, test} from 'bun:test'

import {
  completedJudgmentJobVisibilitySql,
  publishProjectedJudgmentJobVisibility,
} from './judgmentJobReviewServingVisibilityService.ts'

test('visibility publication requires every dirty row in the job source partition to have a current ack', () => {
  expect(completedJudgmentJobVisibilitySql).toContain("source_partition LIKE 'judgmentSqliteOutboxImport:%'")
  expect(completedJudgmentJobVisibilitySql).toContain('pending_work.source_partition = dirty.source_partition')
  expect(completedJudgmentJobVisibilitySql).toContain('completed_ack.dirty_work_id = pending_work.dirty_work_id')
  expect(completedJudgmentJobVisibilitySql).toContain("completed_ack.status = 'completed'")
  expect(completedJudgmentJobVisibilitySql).toContain(
    'completed_ack.completed_source_high_water_mark >= pending_work.latest_source_high_water_mark',
  )
})

test('visibility publication preserves the job-specific source high water mark', async () => {
  const published: Array<{ackToken: number; jobId: string}> = []
  const database = {
    queryJson: async <T>(_statement: string) => {
      return [
        {ackToken: 3, jobId: 'job-1'},
        {ackToken: 8, jobId: 'job-2'},
      ] as T[]
    },
  }

  expect(
    await publishProjectedJudgmentJobVisibility(database, async (visibility) => {
      published.push(visibility)
    }),
  ).toBe(2)
  expect(published).toEqual([
    {ackToken: 3, jobId: 'job-1'},
    {ackToken: 8, jobId: 'job-2'},
  ])
})
