import {afterAll, beforeAll, expect, mock, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../../server/test/createTempRuntimeRoot.ts'
import type {ShortIdMapping} from '../judgeGetPrompt.ts'

setDefaultTimeout(120_000)

const llmJudgmentReviewServingDeltaServiceModulePath = new URL(
  '../../../server/reviewServing/llmJudgmentReviewServingDeltaService.ts',
  import.meta.url,
).href
const tempRuntimeRoot = createTempRuntimeRoot('f1-judge-store-judgment-dirty-atomicity')

type AppendLlmJudgmentReviewServingDeltas =
  typeof import('../../../server/reviewServing/llmJudgmentReviewServingDeltaService.ts').appendLlmJudgmentReviewServingDeltas
type AppendLlmJudgmentReviewServingDeltasArgs = Parameters<AppendLlmJudgmentReviewServingDeltas>

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let appendLlmJudgmentReviewServingDeltasOverride:
  | ((...args: AppendLlmJudgmentReviewServingDeltasArgs) => Promise<void>)
  | null = null

void mock.module(llmJudgmentReviewServingDeltaServiceModulePath, () => {
  return {
    appendLlmJudgmentReviewServingDeltas: (...args: AppendLlmJudgmentReviewServingDeltasArgs) => {
      return appendLlmJudgmentReviewServingDeltasOverride?.(...args) ?? Promise.resolve()
    },
  }
})

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../../db/migrateDuckdb.ts'),
      import('../../../server/services/appDatabaseService.ts'),
      import('../../../server/utils/duckdbService.ts'),
      import('../../../server/utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = (statement: string) => {
    return database.queryJson(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('judgeStoreJudgment rolls back the judgment when dirty-state marking fails', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const {judgeStoreJudgment} = await import('../judgeStoreJudgment.ts')
  const originalConsoleError = console.error
  const now = Date.now()
  const connectionId = `connection-judge-store-atomic-${now}`
  const modelId = `model-judge-store-atomic-${now}`
  const projectId = `project-judge-store-atomic-${now}`
  const promptId = `prompt-judge-store-atomic-${now}`
  const articleId = `article-judge-store-atomic-${now}`
  const shortIdMapping: ShortIdMapping = new Map([['p001', promptId]])
  let receivedRunner = false

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Judge Store Atomic Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)

  appendLlmJudgmentReviewServingDeltasOverride = async (runner) => {
    receivedRunner = runner != null
    throw new Error('dirty mark failed inside transaction')
  }
  console.error = () => {}

  try {
    await judgeStoreJudgment(
      articleId,
      'Article',
      {'p001---explanation': 'because', 'p001---question': ['include'], 'p001---quotes': ['quote']},
      modelId,
      [promptId],
      projectId,
      shortIdMapping,
    )
  } finally {
    appendLlmJudgmentReviewServingDeltasOverride = null
    console.error = originalConsoleError
  }

  const [row] = await queryDatabase<{deltaRows: number; judgmentRows: number}>(`
    SELECT
      (SELECT COUNT(*) FROM app.judgment WHERE article_id = '${articleId}') AS judgmentRows,
      (SELECT COUNT(*) FROM app.review_change_delta WHERE article_id = '${articleId}') AS deltaRows
  `)

  expect(receivedRunner).toBe(true)
  expect(Number(row?.judgmentRows ?? 0)).toBe(0)
  expect(Number(row?.deltaRows ?? 0)).toBe(0)
})

test('judgeStoreJudgment stores the project system prompt variant as its own judgment identity', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const {judgeStoreJudgment} = await import('../judgeStoreJudgment.ts')
  const now = Date.now()
  const connectionId = `connection-judge-store-variant-${now}`
  const modelId = `model-judge-store-variant-${now}`
  const projectId = `project-judge-store-variant-${now}`
  const promptId = `prompt-judge-store-variant-${now}`
  const articleId = `article-judge-store-variant-${now}`
  const shortIdMapping: ShortIdMapping = new Map([['p001', promptId]])
  const deltaInputs: Array<AppendLlmJudgmentReviewServingDeltasArgs[1][number]> = []

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (
      id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, system_prompt_variant
    )
    VALUES ('${projectId}', 'Judge Store Variant Test', '${modelId}', TRUE, TRUE, FALSE, FALSE, 'screening_v1')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${projectId}-article', '${projectId}', '${articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('${projectId}-prompt', '${projectId}', '${promptId}', 1, TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
      is_answered, answered_original
    )
    VALUES ('${articleId}-legacy', '${articleId}', '${promptId}', '${modelId}', TRUE, TRUE, FALSE, FALSE, TRUE, 'exclude')
  `)

  appendLlmJudgmentReviewServingDeltasOverride = async (_runner, inputs) => {
    deltaInputs.push(...inputs)
  }

  try {
    await judgeStoreJudgment(
      articleId,
      'Article',
      {'p001---explanation': 'because', 'p001---question': 'include', 'p001---quotes': ['quote']},
      modelId,
      [promptId],
      projectId,
      shortIdMapping,
    )
  } finally {
    appendLlmJudgmentReviewServingDeltasOverride = null
  }

  const rows = await queryDatabase<{answeredOriginal: string; systemPromptVariant: string}>(`
    SELECT answered_original AS answeredOriginal, system_prompt_variant AS systemPromptVariant
    FROM app.judgment
    WHERE article_id = '${articleId}'
    ORDER BY system_prompt_variant ASC
  `)

  expect(rows).toEqual([
    {answeredOriginal: 'exclude', systemPromptVariant: 'legacy'},
    {answeredOriginal: 'include', systemPromptVariant: 'screening_v1'},
  ])
  expect(
    deltaInputs.map((input) => {
      return {changeKind: input.changeKind, projectId: input.projectId, systemPromptVariant: input.systemPromptVariant}
    }),
  ).toEqual([{changeKind: 'judgment.llm.created', projectId, systemPromptVariant: 'screening_v1'}])
})

test('judgeStoreJudgment stores the project use_metadata flag as its own judgment identity', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const {judgeStoreJudgment} = await import('../judgeStoreJudgment.ts')
  const now = Date.now()
  const connectionId = `connection-judge-store-metadata-${now}`
  const modelId = `model-judge-store-metadata-${now}`
  const projectId = `project-judge-store-metadata-${now}`
  const promptId = `prompt-judge-store-metadata-${now}`
  const articleId = `article-judge-store-metadata-${now}`
  const shortIdMapping: ShortIdMapping = new Map([['p001', promptId]])
  const deltaInputs: Array<AppendLlmJudgmentReviewServingDeltasArgs[1][number]> = []

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (
      id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, use_metadata
    )
    VALUES ('${projectId}', 'Judge Store Metadata Test', '${modelId}', TRUE, TRUE, FALSE, FALSE, TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', 'Article')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Prompt', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${projectId}-article', '${projectId}', '${articleId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('${projectId}-prompt', '${projectId}', '${promptId}', 1, TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
      is_answered, answered_original
    )
    VALUES ('${articleId}-plain', '${articleId}', '${promptId}', '${modelId}', TRUE, TRUE, FALSE, FALSE, TRUE, 'exclude')
  `)

  appendLlmJudgmentReviewServingDeltasOverride = async (_runner, inputs) => {
    deltaInputs.push(...inputs)
  }

  try {
    await judgeStoreJudgment(
      articleId,
      'Article',
      {'p001---explanation': 'because', 'p001---question': 'include', 'p001---quotes': ['quote']},
      modelId,
      [promptId],
      projectId,
      shortIdMapping,
    )
  } finally {
    appendLlmJudgmentReviewServingDeltasOverride = null
  }

  const rows = await queryDatabase<{answeredOriginal: string; useMetadata: boolean}>(`
    SELECT answered_original AS answeredOriginal, use_metadata AS useMetadata
    FROM app.judgment
    WHERE article_id = '${articleId}'
    ORDER BY use_metadata ASC
  `)

  expect(rows).toEqual([
    {answeredOriginal: 'exclude', useMetadata: false},
    {answeredOriginal: 'include', useMetadata: true},
  ])
  expect(
    deltaInputs.map((input) => {
      return {changeKind: input.changeKind, projectId: input.projectId, useMetadata: input.useMetadata}
    }),
  ).toEqual([{changeKind: 'judgment.llm.created', projectId, useMetadata: true}])
})
