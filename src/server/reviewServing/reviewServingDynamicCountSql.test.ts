import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {getReviewServingDynamicFilteredCountSql} from './reviewServingDynamicCountSql.ts'

test('dynamic filtered counts use posting-only fast path for one posting group', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    postingFilterGroups: [{filterKind: 'importRoute', filterValues: ['import-route-1']}],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  })

  expect(sql).toContain('FROM mart.review_article_filter_posting_serving_v4 posting')
  expect(sql).toContain('CROSS JOIN UNNEST(posting.article_ids) AS posting_article(article_id)')
  expect(sql).toContain('SELECT DISTINCT posting_article.article_id')
  expect(sql).toContain('FROM posting_filtered_article_ids filtered_article_ids')
  expect(sql).toContain('posting.project_id = scoped.project_id')
  expect(sql).toContain('posting.review_config_hash = scoped.review_config_hash')
  expect(sql).toContain('posting.snapshot_id = scoped.snapshot_id')
  expect(sql).toContain('posting.list_mode_key = scoped.list_mode_key')
  expect(sql).toContain('SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount')
  expect(sql).not.toContain('mart.review_article_serving_base_v4')
  expect(sql).not.toContain('mart.review_article_serving_list_mode_state_v4')
  expect(sql).not.toContain('list_contains(list_mode_keys')
  expect(sql).not.toContain('list_contains(list_mode_state.list_mode_keys')
  expect(sql).not.toContain('matched_posting_rows AS')
  expect(sql).not.toContain('posting_anchor_rows AS')
  expect(sql).not.toContain('HAVING COUNT(DISTINCT CASE')
  expect(sql).not.toContain('scoped_serving AS')
})

test('dynamic filtered counts can read prompt-answer groups from canonical rows after lazy publication failure', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    postingFilterGroups: [
      {filterKind: 'importRoute', filterValues: ['import-route-1']},
      {filterKind: 'promptAnswer', filterValues: ['review:promptAnswer:prompt-1:yes']},
    ],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
    useCanonicalPromptAnswerPostings: true,
  })

  expect(sql).toContain('canonical_prompt_answer_posting_rows AS')
  expect(sql).toContain('posting_filter_rows AS')
  expect(sql).toContain('FROM mart.review_article_filter_posting_serving_v4 posting')
  expect(sql).toContain("posting.filter_kind <> 'promptAnswer'")
  expect(sql).toContain('SELECT * FROM canonical_prompt_answer_posting_rows')
  expect(sql).toContain('FROM app."judgment" judgment')
  expect(sql).toContain("concat('review:promptAnswer:', llm.prompt_id, ':', llm.answered_original)")
  expect(sql).toContain("['review:promptAnswer:prompt-1:yes']")
  expect(sql).toContain('FROM posting_filter_rows posting')
  expect(sql).toContain("WHEN posting.filter_kind = 'importRoute'")
  expect(sql).toContain("WHEN posting.filter_kind = 'promptAnswer'")
  expect(sql).toContain('posting_filtered_article_ids AS')
  expect(sql).toContain('SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount')
})

test('dynamic filtered counts anchor multi-group posting intersections on the smallest posting row', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    postingFilterGroups: [
      {filterKind: 'importRoute', filterValues: ['import-route-1']},
      {filterKind: 'population', filterValues: ['adult', 'pediatric']},
    ],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  })

  expect(sql).toContain("WHEN posting.filter_kind = 'importRoute'")
  expect(sql).toContain("WHEN posting.filter_kind = 'population'")
  expect(sql).toContain("posting.filter_value IN (SELECT unnest(['adult', 'pediatric']::VARCHAR[]))")
  expect(sql).toContain('matched_posting_rows AS')
  expect(sql).toContain('posting_anchor_rows AS')
  expect(sql).toContain('SUM(array_length(posting.article_ids)) OVER (')
  expect(sql).toContain('matched_group_article_id_count')
  expect(sql).toContain('FROM matched_posting_rows smaller_anchor_group')
  expect(sql).toContain('posting_anchor_group AS')
  expect(sql).toContain('posting_candidate_article_groups AS')
  expect(sql).toContain('CROSS JOIN posting_anchor_group anchor_group')
  expect(sql).toContain('CROSS JOIN UNNEST(candidate.article_ids) AS candidate_article(article_id)')
  expect(sql).toContain('CROSS JOIN UNNEST(anchor.article_ids) AS anchor_article(article_id)')
  expect(sql).toContain('candidate.article_id = anchor_article.article_id')
  expect(sql).toContain('FROM (VALUES (0), (1)) AS required_posting_group(required_group_index)')
  expect(sql).toContain('SELECT DISTINCT anchor_article.article_id')
  expect(sql).toContain('FROM posting_filtered_article_ids filtered_article_ids')
  expect(sql).toContain('posting.project_id = scoped.project_id')
  expect(sql).toContain('posting.review_config_hash = scoped.review_config_hash')
  expect(sql).toContain('posting.snapshot_id = scoped.snapshot_id')
  expect(sql).toContain('posting.list_mode_key = scoped.list_mode_key')
  expect(sql).not.toContain('mart.review_article_serving_base_v4')
  expect(sql).not.toContain('mart.review_article_serving_list_mode_state_v4')
  expect(sql).not.toContain('list_contains(list_mode_keys')
  expect(sql).not.toContain('list_contains(list_mode_state.list_mode_keys')
  expect(sql).not.toContain('CROSS JOIN UNNEST(posting.article_ids) AS posting_article(article_id)')
  expect(sql).not.toContain('list_contains(candidate.article_ids, anchor_article.article_id)')
  expect(sql).not.toContain('HAVING COUNT(DISTINCT CASE')
  expect(sql).not.toContain('ORDER BY array_length(anchor.article_ids)')
  expect(sql).not.toContain('JOIN posting_filtered_article_ids posting_filter_ids')
  expect(sql).not.toContain('scoped_serving AS')
})

test('dynamic filtered counts keep serving/state path when posting-only fast path gate is not met', () => {
  const baseInput = {
    listModeKey: 'llm',
    postingFilterGroups: [{filterKind: 'importRoute', filterValues: ['import-route-1']}],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  }
  const sqls = [
    getReviewServingDynamicFilteredCountSql({
      ...baseInput,
      postingFilterGroups: [
        {filterKind: 'importRoute', filterValues: ['import-route-1']},
        {filterKind: 'duplicateFlag', filterValues: ['true']},
      ],
    }),
    getReviewServingDynamicFilteredCountSql({
      ...baseInput,
      projectScopeIdentity: 'scope-1',
      searchIdentity: 'search-1',
      searchTokenPrefixes: ['heart'],
    }),
    getReviewServingDynamicFilteredCountSql({...baseInput, includeUnassessedQueue: true}),
    getReviewServingDynamicFilteredCountSql({
      ...baseInput,
      servingPredicates: ["AND serving.article_created_at >= TIMESTAMPTZ '2026-01-01'"],
    }),
    getReviewServingDynamicFilteredCountSql({...baseInput, requireLlmJudgment: true}),
  ]

  for (const sql of sqls) {
    expect(sql).toContain('scoped_serving AS')
    expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
    expect(sql).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
    expect(sql).toContain("WHEN 'llm' THEN list_mode_state.has_llm_list_mode")
    expect(sql).toContain("WHEN 'unassessed' THEN list_mode_state.has_unassessed_list_mode")
    expect(sql).not.toContain('list_contains(list_mode_state.list_mode_keys, scoped.list_mode_key)')
  }
})

test('dynamic filtered counts match legacy group-by semantics for multi-group posting intersections in DuckDB', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

  try {
    await connection.run(`
      CREATE SCHEMA mart;
      CREATE TABLE mart.review_article_filter_posting_serving_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        list_mode_key VARCHAR,
        filter_kind VARCHAR,
        filter_value VARCHAR,
        article_ids VARCHAR[]
      );
      CREATE TABLE mart.review_article_serving_base_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_id VARCHAR
      );
      CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_id VARCHAR,
        list_mode_keys VARCHAR[],
        has_llm_list_mode BOOLEAN DEFAULT TRUE,
        has_human_list_mode BOOLEAN DEFAULT FALSE,
        has_both_list_mode BOOLEAN DEFAULT FALSE,
        has_unassessed_list_mode BOOLEAN DEFAULT FALSE
      );
      INSERT INTO mart.review_article_filter_posting_serving_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'importRoute', 'import-route-1', ['article-1', 'article-2', 'article-3', 'article-4']),
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'population', 'adult', ['article-2', 'article-3']),
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'population', 'pediatric', ['article-3', 'article-4', 'article-5']),
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'promptAnswer', 'yes', ['article-3', 'article-4']),
        ('project-1', 'review-config-1', 'snapshot-1', 'human', 'importRoute', 'import-route-1', ['article-3']),
        ('project-1', 'review-config-1', 'snapshot-other', 'llm', 'importRoute', 'import-route-1', ['article-5']);
      INSERT INTO mart.review_article_serving_base_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'article-1'),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-2'),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-3'),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-4'),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-5');
      INSERT INTO mart.review_article_serving_list_mode_state_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        article_id,
        list_mode_keys
      ) VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'article-1', ['llm']),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-2', ['llm']),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-3', ['llm']),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-4', ['llm']),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-5', ['llm']);
    `)

    const optimizedReader = await connection.runAndReadAll(
      getReviewServingDynamicFilteredCountSql({
        listModeKey: 'llm',
        postingFilterGroups: [
          {filterKind: 'importRoute', filterValues: ['import-route-1']},
          {filterKind: 'population', filterValues: ['adult', 'adult', 'pediatric']},
          {filterKind: 'promptAnswer', filterValues: ['yes']},
        ],
        projectId: 'project-1',
        reviewConfigHash: 'review-config-1',
        snapshotId: 'snapshot-1',
      }),
    )
    const legacyReader = await connection.runAndReadAll(`
      WITH scoped AS (
        SELECT
          'project-1'::VARCHAR AS project_id,
          'review-config-1'::VARCHAR AS review_config_hash,
          'snapshot-1'::VARCHAR AS snapshot_id,
          'llm'::VARCHAR AS list_mode_key
      ),
      posting_filtered_article_ids AS (
        SELECT posting_article.article_id
        FROM (
          SELECT posting.article_ids, posting.filter_kind, posting.filter_value
          FROM mart.review_article_filter_posting_serving_v4 posting
          CROSS JOIN scoped
          WHERE posting.project_id = scoped.project_id
            AND posting.review_config_hash = scoped.review_config_hash
            AND posting.snapshot_id = scoped.snapshot_id
            AND posting.list_mode_key = scoped.list_mode_key
            AND (
              (posting.filter_kind = 'importRoute' AND posting.filter_value IN (SELECT unnest(['import-route-1']::VARCHAR[])))
              OR (posting.filter_kind = 'population' AND posting.filter_value IN (SELECT unnest(['adult', 'adult', 'pediatric']::VARCHAR[])))
              OR (posting.filter_kind = 'promptAnswer' AND posting.filter_value IN (SELECT unnest(['yes']::VARCHAR[])))
            )
        ) posting
        CROSS JOIN UNNEST(posting.article_ids) AS posting_article(article_id)
        GROUP BY posting_article.article_id
        HAVING COUNT(DISTINCT CASE
          WHEN posting.filter_kind = 'importRoute' AND posting.filter_value IN (SELECT unnest(['import-route-1']::VARCHAR[])) THEN 0
          WHEN posting.filter_kind = 'population' AND posting.filter_value IN (SELECT unnest(['adult', 'adult', 'pediatric']::VARCHAR[])) THEN 1
          WHEN posting.filter_kind = 'promptAnswer' AND posting.filter_value IN (SELECT unnest(['yes']::VARCHAR[])) THEN 2
        END) = 3
      )
      SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount
      FROM posting_filtered_article_ids filtered_article_ids
      CROSS JOIN scoped
      INNER JOIN mart.review_article_serving_base_v4 serving
        ON serving.project_id = scoped.project_id
       AND serving.review_config_hash = scoped.review_config_hash
       AND serving.snapshot_id = scoped.snapshot_id
       AND serving.article_id = filtered_article_ids.article_id
      INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state
        ON list_mode_state.project_id = serving.project_id
       AND list_mode_state.project_id = scoped.project_id
       AND list_mode_state.review_config_hash = serving.review_config_hash
       AND list_mode_state.review_config_hash = scoped.review_config_hash
       AND list_mode_state.snapshot_id = serving.snapshot_id
       AND list_mode_state.snapshot_id = scoped.snapshot_id
       AND list_mode_state.article_id = serving.article_id
       AND CASE scoped.list_mode_key
        WHEN 'llm' THEN list_mode_state.has_llm_list_mode
        WHEN 'human' THEN list_mode_state.has_human_list_mode
        WHEN 'both' THEN list_mode_state.has_both_list_mode
        WHEN 'unassessed' THEN list_mode_state.has_unassessed_list_mode
        ELSE FALSE
      END IS TRUE
    `)

    expect(optimizedReader.getRowObjectsJson()).toEqual(legacyReader.getRowObjectsJson())
    expect(optimizedReader.getRowObjectsJson()).toEqual([{totalCount: '2'}])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})

test('dynamic filtered counts execute canonical prompt-answer fallback with mixed posting groups in DuckDB', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

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
      CREATE TABLE app.project_prompt (
        project_id VARCHAR,
        prompt_id VARCHAR,
        enabled BOOLEAN,
        archived BOOLEAN,
        criteria_disposition VARCHAR
      );
      CREATE TABLE app.prompt (
        id VARCHAR,
        archived BOOLEAN
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
        created_at TIMESTAMP,
        deleted_at TIMESTAMP
      );
      CREATE TABLE app."judgment_human" (
        id VARCHAR,
        article_id VARCHAR,
        project_id VARCHAR,
        prompt_id VARCHAR,
        answer VARCHAR
      );
      CREATE TABLE app."judgment_human_summary" (
        id VARCHAR,
        article_id VARCHAR,
        project_id VARCHAR,
        answer VARCHAR
      );
      CREATE TABLE mart.review_article_filter_posting_serving_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        list_mode_key VARCHAR,
        filter_kind VARCHAR,
        filter_value VARCHAR,
        article_ids VARCHAR[]
      );
      CREATE TABLE mart.review_article_serving_base_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_id VARCHAR
      );
      CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_id VARCHAR,
        has_llm_list_mode BOOLEAN,
        has_human_list_mode BOOLEAN,
        has_both_list_mode BOOLEAN,
        has_unassessed_list_mode BOOLEAN
      );
      INSERT INTO app.project VALUES ('project-1', 'model-1', TRUE, TRUE, FALSE, FALSE, 'prompt');
      INSERT INTO app.project_prompt VALUES
        ('project-1', 'prompt-1', TRUE, FALSE, 'include'),
        ('project-1', 'prompt-2', TRUE, FALSE, 'include');
      INSERT INTO app.prompt VALUES ('prompt-1', FALSE), ('prompt-2', FALSE);
      INSERT INTO app."judgment" VALUES
        ('judgment-1', 'article-1', 'prompt-1', 'model-1', TRUE, TRUE, FALSE, FALSE, 'yes', NULL, TIMESTAMP '2026-01-01 00:00:00', NULL),
        ('judgment-2', 'article-2', 'prompt-1', 'model-1', TRUE, TRUE, FALSE, FALSE, 'yes', NULL, TIMESTAMP '2026-01-02 00:00:00', NULL),
        ('judgment-3', 'article-2', 'prompt-2', 'model-1', TRUE, TRUE, FALSE, FALSE, 'no', NULL, TIMESTAMP '2026-01-02 00:00:00', NULL),
        ('judgment-4', 'article-3', 'prompt-1', 'model-1', TRUE, TRUE, FALSE, FALSE, 'yes', NULL, TIMESTAMP '2026-01-03 00:00:00', NULL),
        ('judgment-5', 'article-3', 'prompt-2', 'model-1', TRUE, TRUE, FALSE, FALSE, 'no', NULL, TIMESTAMP '2026-01-03 00:00:00', NULL),
        ('judgment-6', 'article-4', 'prompt-1', 'model-1', TRUE, TRUE, FALSE, FALSE, 'yes', NULL, TIMESTAMP '2026-01-04 00:00:00', NULL),
        ('judgment-7', 'article-4', 'prompt-2', 'model-1', TRUE, TRUE, FALSE, FALSE, 'maybe', NULL, TIMESTAMP '2026-01-04 00:00:00', NULL);
      INSERT INTO mart.review_article_filter_posting_serving_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'importRoute', 'import-route-1', ['article-1', 'article-2', 'article-3']),
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'promptAnswer', 'review:promptAnswer:prompt-1:yes', ['article-1']),
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'promptAnswer', 'review:promptAnswer:prompt-2:no', ['article-1']);
      INSERT INTO mart.review_article_serving_base_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'article-1'),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-2'),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-3'),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-4');
      INSERT INTO mart.review_article_serving_list_mode_state_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'article-1', TRUE, FALSE, FALSE, FALSE),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-2', TRUE, FALSE, FALSE, FALSE),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-3', TRUE, FALSE, FALSE, FALSE),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-4', TRUE, FALSE, FALSE, FALSE);
    `)

    const reader = await connection.runAndReadAll(
      getReviewServingDynamicFilteredCountSql({
        listModeKey: 'llm',
        postingFilterGroups: [
          {filterKind: 'importRoute', filterValues: ['import-route-1']},
          {filterKind: 'promptAnswer', filterValues: ['review:promptAnswer:prompt-1:yes']},
          {filterKind: 'promptAnswer', filterValues: ['review:promptAnswer:prompt-2:no']},
        ],
        projectId: 'project-1',
        reviewConfigHash: 'review-config-1',
        snapshotId: 'snapshot-1',
        useCanonicalPromptAnswerPostings: true,
      }),
    )

    expect(reader.getRowObjectsJson()).toEqual([{totalCount: '2'}])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})

test('dynamic filtered counts match legacy semantics when anchor groups tie', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

  try {
    await connection.run(`
      CREATE SCHEMA mart;
      CREATE TABLE mart.review_article_filter_posting_serving_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        list_mode_key VARCHAR,
        filter_kind VARCHAR,
        filter_value VARCHAR,
        article_ids VARCHAR[]
      );
      CREATE TABLE mart.review_article_serving_base_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_id VARCHAR
      );
      CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_id VARCHAR,
        list_mode_keys VARCHAR[],
        has_llm_list_mode BOOLEAN DEFAULT TRUE,
        has_human_list_mode BOOLEAN DEFAULT FALSE,
        has_both_list_mode BOOLEAN DEFAULT FALSE,
        has_unassessed_list_mode BOOLEAN DEFAULT FALSE
      );
      INSERT INTO mart.review_article_filter_posting_serving_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'importRoute', 'import-route-1', ['article-1', 'article-2']),
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'population', 'adult', ['article-2', 'article-3']);
      INSERT INTO mart.review_article_serving_base_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'article-1'),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-2'),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-3');
      INSERT INTO mart.review_article_serving_list_mode_state_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        article_id,
        list_mode_keys
      ) VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'article-1', ['llm']),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-2', ['llm']),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-3', ['llm']);
    `)

    const optimizedReader = await connection.runAndReadAll(
      getReviewServingDynamicFilteredCountSql({
        listModeKey: 'llm',
        postingFilterGroups: [
          {filterKind: 'importRoute', filterValues: ['import-route-1']},
          {filterKind: 'population', filterValues: ['adult']},
        ],
        projectId: 'project-1',
        reviewConfigHash: 'review-config-1',
        snapshotId: 'snapshot-1',
      }),
    )
    const legacyReader = await connection.runAndReadAll(`
      WITH scoped AS (
        SELECT
          'project-1'::VARCHAR AS project_id,
          'review-config-1'::VARCHAR AS review_config_hash,
          'snapshot-1'::VARCHAR AS snapshot_id,
          'llm'::VARCHAR AS list_mode_key
      ),
      posting_filtered_article_ids AS (
        SELECT posting_article.article_id
        FROM (
          SELECT posting.article_ids, posting.filter_kind, posting.filter_value
          FROM mart.review_article_filter_posting_serving_v4 posting
          CROSS JOIN scoped
          WHERE posting.project_id = scoped.project_id
            AND posting.review_config_hash = scoped.review_config_hash
            AND posting.snapshot_id = scoped.snapshot_id
            AND posting.list_mode_key = scoped.list_mode_key
            AND (
              (posting.filter_kind = 'importRoute' AND posting.filter_value IN (SELECT unnest(['import-route-1']::VARCHAR[])))
              OR (posting.filter_kind = 'population' AND posting.filter_value IN (SELECT unnest(['adult']::VARCHAR[])))
            )
        ) posting
        CROSS JOIN UNNEST(posting.article_ids) AS posting_article(article_id)
        GROUP BY posting_article.article_id
        HAVING COUNT(DISTINCT CASE
          WHEN posting.filter_kind = 'importRoute' AND posting.filter_value IN (SELECT unnest(['import-route-1']::VARCHAR[])) THEN 0
          WHEN posting.filter_kind = 'population' AND posting.filter_value IN (SELECT unnest(['adult']::VARCHAR[])) THEN 1
        END) = 2
      )
      SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount
      FROM posting_filtered_article_ids filtered_article_ids
      CROSS JOIN scoped
      INNER JOIN mart.review_article_serving_base_v4 serving
        ON serving.project_id = scoped.project_id
       AND serving.review_config_hash = scoped.review_config_hash
       AND serving.snapshot_id = scoped.snapshot_id
       AND serving.article_id = filtered_article_ids.article_id
      INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state
        ON list_mode_state.project_id = serving.project_id
       AND list_mode_state.project_id = scoped.project_id
       AND list_mode_state.review_config_hash = serving.review_config_hash
       AND list_mode_state.review_config_hash = scoped.review_config_hash
       AND list_mode_state.snapshot_id = serving.snapshot_id
       AND list_mode_state.snapshot_id = scoped.snapshot_id
       AND list_mode_state.article_id = serving.article_id
       AND CASE scoped.list_mode_key
        WHEN 'llm' THEN list_mode_state.has_llm_list_mode
        WHEN 'human' THEN list_mode_state.has_human_list_mode
        WHEN 'both' THEN list_mode_state.has_both_list_mode
        WHEN 'unassessed' THEN list_mode_state.has_unassessed_list_mode
        ELSE FALSE
      END IS TRUE
    `)

    expect(optimizedReader.getRowObjectsJson()).toEqual(legacyReader.getRowObjectsJson())
    expect(optimizedReader.getRowObjectsJson()).toEqual([{totalCount: '1'}])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})

test('dynamic filtered counts read fixed list modes from base and list-mode state directly', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    postingFilterGroups: [
      {filterKind: 'duplicateFlag', filterValues: ['true']},
      {filterKind: 'llmStatus', filterValues: ['answered']},
      {filterKind: 'importRoute', filterValues: ['import-route-1']},
    ],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    servingPredicates: ["AND serving.article_created_at >= TIMESTAMPTZ '2026-01-01'"],
    snapshotId: 'snapshot-1',
  })

  expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(sql).toContain("WHEN 'both' THEN list_mode_state.has_both_list_mode")
  expect(sql).not.toContain('list_contains(list_mode_state.list_mode_keys, scoped.list_mode_key)')
  expect(sql).toContain('list_mode_state.duplicate_flag IS TRUE')
  expect(sql).toContain("list_mode_state.llm_status IN (SELECT unnest(['answered']::VARCHAR[]))")
  expect(sql).toContain('FROM mart.review_article_filter_posting_serving_v4 posting')
  expect(sql).toContain('AND posting.list_mode_key = scoped.list_mode_key')
  expect(sql.indexOf('AND posting.list_mode_key = scoped.list_mode_key')).toBeLessThan(
    sql.indexOf('CROSS JOIN UNNEST(posting.article_ids) AS posting_article(article_id)'),
  )
  expect(sql).not.toContain('FROM mart.review_article_serving_v4 serving')
  expect(sql).not.toContain('FROM mart.review_article_serving_v4 state')
  expect(sql).not.toContain('state_filtered_article_ids')
})

test('dynamic filtered counts use base-scoped fast path for list-mode-state filters', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'both',
    postingFilterGroups: [
      {filterKind: 'duplicateFlag', filterValues: ['true']},
      {filterKind: 'conflictFlag', filterValues: ['true']},
      {filterKind: 'llmStatus', filterValues: ['answered']},
      {filterKind: 'humanStatus', filterValues: ['included']},
      {filterKind: 'llmHasJudgment', filterValues: ['true']},
    ],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  })

  expect(sql).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('list_mode_state.article_id = serving.article_id')
  expect(sql).toContain('list_mode_state.project_id = scoped.project_id')
  expect(sql).toContain('list_mode_state.review_config_hash = scoped.review_config_hash')
  expect(sql).toContain('list_mode_state.snapshot_id = scoped.snapshot_id')
  expect(sql).toContain("WHEN 'both' THEN list_mode_state.has_both_list_mode")
  expect(sql).not.toContain('list_contains(list_mode_state.list_mode_keys, scoped.list_mode_key)')
  expect(sql).toContain('list_mode_state.duplicate_flag IS TRUE')
  expect(sql).toContain('list_mode_state.conflict_flag IS TRUE')
  expect(sql).toContain("list_mode_state.llm_status IN (SELECT unnest(['answered']::VARCHAR[]))")
  expect(sql).toContain("list_mode_state.human_status IN (SELECT unnest(['included']::VARCHAR[]))")
  expect(sql).toContain('list_mode_state.llm_has_judgment IS TRUE')
  expect(sql).toContain('SELECT COUNT(DISTINCT serving.article_id) AS totalCount')
  expect(sql).not.toContain('scoped_serving AS')
  expect(sql).not.toContain('review_article_filter_posting_serving_v4')
})

test('dynamic state-only counts ignore orphan list-mode-state rows without base rows', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

  try {
    await connection.run(`
      CREATE SCHEMA mart;
      CREATE TABLE mart.review_article_serving_base_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_id VARCHAR
      );
      CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_id VARCHAR,
        has_llm_list_mode BOOLEAN DEFAULT FALSE,
        has_human_list_mode BOOLEAN DEFAULT FALSE,
        has_both_list_mode BOOLEAN DEFAULT FALSE,
        has_unassessed_list_mode BOOLEAN DEFAULT FALSE,
        duplicate_flag BOOLEAN DEFAULT FALSE,
        conflict_flag BOOLEAN DEFAULT FALSE,
        llm_status VARCHAR,
        human_status VARCHAR,
        llm_has_judgment BOOLEAN DEFAULT FALSE
      );
      INSERT INTO mart.review_article_serving_base_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'article-real');
      INSERT INTO mart.review_article_serving_list_mode_state_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'article-real', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 'answered', 'answered', TRUE),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-orphan', FALSE, TRUE, TRUE, FALSE, FALSE, FALSE, 'answered', 'answered', TRUE);
    `)

    const humanReader = await connection.runAndReadAll(
      getReviewServingDynamicFilteredCountSql({
        listModeKey: 'human',
        postingFilterGroups: [{filterKind: 'humanStatus', filterValues: ['answered']}],
        projectId: 'project-1',
        reviewConfigHash: 'review-config-1',
        snapshotId: 'snapshot-1',
      }),
    )
    const bothReader = await connection.runAndReadAll(
      getReviewServingDynamicFilteredCountSql({
        listModeKey: 'both',
        postingFilterGroups: [
          {filterKind: 'llmStatus', filterValues: ['answered']},
          {filterKind: 'humanStatus', filterValues: ['answered']},
        ],
        projectId: 'project-1',
        reviewConfigHash: 'review-config-1',
        snapshotId: 'snapshot-1',
      }),
    )

    expect(humanReader.getRowObjectsJson()).toEqual([{totalCount: '1'}])
    expect(bothReader.getRowObjectsJson()).toEqual([{totalCount: '1'}])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})

test('dynamic filtered counts keep authoritative scoped path when state filters mix with article predicates', () => {
  const dateSql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    postingFilterGroups: [{filterKind: 'duplicateFlag', filterValues: ['true']}],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    servingPredicates: ["AND serving.article_created_at >= TIMESTAMPTZ '2026-01-01'"],
    snapshotId: 'snapshot-1',
  })
  const postingSql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    postingFilterGroups: [
      {filterKind: 'duplicateFlag', filterValues: ['true']},
      {filterKind: 'importRoute', filterValues: ['import-route-1']},
    ],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  })
  const searchSql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    postingFilterGroups: [{filterKind: 'duplicateFlag', filterValues: ['true']}],
    projectId: 'project-1',
    projectScopeIdentity: 'scope-1',
    reviewConfigHash: 'review-config-1',
    searchIdentity: 'search-1',
    searchTokenPrefixes: ['heart'],
    snapshotId: 'snapshot-1',
  })
  const queueSql = getReviewServingDynamicFilteredCountSql({
    includeUnassessedQueue: true,
    listModeKey: 'unassessed',
    postingFilterGroups: [{filterKind: 'duplicateFlag', filterValues: ['true']}],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  })

  for (const sql of [dateSql, postingSql, searchSql, queueSql]) {
    expect(sql).toContain('scoped_serving AS')
    expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
    expect(sql).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  }
})

test('dynamic filtered counts prefilter search rows before expanding matching articles', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    projectId: 'project-1',
    projectScopeIdentity: 'scope-1',
    reviewConfigHash: 'review-config-1',
    searchIdentity: 'search-1',
    searchTokenPrefixes: ['heart', 'failure'],
    snapshotId: 'snapshot-1',
  })

  expect(sql).toContain('search_filtered_article_ids AS')
  expect(sql).toContain("JOIN (SELECT unnest(['heart', 'failure']::VARCHAR[]) AS token_prefix) search_prefix")
  expect(sql).toContain('ON starts_with(search.token, search_prefix.token_prefix)')
  expect(sql.indexOf('ON starts_with(search.token, search_prefix.token_prefix)')).toBeLessThan(
    sql.indexOf('CROSS JOIN unnest(search.article_ids) AS search_article(article_id)'),
  )
  expect(sql).toContain('HAVING COUNT(DISTINCT search_prefix.token_prefix) = 2')
  expect(sql).toContain(
    'JOIN search_filtered_article_ids search_filter_ids ON search_filter_ids.article_id = filtered_article_ids.article_id',
  )
})

test('dynamic filtered counts restrict broad token-prefix search to selective posting candidates', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    postingFilterGroups: [{filterKind: 'importRoute', filterValues: ['import-route-1']}],
    projectId: 'project-1',
    projectScopeIdentity: 'scope-1',
    reviewConfigHash: 'review-config-1',
    searchIdentity: 'search-1',
    searchTokenPrefixes: ['heart', 'failure'],
    snapshotId: 'snapshot-1',
  })

  expect(sql).toContain('posting_filtered_article_ids AS')
  expect(sql).toContain('search_candidate_article_ids AS')
  expect(sql).toContain(
    'JOIN posting_filtered_article_ids posting_filter_ids ON posting_filter_ids.article_id = candidate.article_id',
  )
  expect(sql.indexOf('search_candidate_article_ids AS')).toBeLessThan(sql.indexOf('search_filtered_article_ids AS'))
  expect(sql).toContain('expanded_search_article_ids AS')
  expect(sql).toContain(
    'FROM search_candidate_article_ids search_candidate_article\n  JOIN mart.review_title_search_serving_v4 search\n    ON list_contains(search.article_ids, search_candidate_article.article_id)',
  )
  expect(sql).not.toContain('CROSS JOIN unnest(search.article_ids) AS search_article(article_id)')
  expect(sql).toContain('GROUP BY expanded_search_article_ids.article_id')
  expect(sql).not.toContain('GROUP BY search_article.article_id')
  expect(sql).toContain('HAVING COUNT(DISTINCT expanded_search_article_ids.token_prefix) = 2')
})

test('dynamic filtered counts restrict broad token-prefix search to unassessed queue candidates', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    includeUnassessedQueue: true,
    listModeKey: 'unassessed',
    projectId: 'project-1',
    projectScopeIdentity: 'scope-1',
    reviewConfigHash: 'review-config-1',
    searchIdentity: 'search-1',
    searchTokenPrefixes: ['heart', 'failure'],
    snapshotId: 'snapshot-1',
  })

  expect(sql).toContain('search_candidate_article_ids AS')
  expect(sql).toContain('JOIN unassessed_queue_article_ids queue_filter_ids')
  expect(sql).toContain('expanded_search_article_ids AS')
  expect(sql).toContain(
    'FROM search_candidate_article_ids search_candidate_article\n  JOIN mart.review_title_search_serving_v4 search\n    ON list_contains(search.article_ids, search_candidate_article.article_id)',
  )
  expect(sql).not.toContain('CROSS JOIN unnest(search.article_ids) AS search_article(article_id)')
  expect(sql).toContain('GROUP BY expanded_search_article_ids.article_id')
  expect(sql).not.toContain('GROUP BY search_article.article_id')
})

test('dynamic filtered counts preserve all-prefix candidate search semantics without expanding broad title rows', async () => {
  const duckdbInstance = await DuckDBInstance.create(':memory:')
  const connection = await duckdbInstance.connect()

  try {
    await connection.run(`
      CREATE SCHEMA mart;
      CREATE TABLE mart.review_article_filter_posting_serving_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        list_mode_key VARCHAR,
        filter_kind VARCHAR,
        filter_value VARCHAR,
        article_ids VARCHAR[]
      );
      CREATE TABLE mart.review_article_serving_base_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_id VARCHAR
      );
      CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
        project_id VARCHAR,
        review_config_hash VARCHAR,
        snapshot_id VARCHAR,
        article_id VARCHAR,
        list_mode_keys VARCHAR[],
        has_llm_list_mode BOOLEAN DEFAULT TRUE,
        has_human_list_mode BOOLEAN DEFAULT FALSE,
        has_both_list_mode BOOLEAN DEFAULT FALSE,
        has_unassessed_list_mode BOOLEAN DEFAULT FALSE
      );
      CREATE TABLE mart.review_title_search_serving_v4 (
        project_id VARCHAR,
        search_identity VARCHAR,
        project_scope_identity VARCHAR,
        snapshot_id VARCHAR,
        token VARCHAR,
        article_ids VARCHAR[]
      );
      INSERT INTO mart.review_article_filter_posting_serving_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'llm', 'importRoute', 'import-route-1', ['article-2', 'article-4']);
      INSERT INTO mart.review_article_serving_base_v4 VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'article-1'),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-2'),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-3'),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-4');
      INSERT INTO mart.review_article_serving_list_mode_state_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        article_id,
        list_mode_keys
      ) VALUES
        ('project-1', 'review-config-1', 'snapshot-1', 'article-1', ['llm']),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-2', ['llm']),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-3', ['llm']),
        ('project-1', 'review-config-1', 'snapshot-1', 'article-4', ['llm']);
      INSERT INTO mart.review_title_search_serving_v4 VALUES
        ('project-1', 'search-1', 'scope-1', 'snapshot-1', 'heart', ['article-1', 'article-2', 'article-3', 'article-4']),
        ('project-1', 'search-1', 'scope-1', 'snapshot-1', 'healthy', ['article-4']),
        ('project-1', 'search-1', 'scope-1', 'snapshot-1', 'failure', ['article-2']),
        ('project-1', 'search-1', 'scope-1', 'snapshot-1', 'fall', ['article-3', 'article-4']);
    `)

    const sql = getReviewServingDynamicFilteredCountSql({
      listModeKey: 'llm',
      postingFilterGroups: [{filterKind: 'importRoute', filterValues: ['import-route-1']}],
      projectId: 'project-1',
      projectScopeIdentity: 'scope-1',
      reviewConfigHash: 'review-config-1',
      searchIdentity: 'search-1',
      searchTokenPrefixes: ['he', 'fa'],
      snapshotId: 'snapshot-1',
    })
    const reader = await connection.runAndReadAll(sql)

    expect(sql).toContain('ON list_contains(search.article_ids, search_candidate_article.article_id)')
    expect(sql).not.toContain('CROSS JOIN unnest(search.article_ids) AS search_article(article_id)')
    expect(reader.getRowObjectsJson()).toEqual([{totalCount: '2'}])
  } finally {
    connection.closeSync()
    duckdbInstance.closeSync()
  }
})

test('dynamic filtered counts normalize duplicate and blank search prefixes', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    projectId: 'project-1',
    projectScopeIdentity: 'scope-1',
    reviewConfigHash: 'review-config-1',
    searchIdentity: 'search-1',
    searchTokenPrefixes: ['heart', '', 'heart', 'failure'],
    snapshotId: 'snapshot-1',
  })

  expect(sql).toContain("JOIN (SELECT unnest(['heart', 'failure']::VARCHAR[]) AS token_prefix) search_prefix")
  expect(sql).toContain('HAVING COUNT(DISTINCT search_prefix.token_prefix) = 2')
  expect(sql).not.toContain("['heart', '', 'heart', 'failure']")
  expect(sql).not.toContain('= 4')
})

test('dynamic filtered counts ignore empty search prefix sets', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    projectId: 'project-1',
    projectScopeIdentity: 'scope-1',
    reviewConfigHash: 'review-config-1',
    searchIdentity: 'search-1',
    searchTokenPrefixes: ['', ''],
    snapshotId: 'snapshot-1',
  })

  expect(sql).not.toContain('search_filtered_article_ids AS')
  expect(sql).not.toContain('JOIN search_filtered_article_ids search_filter_ids')
})

test('dynamic filtered counts read unassessed membership from base and list-mode state directly', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    includeUnassessedQueue: true,
    listModeKey: 'unassessed',
    postingFilterGroups: [{filterKind: 'duplicateFlag', filterValues: ['true']}],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  })

  expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(sql).toContain("WHEN 'unassessed' THEN list_mode_state.has_unassessed_list_mode")
  expect(sql).not.toContain('list_contains(list_mode_state.list_mode_keys, scoped.list_mode_key)')
  expect(sql).toContain('FROM mart.review_unassessed_queue_article_rank_serving_v4 queue')
  expect(sql).not.toContain('FROM mart.review_article_serving_v4 serving')
  expect(sql).not.toContain('state_filtered_article_ids')
})

test('dynamic filtered counts require LLM judgment through list-mode state', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    projectId: 'project-1',
    requireLlmJudgment: true,
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  })

  expect(sql).toContain('list_mode_state.llm_has_judgment IS TRUE')
  expect(sql).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(sql).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(sql).toContain('list_mode_state.article_id = serving.article_id')
  expect(sql).not.toContain('llm_judged_article_ids AS')
  expect(sql).not.toContain('JOIN llm_judged_article_ids')
  expect(sql).not.toContain('mart.review_article_judgment_detail_serving_v4')
})

test('dynamic filtered counts treat LLM judgment filter groups as list-mode state', () => {
  const sql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    postingFilterGroups: [
      {filterKind: 'llmHasJudgment', filterValues: ['true']},
      {filterKind: 'importRoute', filterValues: ['import-route-1']},
    ],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  })

  expect(sql).toContain('list_mode_state.llm_has_judgment IS TRUE')
  expect(sql).toContain('FROM mart.review_article_filter_posting_serving_v4 posting')
  expect(sql).toContain("posting.filter_kind = 'importRoute'")
  expect(sql).not.toContain("posting.filter_kind = 'llmHasJudgment'")
})

test('dynamic filtered counts support false LLM judgment filter groups', () => {
  const falseSql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    postingFilterGroups: [{filterKind: 'llmHasJudgment', filterValues: ['false']}],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  })
  const bothSql = getReviewServingDynamicFilteredCountSql({
    listModeKey: 'llm',
    postingFilterGroups: [{filterKind: 'llmHasJudgment', filterValues: ['true', 'false']}],
    projectId: 'project-1',
    reviewConfigHash: 'review-config-1',
    snapshotId: 'snapshot-1',
  })

  expect(falseSql).toContain('list_mode_state.llm_has_judgment IS NOT TRUE')
  expect(falseSql).not.toContain("posting.filter_kind = 'llmHasJudgment'")
  expect(bothSql).not.toContain('list_mode_state.llm_has_judgment')
  expect(bothSql).not.toContain("posting.filter_kind = 'llmHasJudgment'")
})
