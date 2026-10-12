import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(180_000)

const tempRuntimeRoot = createTempRuntimeRoot('comparison-projects-conflict-comment-prompt-mode')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const comparisonProjectId = 'comment-prompt-mode-comparison'

type AppDatabase = ReturnType<typeof import('../services/appDatabaseService.ts').getAppDatabaseService>
type ConflictComment = {
  author: {displayName: string | null; userId: string} | null
  comment: string
  updatedAt: string | null
}
type ResponseBody = {data: {articleId?: string; conflictComment?: ConflictComment | null; value?: string} | null}
type ListedRow = {
  canonicalArticleId: string
  conflictComment: ConflictComment | null
  conflictResolution: {value: string} | null
}

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

  return {body: (response.ok ? JSON.parse(text) : {data: null}) as ResponseBody, status: response.status}
}

const getResolutionRow = async () => {
  const [row] = await getDatabase().queryJson<{answerValue: string | null; promptId: string | null}>(`
    SELECT prompt_id AS promptId, answer_value AS answerValue
    FROM app.comparison_project_conflict_resolution
    WHERE comparison_project_id = '${comparisonProjectId}'
      AND article_id = 'comment-prompt-mode-article-1'
  `)

  return row
}

const getCommentRows = () => {
  return getDatabase().queryJson<{articleId: string; comment: string; updatedAt: string}>(`
    SELECT article_id AS articleId, comment, CAST(updated_at AS VARCHAR) AS updatedAt
    FROM app.comparison_project_conflict_comment
    WHERE comparison_project_id = '${comparisonProjectId}'
    ORDER BY article_id
  `)
}

const postComment = (articleId: string, comment: string | null) => {
  return postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-comment`, {articleId, comment})
}

const getListedRow = async (articleId: string) => {
  const response = await getApp().handle(
    new Request(`http://localhost/api/comparison-projects/${comparisonProjectId}/judgments`, {
      body: JSON.stringify({limit: 50}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {data: ListedRow[]}}

  return body.data.data.find((row) => {
    return row.canonicalArticleId === articleId
  })
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

test('prompt mode: a comment needs no resolution and survives prompt switches and reset', async () => {
  const commented = await postComment('comment-prompt-mode-article-1', 'Population drives the conflict')
  const commentRows = await getCommentRows()

  expect(commented.status).toBe(200)
  expect(commented.body.data).toMatchObject({
    articleId: 'comment-prompt-mode-article-1',
    conflictComment: {comment: 'Population drives the conflict'},
  })
  expect(commented.body.data?.conflictComment?.author?.userId).toBeTruthy()
  expect(await getResolutionRow()).toBeUndefined()
  expect(await getListedRow('comment-prompt-mode-article-1')).toMatchObject({
    conflictComment: {
      comment: 'Population drives the conflict',
      updatedAt: commented.body.data?.conflictComment?.updatedAt,
    },
    conflictResolution: null,
  })

  const saved = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution`, {
    articleId: 'comment-prompt-mode-article-1',
    value: 'comment-prompt-mode-population',
  })
  const reResolved = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution`, {
    articleId: 'comment-prompt-mode-article-1',
    value: 'comment-prompt-mode-outcome',
  })

  expect(saved.status).toBe(200)
  expect(reResolved.body.data).toMatchObject({value: 'comment-prompt-mode-outcome'})
  expect(reResolved.body.data).not.toHaveProperty('comment')
  expect(await getResolutionRow()).toEqual({answerValue: null, promptId: 'comment-prompt-mode-outcome'})
  expect(await getCommentRows()).toEqual(commentRows)
  expect(await getListedRow('comment-prompt-mode-article-1')).toMatchObject({
    conflictComment: {comment: 'Population drives the conflict'},
    conflictResolution: {value: 'comment-prompt-mode-outcome'},
  })

  const reset = await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution/reset`, {
    articleId: 'comment-prompt-mode-article-1',
  })

  expect(reset.status).toBe(200)
  expect(await getResolutionRow()).toBeUndefined()
  expect(await getCommentRows()).toEqual(commentRows)
})

test('prompt mode: a comment does not depend on the resolution value still being an option', async () => {
  await postJson(`/api/comparison-projects/${comparisonProjectId}/conflict-resolution`, {
    articleId: 'comment-prompt-mode-article-1',
    value: 'comment-prompt-mode-population',
  })
  await getDatabase().run(`
    UPDATE app.comparison_project_conflict_resolution
    SET prompt_id = 'comment-prompt-mode-retired'
    WHERE comparison_project_id = '${comparisonProjectId}'
      AND article_id = 'comment-prompt-mode-article-1'
  `)
  const response = await postComment('comment-prompt-mode-article-1', 'Retired prompt, still worth a note')

  expect(response.status).toBe(200)
  expect(await getResolutionRow()).toEqual({answerValue: null, promptId: 'comment-prompt-mode-retired'})
  expect(
    (await getCommentRows()).map((row) => {
      return row.comment
    }),
  ).toEqual(['Retired prompt, still worth a note'])
})
