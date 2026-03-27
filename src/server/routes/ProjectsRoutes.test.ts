import {rmSync} from 'node:fs'

import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

const tempDbPath = `/tmp/f1-projects-routes-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let flushMartRefreshes: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

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

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Archive Regression Project', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
}

const rebuildMartRefreshQueueWithoutGeneration = async () => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    DROP TABLE app.mart_refresh_queue;
    CREATE TABLE app.mart_refresh_queue (
      id VARCHAR PRIMARY KEY,
      refresh_scope VARCHAR NOT NULL,
      project_id VARCHAR,
      article_id VARCHAR,
      project_key VARCHAR NOT NULL DEFAULT '',
      article_key VARCHAR NOT NULL DEFAULT '',
      reason VARCHAR,
      created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      UNIQUE(refresh_scope, project_key, article_key)
    );
    CREATE INDEX IF NOT EXISTS idx_app_mart_refresh_queue_created_at ON app.mart_refresh_queue(created_at);
  `)
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {getDuckdbMartRefreshService},
    {projectsRoutes},
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('../services/getDuckdbMartRefreshService.ts'),
    import('./ProjectsRoutes.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  flushMartRefreshes = () => {
    return getDuckdbMartRefreshService().flush()
  }
  queryDatabase = (statement: string) => {
    return database.queryJson(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  app = new Elysia().use(projectsRoutes)
})

afterAll(async () => {
  await flushMartRefreshes?.()
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
})

test('archive route repairs stale mart refresh queue schema before queueing refresh work', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const projectId = 'archive-project-regression'

  await insertProjectFixture({
    connectionId: 'archive-connection-regression',
    modelId: 'archive-model-regression',
    projectId,
  })
  await rebuildMartRefreshQueueWithoutGeneration()

  const response = await app.handle(new Request(`http://localhost/api/projects/${projectId}`, {method: 'DELETE'}))

  expect(response.status).toBe(200)

  const [storedProject] = await queryDatabase<{archived: boolean}>(`
    SELECT archived
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)
  const [queueColumn] = await queryDatabase<{columnName: string}>(`
    SELECT column_name AS columnName
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND table_name = 'mart_refresh_queue'
      AND column_name = 'refresh_generation'
    LIMIT 1
  `)
  const [queuedRefresh] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.mart_refresh_queue
    WHERE project_id = '${projectId}'
  `)

  expect(storedProject?.archived).toBe(true)
  expect(queueColumn?.columnName).toBe('refresh_generation')
  expect(Number(queuedRefresh?.count ?? 0)).toBe(1)

  await flushMartRefreshes()
})

test('edit route accepts full client payload when the model is unchanged', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-same-model-connection'
  const modelId = 'edit-same-model'
  const projectId = 'edit-same-model-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-same-model-article', 'Edit same model article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('edit-same-model-project-article', '${projectId}', 'edit-same-model-article')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        name: 'Updated project name',
        description: null,
        prompts: [],
        dateFrom: null,
        dateTo: null,
        modelId,
        importRoutes: [],
        useTitle: true,
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {project: {modelId: string; name: string}}}

  expect(response.status).toBe(200)
  expect(body.data.project.modelId).toBe(modelId)
  expect(body.data.project.name).toBe('Updated project name')

  const [storedProjectArticle] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_article
    WHERE project_id = '${projectId}'
  `)

  expect(Number(storedProjectArticle?.count ?? 0)).toBe(1)

  await flushMartRefreshes()
})

test('edit route can change the model for a populated project', async () => {
  if (!app || !queryDatabase || !runDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-switch-model-connection'
  const initialModelId = 'edit-switch-model-initial'
  const nextModelId = 'edit-switch-model-next'
  const projectId = 'edit-switch-model-project'

  await insertProjectFixture({connectionId, modelId: initialModelId, projectId})
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${nextModelId}', '${connectionId}', 'Qwen/Qwen3.5-32B', 'Qwen/Qwen3.5-32B', 'Qwen 32B', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('edit-switch-model-article', 'Edit switch model article')
  `)
  await runDatabase(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('edit-switch-model-project-article', '${projectId}', 'edit-switch-model-article')
  `)

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({
        name: 'Project with switched model',
        description: null,
        prompts: [],
        dateFrom: null,
        dateTo: null,
        modelId: nextModelId,
        importRoutes: [],
        useTitle: true,
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {project: {modelId: string; name: string}}}

  expect(response.status).toBe(200)
  expect(body.data.project.modelId).toBe(nextModelId)
  expect(body.data.project.name).toBe('Project with switched model')

  const [storedProject] = await queryDatabase<{modelId: string}>(`
    SELECT model_id AS modelId
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)
  const [storedProjectArticle] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.project_article
    WHERE project_id = '${projectId}'
  `)

  expect(storedProject?.modelId).toBe(nextModelId)
  expect(Number(storedProjectArticle?.count ?? 0)).toBe(1)

  await flushMartRefreshes()
})
