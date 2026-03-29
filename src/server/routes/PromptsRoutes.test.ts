import {rmSync} from 'node:fs'

import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

const tempDbPath = `/tmp/f1-prompts-routes-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {promptsRoutes}] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('./PromptsRoutes.ts'),
  ])

  resetDuckdbServiceForTests()
  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = <T>(statement: string) => {
    return database.queryJson<T>(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  app = new Elysia().use(promptsRoutes)
})

afterAll(async () => {
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
})

const insertPromptFixture = async ({promptId}: {promptId: string}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Comparison delete regression prompt', '${promptId}-hash')
  `)
}

const insertProviderConnectionFixture = async ({connectionId}: {connectionId: string}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'sglang', '${connectionId}', TRUE, 'none')
  `)
}

const insertModelFixture = async ({connectionId, modelId}: {connectionId: string; modelId: string}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await insertProviderConnectionFixture({connectionId})
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', '${modelId}', '${modelId}', '${modelId}', 'manual', TRUE)
  `)
}

const insertProjectFixture = async ({
  connectionId,
  modelId,
  projectId,
}: {
  connectionId: string
  modelId: string
  projectId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await insertModelFixture({connectionId, modelId})
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', '${projectId}', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
}

const insertArticleFixture = async ({articleId}: {articleId: string}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('${articleId}', '${articleId}')
  `)
}

const insertPromptMergeFixture = async ({
  keepPromptId,
  mergePromptId,
  comparisonProjectId,
}: {
  keepPromptId: string
  mergePromptId: string
  comparisonProjectId: string
}) => {
  await insertPromptFixture({promptId: keepPromptId})
  await insertPromptFixture({promptId: mergePromptId})
  await insertComparisonProjectPromptFixture({comparisonProjectId, promptId: mergePromptId})
}

const insertComparisonProjectPromptFixture = async ({
  comparisonProjectId,
  promptId,
}: {
  comparisonProjectId: string
  promptId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.comparison_project (id, name)
    VALUES ('${comparisonProjectId}', 'Prompt dependency comparison project')
  `)
  await runDatabase(`
    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order)
    VALUES ('${comparisonProjectId}-prompt-link', '${comparisonProjectId}', '${promptId}', 0)
  `)
}

const insertJudgmentPromptCollisionFixture = async ({
  articleId,
  connectionId,
  keepPromptId,
  mergePromptId,
  modelId,
}: {
  articleId: string
  connectionId: string
  keepPromptId: string
  mergePromptId: string
  modelId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await insertPromptFixture({promptId: keepPromptId})
  await insertPromptFixture({promptId: mergePromptId})
  await insertModelFixture({connectionId, modelId})
  await insertArticleFixture({articleId})
  await runDatabase(`
    INSERT INTO app.judgment (
      id,
      article_id,
      prompt_id,
      model_id,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      delete_generation,
      is_answered,
      explanation
    ) VALUES
      ('${keepPromptId}-judgment', '${articleId}', '${keepPromptId}', '${modelId}', TRUE, TRUE, FALSE, FALSE, 0, TRUE, 'keep'),
      ('${mergePromptId}-judgment', '${articleId}', '${mergePromptId}', '${modelId}', TRUE, TRUE, FALSE, FALSE, 0, TRUE, 'merge')
  `)
}

const insertHumanJudgmentPromptCollisionFixture = async ({
  articleId,
  connectionId,
  keepPromptId,
  mergePromptId,
  modelId,
  projectId,
}: {
  articleId: string
  connectionId: string
  keepPromptId: string
  mergePromptId: string
  modelId: string
  projectId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await insertPromptFixture({promptId: keepPromptId})
  await insertPromptFixture({promptId: mergePromptId})
  await insertProjectFixture({connectionId, modelId, projectId})
  await insertArticleFixture({articleId})
  await runDatabase(`
    INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer)
    VALUES
      ('${keepPromptId}-judgment-human', '${projectId}', '${articleId}', '${keepPromptId}', TRUE, 'keep'),
      ('${mergePromptId}-judgment-human', '${projectId}', '${articleId}', '${mergePromptId}', TRUE, 'merge')
  `)
}

test('deleting a prompt is blocked when a comparison project still references it', async () => {
  if (!app || !queryDatabase) {
    throw new Error('Test app not initialized')
  }

  const promptId = `comparison-project-prompt-${Date.now()}`
  const comparisonProjectId = `comparison-project-${Date.now()}`

  await insertPromptFixture({promptId})
  await insertComparisonProjectPromptFixture({comparisonProjectId, promptId})

  const response = await app.handle(new Request(`http://localhost/api/prompts/${promptId}`, {method: 'DELETE'}))
  const body = (await response.json()) as {data: null; error: string}
  const [remainingPrompt] = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.prompt
    WHERE id = '${promptId}'
  `)

  expect(response.status).toBe(409)
  expect(body.error).toBe('Prompt delete blocked. Remove project, comparison project, and judgment references first.')
  expect(remainingPrompt?.id).toBe(promptId)
})

test('merging a prompt rewrites comparison project prompt references before delete', async () => {
  if (!app || !queryDatabase) {
    throw new Error('Test app not initialized')
  }

  const keepPromptId = `keep-comparison-project-prompt-${Date.now()}`
  const mergePromptId = `merge-comparison-project-prompt-${Date.now()}`
  const comparisonProjectId = `merge-comparison-project-${Date.now()}`

  await insertPromptMergeFixture({keepPromptId, mergePromptId, comparisonProjectId})

  const response = await app.handle(
    new Request('http://localhost/api/prompts/merge', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({keepPromptId, mergePromptIds: [mergePromptId]}),
    }),
  )
  const [remainingMergePrompt] = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.prompt
    WHERE id = '${mergePromptId}'
  `)
  const comparisonProjectPrompts = await queryDatabase<{promptId: string}>(`
    SELECT prompt_id AS promptId
    FROM app.comparison_project_prompt
    WHERE comparison_project_id = '${comparisonProjectId}'
  `)

  expect(response.status).toBe(200)
  expect(remainingMergePrompt).toBeUndefined()
  expect(comparisonProjectPrompts).toEqual([{promptId: keepPromptId}])
})

test('merging a prompt deletes colliding judgment rows before rewriting prompt ids', async () => {
  if (!app || !queryDatabase) {
    throw new Error('Test app not initialized')
  }

  const keepPromptId = `keep-judgment-prompt-${Date.now()}`
  const mergePromptId = `merge-judgment-prompt-${Date.now()}`
  const articleId = `judgment-article-${Date.now()}`
  const connectionId = `judgment-connection-${Date.now()}`
  const modelId = `judgment-model-${Date.now()}`

  await insertJudgmentPromptCollisionFixture({articleId, connectionId, keepPromptId, mergePromptId, modelId})

  const response = await app.handle(
    new Request('http://localhost/api/prompts/merge', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({keepPromptId, mergePromptIds: [mergePromptId]}),
    }),
  )
  const body = (await response.json()) as {success?: boolean; error?: string}
  const remainingJudgments = await queryDatabase<{id: string; promptId: string}>(`
    SELECT id, prompt_id AS promptId
    FROM app.judgment
    WHERE article_id = '${articleId}'
    ORDER BY id
  `)

  expect(response.status).toBe(200)
  expect(body).toEqual({success: true})
  expect(body.error).toBeUndefined()
  expect(remainingJudgments).toEqual([{id: `${keepPromptId}-judgment`, promptId: keepPromptId}])
})

test('merging a prompt deletes colliding human judgment rows before rewriting prompt ids', async () => {
  if (!app || !queryDatabase) {
    throw new Error('Test app not initialized')
  }

  const keepPromptId = `keep-human-judgment-prompt-${Date.now()}`
  const mergePromptId = `merge-human-judgment-prompt-${Date.now()}`
  const articleId = `human-judgment-article-${Date.now()}`
  const connectionId = `human-judgment-connection-${Date.now()}`
  const modelId = `human-judgment-model-${Date.now()}`
  const projectId = `human-judgment-project-${Date.now()}`

  await insertHumanJudgmentPromptCollisionFixture({
    articleId,
    connectionId,
    keepPromptId,
    mergePromptId,
    modelId,
    projectId,
  })

  const response = await app.handle(
    new Request('http://localhost/api/prompts/merge', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({keepPromptId, mergePromptIds: [mergePromptId]}),
    }),
  )
  const body = (await response.json()) as {success?: boolean; error?: string}
  const remainingHumanJudgments = await queryDatabase<{id: string; promptId: string}>(`
    SELECT id, prompt_id AS promptId
    FROM app.judgment_human
    WHERE project_id = '${projectId}'
      AND article_id = '${articleId}'
    ORDER BY id
  `)

  expect(response.status).toBe(200)
  expect(body).toEqual({success: true})
  expect(body.error).toBeUndefined()
  expect(remainingHumanJudgments).toEqual([{id: `${keepPromptId}-judgment-human`, promptId: keepPromptId}])
})
