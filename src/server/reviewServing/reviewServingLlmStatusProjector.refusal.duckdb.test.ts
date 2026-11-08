import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {DuckDBInstance} from '@duckdb/node-api'
import {afterEach, beforeEach, expect, test} from 'bun:test'

import {decodeReviewServingJsonRows} from '../test/decodeReviewServingJsonRows.ts'
import {duckdbEngineCompatibilityOptions} from '../utils/duckdbEngineContract.ts'
import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  projectReviewServingLlmStatusPatches,
  projectReviewServingLlmStatusRanges,
  type ReviewServingLlmStatusProjectorDatabase,
} from './reviewServingLlmStatusProjector.ts'

type DuckdbConnection = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>

type ListModeStateRow = {
  article_id: string
  llm_has_judgment: boolean
  llm_refused_prompt_count: number
  llm_status: string | null
}

const judgmentRefusalTableSql = readFileSync(
  resolve(import.meta.dir, '../../db/duckdbMigrations/0275_judgmentRefusal.sql'),
  'utf8',
)
const judgmentPromptFailureTableSql = readFileSync(
  resolve(import.meta.dir, '../../db/duckdbMigrations/0278_judgmentPromptFailure.sql'),
  'utf8',
)
const projectId = 'project-1'
const projectionIdentity = 'llmStatus:identity-1'
const snapshotId = 'snapshot-1'
const componentStateJson = JSON.stringify({
  optional: [],
  required: [{baseGeneration: '5', component: 'llmStatus', projectionIdentity}],
})

const schemaSql = `
  CREATE SCHEMA app;
  CREATE SCHEMA mart;
  CREATE TABLE app.project (
    id VARCHAR,
    model_id VARCHAR,
    use_title BOOLEAN,
    use_abstract BOOLEAN,
    use_fulltext BOOLEAN,
    use_fulltext_no_images BOOLEAN,
    use_metadata BOOLEAN,
    system_prompt_variant VARCHAR,
    full_text_strategy_id VARCHAR,
    human_judgment_mode VARCHAR
  );
  CREATE TABLE app.model (
    id VARCHAR,
    provider_connection_id VARCHAR,
    remote_model_id VARCHAR,
    variant VARCHAR,
    metadata_json JSON
  );
  CREATE TABLE app.provider_connection (id VARCHAR, provider_kind VARCHAR, base_url VARCHAR);
  CREATE TABLE app.prompt (id VARCHAR, archived BOOLEAN, content_hash VARCHAR, original_text VARCHAR);
  CREATE TABLE app.project_prompt (
    id VARCHAR,
    project_id VARCHAR,
    prompt_id VARCHAR,
    enabled BOOLEAN,
    archived BOOLEAN,
    prompt_order INTEGER
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
    use_metadata BOOLEAN,
    system_prompt_variant VARCHAR,
    full_text_strategy_id VARCHAR,
    is_answered BOOLEAN,
    answered_original VARCHAR,
    answered_original_as_array VARCHAR[],
    created_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ
  );
  CREATE TABLE app.review_change_delta (
    delta_id VARCHAR,
    project_id VARCHAR,
    article_id VARCHAR,
    prompt_id VARCHAR,
    model_id VARCHAR,
    use_title BOOLEAN,
    use_abstract BOOLEAN,
    use_fulltext BOOLEAN,
    use_fulltext_no_images BOOLEAN,
    use_metadata BOOLEAN,
    system_prompt_variant VARCHAR,
    full_text_strategy_id VARCHAR,
    change_kind VARCHAR,
    source_operation VARCHAR,
    source_partition VARCHAR,
    source_high_water_mark BIGINT
  );
  CREATE TABLE app.review_serving_snapshot_manifest (
    project_id VARCHAR,
    snapshot_id VARCHAR,
    review_config_hash VARCHAR,
    snapshot_status VARCHAR,
    component_state_json JSON
  );
  CREATE TABLE mart.project_scope_article (
    project_id VARCHAR,
    article_id VARCHAR,
    in_curated_scope BOOLEAN,
    in_route_scope BOOLEAN
  );
  CREATE TABLE mart.review_article_serving_base_v4 (
    project_id VARCHAR,
    review_config_hash VARCHAR,
    snapshot_id VARCHAR,
    base_generation BIGINT,
    article_id VARCHAR
  );
  CREATE TABLE mart.review_article_serving_list_mode_state_v4 (
    project_id VARCHAR NOT NULL,
    review_config_hash VARCHAR NOT NULL,
    snapshot_id VARCHAR NOT NULL,
    article_id VARCHAR NOT NULL,
    has_llm_list_mode BOOLEAN NOT NULL DEFAULT FALSE,
    has_human_list_mode BOOLEAN NOT NULL DEFAULT FALSE,
    has_both_list_mode BOOLEAN NOT NULL DEFAULT FALSE,
    has_unassessed_list_mode BOOLEAN NOT NULL DEFAULT FALSE,
    llm_patch_watermark BIGINT,
    human_patch_watermark BIGINT,
    both_patch_watermark BIGINT,
    unassessed_patch_watermark BIGINT,
    duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
    conflict_flag BOOLEAN NOT NULL DEFAULT FALSE,
    llm_status VARCHAR,
    human_status VARCHAR,
    llm_has_judgment BOOLEAN NOT NULL DEFAULT FALSE,
    llm_refused_prompt_count INTEGER NOT NULL DEFAULT 0,
    llm_failed_prompt_count INTEGER NOT NULL DEFAULT 0,
    llm_failed_prompt_codes VARCHAR
  );
  ${judgmentRefusalTableSql}
  ${judgmentPromptFailureTableSql}
`

const getJudgmentSql = (input: {answered: boolean; articleId: string; promptId: string}) => {
  return `('judgment-${input.articleId}-${input.promptId}', '${input.articleId}', '${input.promptId}', 'model-1',
    TRUE, TRUE, FALSE, FALSE, FALSE, 'screening_v5', 'fts-none', ${input.answered},
    ${input.answered ? "'yes'" : 'NULL'}, ${input.answered ? "['yes']" : 'NULL'}, TIMESTAMPTZ '2026-11-01 10:00:00Z', NULL)`
}

const getRefusalSql = (input: {
  articleId: string
  modelId?: string
  promptId: string
  systemPromptVariant?: string
}) => {
  const modelId = input.modelId ?? 'model-1'
  const systemPromptVariant = input.systemPromptVariant ?? 'screening_v5'

  return `('${input.articleId}', '${input.promptId}', '${modelId}', TRUE, TRUE, FALSE, FALSE, FALSE,
    '${systemPromptVariant}', 'fts-none', '${projectId}', 'job-1',
    'queue-${input.articleId}-${input.promptId}-${modelId}-${systemPromptVariant}', 'content_refusal', 'claude-code',
    'claude-opus', 'safeguards flagged this message', TIMESTAMPTZ '2026-11-01 11:00:00Z', TIMESTAMPTZ '2026-11-01 11:00:00Z')`
}

const getDeltaSql = (input: {articleId: string; highWaterMark: number; modelId?: string; promptId: string}) => {
  return `('delta-${input.highWaterMark}', '${projectId}', '${input.articleId}', '${input.promptId}',
    '${input.modelId ?? 'model-1'}', TRUE, TRUE, FALSE, FALSE, FALSE, 'screening_v5', 'fts-none',
    'judgment.llm.updated', 'insert', 'llmJudgment:${input.articleId}', ${input.highWaterMark})`
}

const dataSql = `
  INSERT INTO app.project VALUES
    ('${projectId}', 'model-1', TRUE, TRUE, FALSE, FALSE, FALSE, 'screening_v5', NULL, 'prompt');
  INSERT INTO app.model VALUES ('model-1', NULL, 'claude-opus', NULL, '{}');
  INSERT INTO app.prompt VALUES
    ('prompt-1', FALSE, 'hash-1', 'Prompt 1'),
    ('prompt-2', FALSE, 'hash-2', 'Prompt 2'),
    ('prompt-3', FALSE, 'hash-3', 'Prompt 3'),
    ('prompt-4', FALSE, 'hash-4', 'Prompt 4');
  INSERT INTO app.project_prompt VALUES
    ('project-prompt-1', '${projectId}', 'prompt-1', TRUE, FALSE, 1),
    ('project-prompt-2', '${projectId}', 'prompt-2', TRUE, FALSE, 2),
    ('project-prompt-3', '${projectId}', 'prompt-3', TRUE, FALSE, 3),
    ('project-prompt-4', '${projectId}', 'prompt-4', TRUE, FALSE, 4);
  INSERT INTO mart.project_scope_article VALUES
    ('${projectId}', 'article-1', TRUE, FALSE),
    ('${projectId}', 'article-2', TRUE, FALSE),
    ('${projectId}', 'article-3', TRUE, FALSE);
  INSERT INTO app."judgment" VALUES
    ${[
      getJudgmentSql({answered: true, articleId: 'article-1', promptId: 'prompt-1'}),
      getJudgmentSql({answered: true, articleId: 'article-1', promptId: 'prompt-3'}),
      getJudgmentSql({answered: true, articleId: 'article-3', promptId: 'prompt-1'}),
      getJudgmentSql({answered: true, articleId: 'article-3', promptId: 'prompt-2'}),
      getJudgmentSql({answered: true, articleId: 'article-3', promptId: 'prompt-3'}),
      getJudgmentSql({answered: true, articleId: 'article-3', promptId: 'prompt-4'}),
    ].join(', ')};
  INSERT INTO app.judgment_refusal VALUES
    ${[
      getRefusalSql({articleId: 'article-1', promptId: 'prompt-2'}),
      getRefusalSql({articleId: 'article-1', promptId: 'prompt-3'}),
      getRefusalSql({articleId: 'article-1', modelId: 'model-other', promptId: 'prompt-4'}),
      getRefusalSql({articleId: 'article-1', promptId: 'prompt-4', systemPromptVariant: 'legacy'}),
      getRefusalSql({articleId: 'article-2', promptId: 'prompt-1'}),
      getRefusalSql({articleId: 'article-2', promptId: 'prompt-2'}),
      getRefusalSql({articleId: 'article-2', promptId: 'prompt-3'}),
      getRefusalSql({articleId: 'article-2', promptId: 'prompt-4'}),
    ].join(', ')};
  INSERT INTO app.review_change_delta VALUES
    ${[
      getDeltaSql({articleId: 'article-1', highWaterMark: 11, promptId: 'prompt-2'}),
      getDeltaSql({articleId: 'article-1', highWaterMark: 12, modelId: 'model-other', promptId: 'prompt-4'}),
      getDeltaSql({articleId: 'article-2', highWaterMark: 13, promptId: 'prompt-1'}),
    ].join(', ')};
`

let duckdbInstance: DuckDBInstance | null = null
let connection: DuckdbConnection | null = null

const getConnection = () => {
  if (connection === null) {
    throw new Error('DuckDB connection not initialized')
  }

  return connection
}

const queryRows = async <T>(statement: string) => {
  return (await getConnection().runAndReadAll(statement)).getRowObjectsJson() as T[]
}

const isLlmStatusSourceStatement = (statement: string) => {
  return (
    statement.includes('FROM app.review_change_delta delta')
    || statement.includes('FROM prompt_id_filter dirty_prompt')
    || statement.includes('scoped_article AS')
    || statement.includes('FROM article_id_filter dirty')
    || (statement.includes('FROM app.project_prompt project_prompt') && statement.includes('AS promptOrder'))
  )
}

const createSourceOnlyDatabase = () => {
  const statements: string[] = []
  const database: ReviewServingLlmStatusProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      return isLlmStatusSourceStatement(statement) ? queryRows<T>(statement) : ([] as T[])
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return {database, statements}
}

const createDuckdbDatabase = () => {
  const database: ReviewServingLlmStatusProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      return queryRows<T>(statement)
    },
    run: async (statement: string) => {
      await getConnection().run(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return database
}

const insertServingRows = async (reviewConfigHash: string, articleIds: readonly string[]) => {
  await getConnection().run(`
    INSERT INTO app.review_serving_snapshot_manifest VALUES
      ('${projectId}', '${snapshotId}', '${reviewConfigHash}', 'active', '${componentStateJson}'::JSON);
    INSERT INTO mart.review_article_serving_base_v4 VALUES
      ${articleIds
        .map((articleId) => {
          return `('${projectId}', '${reviewConfigHash}', '${snapshotId}', 5, '${articleId}')`
        })
        .join(', ')};
    INSERT INTO mart.review_article_serving_list_mode_state_v4 (
      project_id, review_config_hash, snapshot_id, article_id, has_llm_list_mode
    ) VALUES
      ${articleIds
        .map((articleId) => {
          return `('${projectId}', '${reviewConfigHash}', '${snapshotId}', '${articleId}', TRUE)`
        })
        .join(', ')};
  `)
}

const getListModeStateRows = async (reviewConfigHash: string) => {
  return queryRows<ListModeStateRow>(`
    SELECT article_id, llm_status, llm_has_judgment, llm_refused_prompt_count
    FROM mart.review_article_serving_list_mode_state_v4
    WHERE project_id = '${projectId}'
      AND review_config_hash = '${reviewConfigHash}'
    ORDER BY article_id
  `)
}

const llmClaim = (input: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'judgment.llm.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-1',
    firstSourceHighWaterMark: 11,
    latestDeltaId: 'delta-12',
    latestSourceHighWaterMark: 13,
    projectId,
    projectionComponent: 'llmStatus',
    projectionIdentity,
    scopeId: `${projectId}:article-1`,
    scopeKind: 'article',
    sourcePartition: 'llmJudgment:article-1',
    status: 'running',
    ...input,
  }
}

const projectInput = (claims: readonly ReviewServingDirtyWorkClaim[]) => {
  return {
    baseGeneration: 5,
    claims,
    definitionVersion: 'llm-status-refusal-test',
    listModeKeys: ['llm'],
    projectId,
    projectionIdentity,
  }
}

const getStatusKeysByArticlePrompt = (statement: string) => {
  return decodeReviewServingJsonRows(statement).reduce<Record<string, Record<string, unknown>>>((acc, row) => {
    const articleId = String(row.article_id)
    const reviewConfigHash = String(row.review_config_hash)

    return {
      ...acc,
      [`${reviewConfigHash}|${articleId}`]: {
        ...acc[`${reviewConfigHash}|${articleId}`],
        [String(row.prompt_id)]: row.llm_status_key,
      },
    }
  }, {})
}

const getProjectReviewConfigHash = (statement: string) => {
  const [hash] = decodeReviewServingJsonRows(statement)
    .filter((row) => {
      return row.prompt_id === 'prompt-1'
    })
    .map((row) => {
      return String(row.review_config_hash)
    })

  return hash ?? ''
}

const getApplyStatement = (statements: readonly string[]) => {
  return (
    statements.find((statement) => {
      return statement.includes('UPDATE mart.review_article_serving_list_mode_state_v4 state')
    }) ?? ''
  )
}

beforeEach(async () => {
  duckdbInstance = await DuckDBInstance.create(':memory:', duckdbEngineCompatibilityOptions)
  connection = await duckdbInstance.connect()
  await connection.run(schemaSql)
  await connection.run(dataSql)
})

afterEach(() => {
  connection?.closeSync()
  duckdbInstance?.closeSync()
  connection = null
  duckdbInstance = null
})

test('refusal deltas count refused prompts under the project identity and answered prompts win', async () => {
  const {database, statements} = createSourceOnlyDatabase()

  await projectReviewServingLlmStatusPatches(
    projectInput([
      llmClaim({}),
      llmClaim({
        articleId: 'article-2',
        dirtyWorkId: 'dirty-work-2',
        scopeId: `${projectId}:article-2`,
        sourcePartition: 'llmJudgment:article-2',
      }),
    ]),
    database,
  )

  const applyStatement = getApplyStatement(statements)
  const projectReviewConfigHash = getProjectReviewConfigHash(applyStatement)
  const statusKeys = getStatusKeysByArticlePrompt(applyStatement)
  const otherModelKeys = Object.entries(statusKeys).filter(([key]) => {
    return !key.startsWith(`${projectReviewConfigHash}|`)
  })

  expect(projectReviewConfigHash).not.toBe('')
  expect(statusKeys[`${projectReviewConfigHash}|article-1`]).toEqual({
    'prompt-1': 'answered',
    'prompt-2': 'refused',
    'prompt-3': 'answered',
    'prompt-4': 'unanswered',
  })
  expect(statusKeys[`${projectReviewConfigHash}|article-2`]).toEqual({
    'prompt-1': 'refused',
    'prompt-2': 'refused',
    'prompt-3': 'refused',
    'prompt-4': 'refused',
  })
  expect(
    otherModelKeys.map(([, keys]) => {
      return keys
    }),
  ).toEqual([{'prompt-4': 'refused'}])

  await insertServingRows(projectReviewConfigHash, ['article-1', 'article-2', 'article-3'])
  await getConnection().run(applyStatement)

  expect(await getListModeStateRows(projectReviewConfigHash)).toEqual([
    {article_id: 'article-1', llm_has_judgment: true, llm_refused_prompt_count: 1, llm_status: 'unanswered'},
    {article_id: 'article-2', llm_has_judgment: false, llm_refused_prompt_count: 4, llm_status: 'unanswered'},
    {article_id: 'article-3', llm_has_judgment: false, llm_refused_prompt_count: 0, llm_status: null},
  ])
})

test('project review config claims mark refused prompts only under the project identity', async () => {
  const {database, statements} = createSourceOnlyDatabase()

  await projectReviewServingLlmStatusPatches(
    projectInput([
      llmClaim({
        articleId: null,
        dirtyKind: 'project.reviewConfig.updated',
        scopeId: projectId,
        scopeKind: 'project',
        sourcePartition: `projectReviewConfig:${projectId}`,
      }),
    ]),
    database,
  )

  const applyStatement = getApplyStatement(statements)
  const projectReviewConfigHash = getProjectReviewConfigHash(applyStatement)

  expect(getStatusKeysByArticlePrompt(applyStatement)).toEqual({
    [`${projectReviewConfigHash}|article-1`]: {
      'prompt-1': 'answered',
      'prompt-2': 'refused',
      'prompt-3': 'answered',
      'prompt-4': 'unanswered',
    },
    [`${projectReviewConfigHash}|article-2`]: {
      'prompt-1': 'refused',
      'prompt-2': 'refused',
      'prompt-3': 'refused',
      'prompt-4': 'refused',
    },
    [`${projectReviewConfigHash}|article-3`]: {
      'prompt-1': 'answered',
      'prompt-2': 'answered',
      'prompt-3': 'answered',
      'prompt-4': 'answered',
    },
  })
})

test('prompt config claims mark refused prompts under the project identity', async () => {
  const {database, statements} = createSourceOnlyDatabase()

  await projectReviewServingLlmStatusPatches(
    projectInput([
      llmClaim({
        articleId: null,
        dirtyKind: 'prompt.config.updated',
        scopeId: `${projectId}:prompt-4`,
        scopeKind: 'prompt',
        sourcePartition: `promptConfig:${projectId}:prompt-4`,
      }),
    ]),
    database,
  )

  const applyStatement = getApplyStatement(statements)
  const [projectReviewConfigHash] = decodeReviewServingJsonRows(applyStatement).map((row) => {
    return String(row.review_config_hash)
  })

  expect(getStatusKeysByArticlePrompt(applyStatement)).toEqual({
    [`${projectReviewConfigHash}|article-1`]: {'prompt-4': 'unanswered'},
    [`${projectReviewConfigHash}|article-2`]: {'prompt-4': 'refused'},
    [`${projectReviewConfigHash}|article-3`]: {'prompt-4': 'unanswered'},
  })
})

test('range rebuilds count refused unanswered prompts under the project identity', async () => {
  await insertServingRows('config-range', ['article-1', 'article-2', 'article-3'])

  await projectReviewServingLlmStatusRanges(
    {
      ranges: [
        {...projectInput([]), chunkEndArticleId: 'article-2', chunkStartArticleId: 'article-1'},
        {...projectInput([]), chunkEndArticleId: 'article-3', chunkStartArticleId: 'article-3'},
      ],
    },
    createDuckdbDatabase(),
  )

  expect(await getListModeStateRows('config-range')).toEqual([
    {article_id: 'article-1', llm_has_judgment: true, llm_refused_prompt_count: 1, llm_status: 'unanswered'},
    {article_id: 'article-2', llm_has_judgment: false, llm_refused_prompt_count: 4, llm_status: 'unanswered'},
    {article_id: 'article-3', llm_has_judgment: true, llm_refused_prompt_count: 0, llm_status: 'answered'},
  ])
})

test('range rebuilds reset the refused prompt count once the refused prompt is answered', async () => {
  await insertServingRows('config-range', ['article-2'])
  await getConnection().run(`
    UPDATE mart.review_article_serving_list_mode_state_v4
    SET llm_refused_prompt_count = 4
    WHERE article_id = 'article-2';
    INSERT INTO app."judgment" VALUES
      ${['prompt-1', 'prompt-2', 'prompt-3', 'prompt-4']
        .map((promptId) => {
          return getJudgmentSql({answered: true, articleId: 'article-2', promptId})
        })
        .join(', ')};
  `)

  await projectReviewServingLlmStatusRanges(
    {ranges: [{...projectInput([]), chunkEndArticleId: 'article-2', chunkStartArticleId: 'article-2'}]},
    createDuckdbDatabase(),
  )

  expect(await getListModeStateRows('config-range')).toEqual([
    {article_id: 'article-2', llm_has_judgment: true, llm_refused_prompt_count: 0, llm_status: 'answered'},
  ])
})
