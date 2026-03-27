import {rmSync} from 'node:fs'

import {afterAll, afterEach, beforeAll, expect, test} from 'bun:test'
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

const insertAdditionalModelFixture = async ({connectionId, modelId}: {connectionId: string; modelId: string}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-32B-A10B', 'Qwen/Qwen3.5-32B-A10B', 'Qwen 32B', 'manual', TRUE)
  `)
}

const insertProjectReferencesFixture = async ({
  projectId,
  promptId,
  routeId,
}: {
  projectId: string
  promptId: string
  routeId: string
}) => {
  if (!runDatabase) {
    throw new Error('Database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.prompt (id, original_text, content_hash)
    VALUES ('${promptId}', 'Does this item match?', '${promptId}-hash')
  `)
  await runDatabase(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, archived, origin_project_id)
    VALUES ('${projectId}-project-prompt', '${projectId}', '${promptId}', 1, TRUE, FALSE, '${projectId}')
  `)
  await runDatabase(`
    INSERT INTO app.import_route (id, route, name, active)
    VALUES ('${routeId}', '${routeId}-route', '${routeId} route', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('${projectId}-project-import-route', '${projectId}', '${routeId}')
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
      completed_at TIMESTAMPTZ,
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

afterEach(async () => {
  const {getDuckdbMartRefreshService} = await import('../services/getDuckdbMartRefreshService.ts')
  getDuckdbMartRefreshService().resetProgressSnapshotForTests()
})

afterAll(async () => {
  await flushMartRefreshes?.()
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
})

test('edit route ignores unchanged model updates when the project already has referencing rows', async () => {
  if (!app || !queryDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-noop-model-connection'
  const modelId = 'edit-noop-model-primary'
  const projectId = 'edit-noop-model-project'

  await insertProjectFixture({connectionId, modelId, projectId})
  await insertProjectReferencesFixture({
    projectId,
    promptId: 'edit-noop-model-prompt',
    routeId: 'edit-noop-model-route',
  })

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({modelId, name: 'Updated Project Name'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data?: {project?: {modelId?: string; name?: string}}; error?: string | null}

  expect(response.status).toBe(200)
  expect(body.data?.project?.modelId).toBe(modelId)
  expect(body.data?.project?.name).toBe('Updated Project Name')

  const [storedProject] = await queryDatabase<{modelId: string; name: string}>(`
    SELECT model_id AS modelId, name
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)

  expect(storedProject).toEqual({modelId, name: 'Updated Project Name'})

  await flushMartRefreshes()
})

test('edit route returns a clear 400 when changing model on a referenced project would hit DuckDB FK limitations', async () => {
  if (!app || !queryDatabase) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-change-model-blocked-connection'
  const projectId = 'edit-change-model-blocked-project'
  const originalModelId = 'edit-change-model-blocked-model-primary'
  const replacementModelId = 'edit-change-model-blocked-model-secondary'

  await insertProjectFixture({connectionId, modelId: originalModelId, projectId})
  await insertAdditionalModelFixture({connectionId, modelId: replacementModelId})
  await insertProjectReferencesFixture({
    projectId,
    promptId: 'edit-change-model-blocked-prompt',
    routeId: 'edit-change-model-blocked-route',
  })

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({modelId: replacementModelId}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const bodyText = await response.text()

  expect(response.status).toBe(400)
  expect(bodyText).toContain('Changing the project model is currently blocked by DuckDB foreign key limitations')

  const [storedProject] = await queryDatabase<{modelId: string}>(`
    SELECT model_id AS modelId
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)

  expect(storedProject?.modelId).toBe(originalModelId)
})

test('edit route still allows changing model when the project has no referencing rows', async () => {
  if (!app || !queryDatabase || !flushMartRefreshes) {
    throw new Error('Test app not initialized')
  }

  const connectionId = 'edit-change-model-clean-connection'
  const projectId = 'edit-change-model-clean-project'
  const originalModelId = 'edit-change-model-clean-model-primary'
  const replacementModelId = 'edit-change-model-clean-model-secondary'

  await insertProjectFixture({connectionId, modelId: originalModelId, projectId})
  await insertAdditionalModelFixture({connectionId, modelId: replacementModelId})

  const response = await app.handle(
    new Request(`http://localhost/api/projects/${projectId}/edit`, {
      body: JSON.stringify({modelId: replacementModelId, name: 'Model Changed Project'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data?: {project?: {modelId?: string; name?: string}}; error?: string | null}

  expect(response.status).toBe(200)
  expect(body.data?.project?.modelId).toBe(replacementModelId)
  expect(body.data?.project?.name).toBe('Model Changed Project')

  const [storedProject] = await queryDatabase<{modelId: string; name: string}>(`
    SELECT model_id AS modelId, name
    FROM app.project
    WHERE id = '${projectId}'
    LIMIT 1
  `)

  expect(storedProject).toEqual({modelId: replacementModelId, name: 'Model Changed Project'})

  await flushMartRefreshes()
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
