import {expect, test} from 'bun:test'

import {
  completedJudgmentJobVisibilitySql,
  getCompletedJudgmentJobVisibilitySql,
  publishProjectedJudgmentJobVisibility,
} from './judgmentJobReviewServingVisibilityService.ts'

test('visibility publication bridges bounded active job partitions into the project dirty-token domain', () => {
  expect(completedJudgmentJobVisibilitySql).toContain("job.storage_state IN ('active', 'draining')")
  expect(completedJudgmentJobVisibilitySql).toContain('WHEN refresh.dirty_token IS NULL THEN 0')
  expect(completedJudgmentJobVisibilitySql).toContain('THEN refresh.last_completed_dirty_token')
  expect(completedJudgmentJobVisibilitySql).toContain('refresh.dirty_token <= refresh.last_completed_dirty_token')
  expect(completedJudgmentJobVisibilitySql).toContain('project_mart_dirty_materialization_state materialization')
  expect(completedJudgmentJobVisibilitySql).toContain('project_mart_dirty_refresh_article_quarantine quarantine')
  expect(completedJudgmentJobVisibilitySql).toContain('review_delta_reconciliation_cursor cursor')
  expect(completedJudgmentJobVisibilitySql).toContain('ORDER BY job.id')
  expect(completedJudgmentJobVisibilitySql).toContain('LIMIT 64')
  expect(completedJudgmentJobVisibilitySql).toContain('review_serving_project_dirty_source_watermark completed')
  expect(completedJudgmentJobVisibilitySql).toContain('completed.source_high_water_mark IS NULL')
  expect(completedJudgmentJobVisibilitySql).toContain(
    'completed.source_high_water_mark < candidate.source_high_water_mark',
  )
  expect(completedJudgmentJobVisibilitySql).not.toContain('THEN cursor.source_high_water_mark')
  expect(completedJudgmentJobVisibilitySql).not.toContain('review_change_delta')
  expect(completedJudgmentJobVisibilitySql).not.toContain('review_serving_dirty_work_ack')
})

test('visibility publication rotates past a full candidate batch without publishing incomplete jobs', async () => {
  const statements: string[] = []
  const published: Array<{ackToken: number; jobId: string}> = []
  let queryCount = 0
  const firstDatabaseWrapper = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)
      queryCount += 1

      if (queryCount === 1) {
        return Array.from({length: 64}, (_, index) => {
          return {ackToken: null, jobId: `job-${String(index + 1).padStart(3, '0')}`}
        }) as T[]
      }

      return [{ackToken: 0, jobId: 'job-065'}] as T[]
    },
  }
  const secondDatabaseWrapper = {...firstDatabaseWrapper}

  expect(
    await publishProjectedJudgmentJobVisibility(firstDatabaseWrapper, async (visibility) => {
      published.push(visibility)
    }),
  ).toBe(0)
  expect(
    await publishProjectedJudgmentJobVisibility(secondDatabaseWrapper, async (visibility) => {
      published.push(visibility)
    }),
  ).toBe(1)
  expect(statements[1]).toContain("job.id > 'job-064'")
  expect(getCompletedJudgmentJobVisibilitySql('job-064')).toContain("job.id > 'job-064'")
  expect(published).toEqual([{ackToken: 0, jobId: 'job-065'}])
})

test('visibility publication preserves the project dirty token selected for each job', async () => {
  const published: Array<{ackToken: number; jobId: string}> = []
  const database = {
    queryJson: async <T>(_statement: string) => {
      return [
        {ackToken: 31, jobId: 'job-1'},
        {ackToken: 82, jobId: 'job-2'},
      ] as T[]
    },
  }

  expect(
    await publishProjectedJudgmentJobVisibility(database, async (visibility) => {
      published.push(visibility)
    }),
  ).toBe(2)
  expect(published).toEqual([
    {ackToken: 31, jobId: 'job-1'},
    {ackToken: 82, jobId: 'job-2'},
  ])
})
