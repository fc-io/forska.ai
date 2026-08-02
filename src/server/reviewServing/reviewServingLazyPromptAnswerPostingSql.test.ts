import {DuckDBInstance} from '@duckdb/node-api'
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
  expect(sql).toContain("concat('review:promptAnswer:summary:', summary.summary_answer)")
  expect(sql).toContain("concat('human:promptAnswer:', judgment_human.prompt_id, ':', judgment_human.answer)")
  expect(sql).toContain("concat('human:promptAnswer:summary:', judgment_human_summary.answer)")
  expect(sql).toContain(
    'CROSS JOIN UNNEST(COALESCE(llm.answered_original_as_array, []::VARCHAR[])) AS answer(answer_value)',
  )
  expect(sql).toContain('project_prompt.criteria_disposition')
  expect(sql).toContain("WHEN prompt.criteria_disposition = 'exclude'")
  expect(sql).toContain("THEN llm.normalized_summary_answer = 'yes'")
  expect(sql).toContain("WHEN prompt.criteria_disposition = 'include'")
  expect(sql).toContain("THEN llm.normalized_summary_answer = 'no'")
  expect(sql).toContain('json_each(TRY_CAST(array_answer.answered_original AS JSON))')
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
  expect(insertSql).toContain('UNNEST(COALESCE(source.article_ids, []::VARCHAR[])) AS source_article(article_id)')
  expect(insertSql).not.toContain('source.article_id)')
  expect(insertSql).not.toContain('source.article_id IS NOT NULL')
  expect(insertSql).toContain('[]::VARCHAR[]')
  expect(insertSql).not.toContain('prompt-2')
})

test('lazy prompt-answer cache ensure writes only missing requested values in a transaction', async () => {
  const statements: string[] = []
  const database = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return [{filterValue: 'review:promptAnswer:prompt-2:no'}] as T[]
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
    missingFilterValues: ['review:promptAnswer:prompt-2:no'],
    requestedFilterValues: ['review:promptAnswer:prompt-1:yes', 'review:promptAnswer:prompt-2:no'],
    status: 'cacheWritten',
    writtenBucketCount: 1,
  })
  expect(statements).toHaveLength(5)
  expect(statements[1]).toBe('BEGIN TRANSACTION')
  expect(statements[4]).toBe('COMMIT')
  expect(joined).toContain("['review:promptAnswer:prompt-1:yes', 'review:promptAnswer:prompt-2:no']")
  expect(joined).toContain("SELECT DISTINCT unnest(['review:promptAnswer:prompt-2:no']::VARCHAR[])")
  expect(statements[3]).not.toContain('review:promptAnswer:prompt-1:yes')
})

test('lazy prompt-answer cache ensure uses the database transaction API when available', async () => {
  const statements: string[] = []
  let transactionCount = 0
  const database = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return [{filterValue: 'review:promptAnswer:prompt-1:yes'}] as T[]
    },
    run: async (statement: string) => {
      statements.push(`outside:${statement}`)
    },
    transaction: async <T>(operation: (tx: {run: (statement: string) => Promise<void>}) => Promise<T>) => {
      transactionCount += 1

      return operation({
        run: async (statement: string) => {
          statements.push(`tx:${statement}`)
        },
      })
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

  expect(result.status).toBe('cacheWritten')
  expect(transactionCount).toBe(1)
  expect(statements).not.toContain('BEGIN TRANSACTION')
  expect(statements).not.toContain('COMMIT')
  expect(statements).not.toContain('ROLLBACK')
  expect(
    statements.filter((statement) => {
      return statement.startsWith('tx:')
    }),
  ).toHaveLength(2)
  expect(
    statements.filter((statement) => {
      return statement.startsWith('outside:')
    }),
  ).toHaveLength(0)
})

test('lazy prompt-answer cache ensure treats existing requested buckets as fresh', async () => {
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
  expect(statements[0]).toContain('NOT EXISTS')
  expect(statements[0]).not.toContain('DELETE FROM mart.review_article_filter_posting_serving_v4')
  expect(statements[0]).not.toContain('INSERT INTO mart.review_article_filter_posting_serving_v4')
})

test('lazy prompt-answer cache ensure rolls back failed publication', async () => {
  const statements: string[] = []
  const database = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return [{filterValue: 'review:promptAnswer:prompt-1:yes'}] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
      if (statement.includes('INSERT INTO mart.review_article_filter_posting_serving_v4')) {
        throw new Error('synthetic insert failure')
      }
    },
  }

  let thrownError: unknown
  try {
    await ensureReviewServingLazyPromptAnswerPostingBuckets({
      database,
      filterValues: ['review:promptAnswer:prompt-1:yes'],
      listModeKey: 'llm',
      projectId: 'project-1',
      reviewConfigHash: 'review-config-1',
      snapshotId: 'snapshot-1',
    })
  } catch (error) {
    thrownError = error
  }

  expect(thrownError).toBeInstanceOf(Error)
  expect(thrownError).toHaveProperty('message', 'synthetic insert failure')
  expect(statements).toContain('BEGIN TRANSACTION')
  expect(statements).toContain('ROLLBACK')
  expect(statements).not.toContain('COMMIT')
})

test('lazy prompt-answer cache ensure coalesces concurrent identical requests', async () => {
  const statements: string[] = []
  let releaseMissingQuery: (() => void) | undefined
  const missingQueryReady = new Promise<void>((resolve) => {
    releaseMissingQuery = resolve
  })
  const database = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)
      await missingQueryReady

      return [{filterValue: 'review:promptAnswer:prompt-1:yes'}] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
  }
  const input = {
    database,
    filterValues: ['review:promptAnswer:prompt-1:yes'],
    listModeKey: 'llm',
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  }
  const first = ensureReviewServingLazyPromptAnswerPostingBuckets(input)
  const second = ensureReviewServingLazyPromptAnswerPostingBuckets(input)

  releaseMissingQuery?.()

  const results = await Promise.all([first, second])

  expect(results[0]).toMatchObject({status: 'cacheWritten', writtenBucketCount: 1})
  expect(results[1]).toMatchObject({status: 'cacheWritten', writtenBucketCount: 1})
  expect(
    statements.filter((statement) => {
      return statement.includes('SELECT requested.filter_value AS filterValue')
    }),
  ).toHaveLength(1)
  expect(
    statements.filter((statement) => {
      return statement.includes('INSERT INTO mart.review_article_filter_posting_serving_v4')
    }),
  ).toHaveLength(1)
})

test('lazy prompt-answer cache write executes against compact article_ids postings', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()
  const database = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      const reader = await connection.runAndReadAll(statement)

      return reader.getRowObjectsJson() as T[]
    },
    run: async (statement: string) => {
      await connection.run(statement)
    },
  }

  try {
    await connection.run(`
      CREATE SCHEMA app;
      CREATE SCHEMA mart;
      CREATE TABLE app.project (
        id VARCHAR,
        model_id VARCHAR,
        use_title BOOLEAN,
        use_abstract BOOLEAN,
        use_fulltext BOOLEAN,
        use_fulltext_no_images BOOLEAN,
        human_judgment_mode VARCHAR
      );
      CREATE TABLE app.prompt (
        id VARCHAR,
        archived BOOLEAN
      );
      CREATE TABLE app.project_prompt (
        project_id VARCHAR,
        prompt_id VARCHAR,
        enabled BOOLEAN,
        archived BOOLEAN,
        criteria_disposition VARCHAR
      );
      CREATE TABLE app."judgment" (
        id VARCHAR,
        article_id VARCHAR,
        prompt_id VARCHAR,
        model_id VARCHAR,
        use_title BOOLEAN,
        use_abstract BOOLEAN,
        use_fulltext BOOLEAN,
        use_fulltext_no_images BOOLEAN,
        answered_original VARCHAR,
        answered_original_as_array VARCHAR[],
        created_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ
      );
      CREATE TABLE app."judgment_human" (
        article_id VARCHAR,
        project_id VARCHAR,
        prompt_id VARCHAR,
        answer VARCHAR
      );
      CREATE TABLE app."judgment_human_summary" (
        article_id VARCHAR,
        project_id VARCHAR,
        answer VARCHAR
      );
      CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_id VARCHAR,
        has_llm_list_mode BOOLEAN,
        has_human_list_mode BOOLEAN,
        has_both_list_mode BOOLEAN
      );
      CREATE TABLE mart.review_article_filter_posting_serving_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_ids VARCHAR[],
        filter_kind VARCHAR,
        filter_value VARCHAR,
        list_mode_key VARCHAR
      );
      INSERT INTO app.project VALUES ('project-1', 'model-1', TRUE, TRUE, FALSE, FALSE, 'prompt');
      INSERT INTO app.prompt VALUES ('prompt-1', FALSE), ('prompt-2', FALSE);
      INSERT INTO app.project_prompt VALUES
        ('project-1', 'prompt-1', TRUE, FALSE, 'include'),
        ('project-1', 'prompt-2', TRUE, FALSE, 'exclude');
      INSERT INTO mart.review_article_serving_list_mode_state_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'article-1', TRUE, FALSE, FALSE),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-2', TRUE, FALSE, FALSE),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-3', TRUE, FALSE, FALSE);
      INSERT INTO app."judgment" VALUES
        ('judgment-1', 'article-1', 'prompt-1', 'model-1', TRUE, TRUE, FALSE, FALSE, 'yes', NULL, TIMESTAMPTZ '2026-01-01T00:00:00Z', NULL),
        ('judgment-1b', 'article-1', 'prompt-2', 'model-1', TRUE, TRUE, FALSE, FALSE, NULL, [' no '], TIMESTAMPTZ '2026-01-01T00:00:00Z', NULL),
        ('judgment-2', 'article-2', 'prompt-1', 'model-1', TRUE, TRUE, FALSE, FALSE, 'yes', NULL, TIMESTAMPTZ '2026-01-02T00:00:00Z', NULL),
        ('judgment-2b', 'article-2', 'prompt-2', 'model-1', TRUE, TRUE, FALSE, FALSE, '["yes"]', NULL, TIMESTAMPTZ '2026-01-02T00:00:00Z', NULL),
        ('judgment-3', 'article-3', 'prompt-1', 'model-1', TRUE, TRUE, FALSE, FALSE, 'no', NULL, TIMESTAMPTZ '2026-01-03T00:00:00Z', NULL),
        ('judgment-3b', 'article-3', 'prompt-2', 'model-1', TRUE, TRUE, FALSE, FALSE, 'no', NULL, TIMESTAMPTZ '2026-01-03T00:00:00Z', NULL);
    `)

    const firstResult = await ensureReviewServingLazyPromptAnswerPostingBuckets({
      database,
      filterValues: [
        'review:promptAnswer:prompt-1:yes',
        'review:promptAnswer:prompt-1:maybe',
        'review:promptAnswer:summary:yes',
        'review:promptAnswer:summary:no',
        'review:promptAnswer:summary:maybe',
      ],
      listModeKey: 'llm',
      projectId: 'project-1',
      reviewConfigHash: 'review-config-1',
      snapshotId: 'snapshot-1',
    })
    const postingReader = await connection.runAndReadAll(`
      SELECT filter_value AS filterValue, article_ids AS articleIds
      FROM mart.review_article_filter_posting_serving_v4
      ORDER BY filter_value
    `)
    const secondResult = await ensureReviewServingLazyPromptAnswerPostingBuckets({
      database,
      filterValues: [
        'review:promptAnswer:prompt-1:yes',
        'review:promptAnswer:prompt-1:maybe',
        'review:promptAnswer:summary:yes',
        'review:promptAnswer:summary:no',
        'review:promptAnswer:summary:maybe',
      ],
      listModeKey: 'llm',
      projectId: 'project-1',
      reviewConfigHash: 'review-config-1',
      snapshotId: 'snapshot-1',
    })

    expect(firstResult).toMatchObject({status: 'cacheWritten', writtenBucketCount: 5})
    expect(postingReader.getRowObjectsJson()).toEqual([
      {articleIds: [], filterValue: 'review:promptAnswer:prompt-1:maybe'},
      {articleIds: ['article-1', 'article-2'], filterValue: 'review:promptAnswer:prompt-1:yes'},
      {articleIds: [], filterValue: 'review:promptAnswer:summary:maybe'},
      {articleIds: ['article-2', 'article-3'], filterValue: 'review:promptAnswer:summary:no'},
      {articleIds: ['article-1'], filterValue: 'review:promptAnswer:summary:yes'},
    ])
    expect(secondResult).toMatchObject({missingFilterValues: [], status: 'cacheHit', writtenBucketCount: 0})
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})
