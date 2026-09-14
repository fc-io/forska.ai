import {expect, test} from 'bun:test'

import {
  completedJudgmentJobVisibilitySql,
  getCompletedJudgmentJobVisibilitySql,
  publishProjectedJudgmentJobVisibility,
} from './judgmentJobReviewServingVisibilityService.ts'

test('visibility publication waits for V4 result detail visibility before acking job partitions', () => {
  expect(completedJudgmentJobVisibilitySql).toContain("job.storage_state IN ('active', 'draining')")
  expect(completedJudgmentJobVisibilitySql).toContain('review_delta_reconciliation_cursor cursor')
  expect(completedJudgmentJobVisibilitySql).toContain('ORDER BY job.id')
  expect(completedJudgmentJobVisibilitySql).toContain('LIMIT 64')
  expect(completedJudgmentJobVisibilitySql).toContain('review_serving_project_dirty_source_watermark completed')
  expect(completedJudgmentJobVisibilitySql).toContain('completed.source_high_water_mark IS NULL')
  expect(completedJudgmentJobVisibilitySql).toContain(
    'completed.source_high_water_mark < candidate.source_high_water_mark',
  )
  expect(completedJudgmentJobVisibilitySql).toContain('pending_result_visibility_work')
  expect(completedJudgmentJobVisibilitySql).toContain("SELECT * FROM (VALUES ('llmStatus'), ('queue'), ('payload'))")
  expect(completedJudgmentJobVisibilitySql).toContain("dirty_work.status <> 'completed'")
  expect(completedJudgmentJobVisibilitySql).toContain('invisible_llm_delta')
  expect(completedJudgmentJobVisibilitySql).toContain('FROM mart.review_article_judgment_detail_serving_v4 detail')
  expect(completedJudgmentJobVisibilitySql).toContain("detail.payload_kind = 'llm'")
  expect(completedJudgmentJobVisibilitySql).toContain('ELSE candidate.source_high_water_mark')
  expect(completedJudgmentJobVisibilitySql).not.toContain('project_mart_refresh_state')
  expect(completedJudgmentJobVisibilitySql).not.toContain('THEN 0')
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

test('visibility publication uses the background query lane when available', async () => {
  const queryStatements: string[] = []
  const backgroundStatements: string[] = []
  const database = {
    queryJson: async (statement: string): Promise<never> => {
      queryStatements.push(statement)
      throw new Error('foreground visibility query should not run')
    },
    queryJsonBackground: async <T>(statement: string) => {
      backgroundStatements.push(statement)
      return [{ackToken: 17, jobId: 'job-background'}] as T[]
    },
  }
  const published: Array<{ackToken: number; jobId: string}> = []

  const publishedCount = await publishProjectedJudgmentJobVisibility(database, async (visibility) => {
    published.push(visibility)
  })

  expect(publishedCount).toBe(1)
  expect(queryStatements).toEqual([])
  expect(backgroundStatements).toHaveLength(1)
  expect(backgroundStatements[0]).toContain('candidate_job_visibility')
  expect(published).toEqual([{ackToken: 17, jobId: 'job-background'}])
})
