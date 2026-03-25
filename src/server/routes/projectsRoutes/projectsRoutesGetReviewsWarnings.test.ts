import {rmSync} from 'node:fs'

import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

const tempDbPath = `/tmp/f1-project-reviews-warnings-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type ReviewsWarningsResponse = {
  data: {
    enabledPromptCount: number
    indexing: {
      oldestQueuedAt: string | null
      pendingArticleRefreshCount: number
      pendingProjectRefreshCount: number
      pendingRefreshCount: number
      status: string
    }
    projectId: string
    scope: {hasAnyArticlesInScope: boolean}
  }
}

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

const insertProjectFixture = async (projectId: string) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('connection-${projectId}', 'sglang', 'SGLang', TRUE, 'none')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('model-${projectId}', 'connection-${projectId}', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Warnings Project', 'model-${projectId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('prompt-${projectId}', 'Prompt body', 'hash-${projectId}')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('project-prompt-${projectId}', '${projectId}', 'prompt-${projectId}', 1, TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('article-${projectId}', 'Indexed article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('project-article-${projectId}', '${projectId}', 'article-${projectId}')
  `)
}

const postWarningsRequest = async (projectId: string) => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const response = await app.handle(
    new Request('http://localhost/api/projectsreviewswarnings', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({projectId}),
    }),
  )

  return {body: (await response.json()) as ReviewsWarningsResponse, response}
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {projectsRoutesGetReviewsWarnings},
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./projectsRoutesGetReviewsWarnings.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  app = new Elysia().use(projectsRoutesGetReviewsWarnings)
})

afterAll(async () => {
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.writer.history.json`, {force: true})
  rmSync(`${tempDbPath}.writer.lock`, {force: true})
})

test('reviews warnings report refreshing when a project refresh is queued', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-refreshing-warning'

  await insertProjectFixture(projectId)
  await runDatabase(`
    INSERT INTO app.mart_refresh_queue (id, refresh_scope, project_id, article_id, project_key, article_key, reason)
    VALUES ('queue-${projectId}', 'project', '${projectId}', NULL, '${projectId}', '', 'test-refreshing')
  `)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.enabledPromptCount).toBe(1)
  expect(body.data.indexing.pendingProjectRefreshCount).toBe(1)
  expect(body.data.indexing.pendingArticleRefreshCount).toBe(0)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings report refreshing when article judgment refreshes are queued for scoped articles', async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  const projectId = 'project-article-refresh-warning'

  await insertProjectFixture(projectId)
  await runDatabase(`
    INSERT INTO app.mart_refresh_queue (id, refresh_scope, project_id, article_id, project_key, article_key, reason)
    VALUES ('queue-${projectId}', 'judgment_article', NULL, 'article-${projectId}', '', 'article-${projectId}', 'test-article-refreshing')
  `)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.pendingProjectRefreshCount).toBe(0)
  expect(body.data.indexing.pendingArticleRefreshCount).toBe(1)
  expect(body.data.indexing.pendingRefreshCount).toBe(1)
  expect(body.data.indexing.status).toBe('refreshing')
})

test('reviews warnings report stale when scope exists but review rollups are missing', async () => {
  const projectId = 'project-stale-warning'

  await insertProjectFixture(projectId)

  const {body, response} = await postWarningsRequest(projectId)

  expect(response.status).toBe(200)
  expect(body.data.scope.hasAnyArticlesInScope).toBe(true)
  expect(body.data.indexing.pendingRefreshCount).toBe(0)
  expect(body.data.indexing.status).toBe('stale')
})
