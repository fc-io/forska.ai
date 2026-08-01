import {expect, test} from 'bun:test'

import {
  ensureReviewServingLazyPromptAnswerPostingBuckets,
  getReviewServingLazyPromptAnswerPostingSourceSql,
  getReviewServingPromptAnswerPostingCacheWriteSqls,
} from './reviewServingLazyPromptAnswerPostingSql.ts'

test('lazy prompt-answer fallback reads eager judgment sources and preserves list-mode semantics', () => {
  const sql = getReviewServingLazyPromptAnswerPostingSourceSql({
    listModeSql: "'human'",
    projectIdSql: "'project-1'",
    reviewConfigHashSql: "'review-config-1'",
    snapshotIdSql: "'snapshot-1'",
  })

  expect(sql).not.toContain('mart.review_article_judgment_detail_serving_v4')
  expect(sql).toContain('FROM app."judgment" judgment')
  expect(sql).toContain('FROM app."judgment_human" judgment_human')
  expect(sql).toContain('FROM app."judgment_human_summary" judgment_human_summary')
  expect(sql).toContain('FROM mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(sql).toContain("WHEN 'llm' THEN list_mode_state.has_llm_list_mode")
  expect(sql).toContain("WHEN 'human' THEN list_mode_state.has_human_list_mode")
  expect(sql).toContain("WHEN 'both' THEN list_mode_state.has_both_list_mode")
  expect(sql).toContain("concat('review:promptAnswer:', llm.prompt_id, ':', llm.answered_original)")
  expect(sql).toContain("concat('review:promptAnswer:', llm.prompt_id, ':', answer.answer_value)")
  expect(sql).toContain("concat('human:promptAnswer:', judgment_human.prompt_id, ':', judgment_human.answer)")
  expect(sql).toContain("concat('human:promptAnswer:summary:', judgment_human_summary.answer)")
  expect(sql).toContain(
    'CROSS JOIN UNNEST(COALESCE(llm.answered_original_as_array, []::VARCHAR[])) AS answer(answer_value)',
  )
})

test('lazy prompt-answer fallback preserves human prompt-vs-summary semantics', () => {
  const sql = getReviewServingLazyPromptAnswerPostingSourceSql({
    listModeSql: "'human'",
    projectIdSql: "'project-1'",
    reviewConfigHashSql: "'review-config-1'",
    snapshotIdSql: "'snapshot-1'",
  })

  expect(sql).toContain('project_settings AS')
  expect(sql).toContain("COALESCE(project.human_judgment_mode, 'prompt') AS human_judgment_mode")
  expect(sql).toContain("AND project.human_judgment_mode <> 'summary'")
  expect(sql).toContain("AND project.human_judgment_mode = 'summary'")
  expect(sql).toContain('INNER JOIN active_prompt prompt')
  expect(sql).toContain('ON prompt.prompt_id = judgment_human.prompt_id')
  expect(sql).not.toContain('ON prompt.prompt_id = judgment_human_summary')
})

test('lazy prompt-answer cache write targets only requested missing buckets', () => {
  const [deleteSql = '', insertSql = ''] = getReviewServingPromptAnswerPostingCacheWriteSqls({
    filterValuesSql: "['review:promptAnswer:prompt-1:yes']",
    listModeSql: "'llm'",
    projectIdSql: "'project-1'",
    reviewConfigHashSql: "'review-config-1'",
    snapshotIdSql: "'snapshot-1'",
  })

  expect(deleteSql).toContain("filter_value IN (SELECT unnest(['review:promptAnswer:prompt-1:yes']::VARCHAR[]))")
  expect(deleteSql).not.toContain('prompt-2')
  expect(insertSql).toContain("SELECT DISTINCT unnest(['review:promptAnswer:prompt-1:yes']::VARCHAR[]) AS filter_value")
  expect(insertSql).toContain('source.filter_value = requested.filter_value')
  expect(insertSql).toContain('[]::VARCHAR[]')
  expect(insertSql).not.toContain('prompt-2')
})

test('lazy prompt-answer cache ensure writes only missing requested values', async () => {
  const statements: string[] = []
  const database = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return statement.includes('SELECT requested.filter_value AS filterValue')
        ? ([{filterValue: 'review:promptAnswer:prompt-1:yes'}] as T[])
        : []
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
  }

  const result = await ensureReviewServingLazyPromptAnswerPostingBuckets({
    database,
    filterValues: ['review:promptAnswer:prompt-1:yes', 'review:promptAnswer:prompt-2:no'],
    listModeKey: 'llm',
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  })
  const joined = statements.join('\n')

  expect(result).toMatchObject({
    missingFilterValues: ['review:promptAnswer:prompt-1:yes'],
    requestedFilterValues: ['review:promptAnswer:prompt-1:yes', 'review:promptAnswer:prompt-2:no'],
    status: 'cacheWritten',
    writtenBucketCount: 1,
  })
  expect(statements).toHaveLength(3)
  expect(joined).toContain("['review:promptAnswer:prompt-1:yes', 'review:promptAnswer:prompt-2:no']")
  expect(joined).toContain("['review:promptAnswer:prompt-1:yes']")
  expect(joined).not.toContain("['review:promptAnswer:prompt-2:no'] AS filter_value")
})

test('lazy prompt-answer cache ensure skips writes when requested buckets exist', async () => {
  const statements: string[] = []
  const database = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return []
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
  }

  const result = await ensureReviewServingLazyPromptAnswerPostingBuckets({
    database,
    filterValues: ['review:promptAnswer:prompt-1:yes'],
    listModeKey: 'llm',
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  })

  expect(result.status).toBe('cacheHit')
  expect(result.writtenBucketCount).toBe(0)
  expect(statements).toHaveLength(1)
})
