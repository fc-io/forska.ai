import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(180_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-projects-resolution-comment-prompt-mode')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const comparisonProjectId = 'comment-prompt-mode-comparison'

type AppDatabase = ReturnType<typeof import('../services/appDatabaseService.ts').getAppDatabaseService>
type ResolutionResponse = {data: {comment: string | null; commentUpdatedAt: string | null; value: string} | null}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let database: AppDatabase | null = null

const getApp = () => {
  if (!app) {
    throw new Error('App not initialized')
  }

  return app
}

const getDatabase = () => {
  if (!database) {
    throw new Error('Database not initialized')
  }

  return database
}

const postJson = async (path: string, body: unknown) => {
  const response = await getApp().handle(
    new Request(`http://localhost${path}`, {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const text = await response.text()

  return {body: (response.ok ? JSON.parse(text) : {data: null}) as ResolutionResponse, status: response.status}
}

const getResolutionRow = async () => {
  const [row] = await getDatabase().queryJson<{
    answerValue: string | null
    comment: string | null
    commentUpdatedAt: string | null
    promptId: string | null
  }>(`
    SELECT
      prompt_id AS promptId,
      answer_value AS answerValue,
      comment,
      CAST(comment_updated_at AS VARCHAR) AS commentUpdatedAt
    FROM app.comparison_project_conflict_resolution
    WHERE comparison_project_id = '${comparisonProjectId}'
      AND article_id = 'comment-prompt-mode-article-1'
  `)

  return row
}

const seed = async () => {
  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('comment-prompt-mode-connection', 'openrouter', 'OpenRouter', TRUE, 'api-key');
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('comment-prompt-mode-model', 'comment-prompt-mode-connection', 'gpt-5.5', 'comment-prompt-mode-model', 'GPT 5.5', 'manual', TRUE);
    INSERT INTO app.project (id, name, description, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES
      ('comment-prompt-mode-source', 'Comment prompt mode source', NULL, 'comment-prompt-mode-model', TRUE, TRUE, FALSE, FALSE),
      ('comment-prompt-mode-humans', 'Comment prompt mode humans', NULL, 'comment-prompt-mode-model', TRUE, TRUE, FALSE, FALSE);
    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash)
    VALUES
      ('comment-prompt-mode-population', 'Population text', 'Population', NULL, 'comment-prompt-mode-population-hash'),
      ('comment-prompt-mode-outcome', 'Outcome text', 'Outcome', NULL, 'comment-prompt-mode-outcome-hash'),
      ('comment-prompt-mode-retired', 'Retired text', 'Retired', NULL, 'comment-prompt-mode-retired-hash');
    INSERT INTO app.article (id, article_id, article_title, article_summary, article_created_at)
    VALUES
      ('comment-prompt-mode-article-1', 'external-1', 'Prompt mode article one', 'Summary one', TIMESTAMPTZ '2026-10-01T00:00:00Z'),
      ('comment-prompt-mode-article-2', 'external-2', 'Prompt mode article two', 'Summary two', TIMESTAMPTZ '2026-10-02T00:00:00Z');
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('comment-prompt-mode-source-article-1', 'comment-prompt-mode-source', 'comment-prompt-mode-article-1'),
      ('comment-prompt-mode-source-article-2', 'comment-prompt-mode-source', 'comment-prompt-mode-article-2');
    INSERT INTO app.judgment (
      id, article_id, prompt_id, model_id, project_id, is_answered, answered_original,
      use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES
      ('comment-prompt-mode-j-1-population', 'comment-prompt-mode-article-1', 'comment-prompt-mode-population', 'comment-prompt-mode-model', 'comment-prompt-mode-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('comment-prompt-mode-j-1-outcome', 'comment-prompt-mode-article-1', 'comment-prompt-mode-outcome', 'comment-prompt-mode-model', 'comment-prompt-mode-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('comment-prompt-mode-j-2-population', 'comment-prompt-mode-article-2', 'comment-prompt-mode-population', 'comment-prompt-mode-model', 'comment-prompt-mode-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE),
      ('comment-prompt-mode-j-2-outcome', 'comment-prompt-mode-article-2', 'comment-prompt-mode-outcome', 'comment-prompt-mode-model', 'comment-prompt-mode-source', TRUE, 'yes', TRUE, TRUE, FALSE, FALSE);
    INSERT INTO app.judgment_human (id, project_id, article_id, prompt_id, is_answered, answer)
    VALUES
      ('comment-prompt-mode-h-1-population', 'comment-prompt-mode-humans', 'comment-prompt-mode-article-1', 'comment-prompt-mode-population', TRUE, 'no'),
      ('comment-prompt-mode-h-1-outcome', 'comment-prompt-mode-humans', 'comment-prompt-mode-article-1', 'comment-prompt-mode-outcome', TRUE, 'yes'),
      ('comment-prompt-mode-h-2-population', 'comment-prompt-mode-humans', 'comment-prompt-mode-article-2', 'comment-prompt-mode-population', TRUE, 'no'),
      ('comment-prompt-mode-h-2-outcome', 'comment-prompt-mode-humans', 'comment-prompt-mode-article-2', 'comment-prompt-mode-outcome', TRUE, 'yes');
    INSERT INTO app.comparison_project (
      id, name, description, model_ids, compare_with_humans, allow_conflict_resolution, human_judgment_mode,
      summary_source_project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images
    )
    VALUES ('${comparisonProjectId}', 'Comment prompt mode', NULL, ['comment-prompt-mode-model'], TRUE, TRUE, 'prompt', NULL, TRUE, TRUE, FALSE, FALSE);
    INSERT INTO app.comparison_project_prompt (id, comparison_project_id, prompt_id, prompt_order)
    VALUES
      ('comment-prompt-mode-cp-population', '${comparisonProjectId}', 'comment-prompt-mode-population', 0),
      ('comment-prompt-mode-cp-outcome', '${comparisonProjectId}', 'comment-prompt-mode-outcome', 1);
    INSERT INTO app.comparison_project_source_project (id, comparison_project_id, source_project_id)
    VALUES ('comment-prompt-mode-cp-source', '${comparisonProjectId}', 'comment-prompt-mode-source');
  `)
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {comparisonProjectsRoutes}, rebuildModule] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('./ComparisonProjectsRoutes.ts'),
    import('../services/comparisonProjectServingRebuildService.ts'),
  ])

  await migrateDuckdb()
  database = getAppDatabaseService()
  app = new Elysia().use(comparisonProjectsRoutes)
  await seed()
  await rebuildModule.getComparisonProjectServingRebuildService().rebuildComparisonProjectServing(comparisonProjectId)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('prompt mode: a comment is stored on the prompt resolution and carried over when another prompt wins', async () => {
  const saved = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution`, {
    articleId: 'comment-prompt-mode-article-1',
    value: 'comment-prompt-mode-population',
  })
  const commented = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution/comment`, {
    articleId: 'comment-prompt-mode-article-1',
    comment: 'Population drives the conflict',
  })
  const commentedRow = await getResolutionRow()

  expect(saved.status).toBe(200)
  expect(commented.status).toBe(200)
  expect(commented.body.data).toMatchObject({
    comment: 'Population drives the conflict',
    value: 'comment-prompt-mode-population',
  })
  expect(commentedRow).toMatchObject({
    answerValue: null,
    comment: 'Population drives the conflict',
    promptId: 'comment-prompt-mode-population',
  })

  const reResolved = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution`, {
    articleId: 'comment-prompt-mode-article-1',
    value: 'comment-prompt-mode-outcome',
  })

  expect(reResolved.body.data).toMatchObject({
    comment: 'Population drives the conflict',
    commentUpdatedAt: commented.body.data?.commentUpdatedAt,
    value: 'comment-prompt-mode-outcome',
  })
  expect(await getResolutionRow()).toEqual({
    answerValue: null,
    comment: 'Population drives the conflict',
    commentUpdatedAt: commentedRow?.commentUpdatedAt ?? null,
    promptId: 'comment-prompt-mode-outcome',
  })
})

test('prompt mode: a resolution whose prompt left the project rejects a comment and rolls the update back', async () => {
  await getDatabase().run(`
    UPDATE app.comparison_project_conflict_resolution
    SET prompt_id = 'comment-prompt-mode-retired'
    WHERE comparison_project_id = '${comparisonProjectId}'
      AND article_id = 'comment-prompt-mode-article-1'
  `)
  const before = await getResolutionRow()
  const response = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution/comment`, {
    articleId: 'comment-prompt-mode-article-1',
    comment: 'Should not be stored',
  })

  expect(response.status).toBe(400)
  expect(await getResolutionRow()).toEqual(before)
  expect(before?.comment).toBe('Population drives the conflict')
})
