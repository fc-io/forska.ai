import {afterAll, beforeAll, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'
import {rmSync} from 'fs'

const tempDbPath = `/tmp/f1-provider-project-flow-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const martRefreshServiceModulePath = new URL('../services/getDuckdbMartRefreshService.ts', import.meta.url).pathname

void mock.module(martRefreshServiceModulePath, () => {
  return {
    getDuckdbMartRefreshService: () => {
      return {
        queueProjectRefresh: async (_projectId: string, _source: string) => {
          return undefined
        },
      }
    },
  }
})

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: ((statement: string) => Promise<Array<{modelId: string}>>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {providerConnectionsRoutes},
    {providerModelsRoutes},
    {projectsRoutes},
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('./ProviderConnectionsRoutes.ts'),
    import('./ProviderModelsRoutes.ts'),
    import('./ProjectsRoutes.ts'),
  ])

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
  app = new Elysia().use(providerConnectionsRoutes).use(providerModelsRoutes).use(projectsRoutes)
})

afterAll(async () => {
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
})

test('provider to model to project flow works through routes', async () => {
  if (!app || !queryDatabase) {
    throw new Error('Test app not initialized')
  }

  const createConnectionResponse = await app.handle(
    new Request('http://localhost/api/provider-connections', {
      body: JSON.stringify({baseURL: 'http://127.0.0.1:1234/v1', label: 'LM Studio', providerKind: 'llmstudio'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const createConnectionBody = (await createConnectionResponse.json()) as {data: {connection: {id: string}}}

  expect(createConnectionResponse.status).toBe(200)

  const connectionId = createConnectionBody.data.connection.id
  const addModelResponse = await app.handle(
    new Request(`http://localhost/api/provider-connections/${connectionId}/models`, {
      body: JSON.stringify({displayName: 'Local Model', remoteModelId: 'local-model'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const addModelBody = (await addModelResponse.json()) as {data: {modelId: string}}

  expect(addModelResponse.status).toBe(200)

  const modelId = addModelBody.data.modelId
  const createProjectResponse = await app.handle(
    new Request('http://localhost/api/projects', {
      body: JSON.stringify({modelId, name: 'Provider Flow Project'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const createProjectBody = (await createProjectResponse.json()) as {data: {id: string; modelId: string}}

  expect(createProjectResponse.status).toBe(200)
  expect(createProjectBody.data.modelId).toBe(modelId)

  const [storedProject] = await queryDatabase(`
    SELECT model_id AS modelId
    FROM app.project
    WHERE id = '${createProjectBody.data.id}'
    LIMIT 1
  `)

  expect(storedProject?.modelId).toBe(modelId)
})

test('provider connections list consolidates duplicate codex connections', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES
      ('codex-connection-1', 'codex', 'GPT-5.3-Codex-Spark (thinking: low)', TRUE, 'codex-cli'),
      ('codex-connection-2', 'codex', 'GPT-5.3-Codex-Spark (thinking: high)', TRUE, 'codex-cli')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES
      ('codex-model-1', 'codex-connection-1', 'GPT-5.3-Codex-Spark (thinking: low)', 'gpt-5.3-codex-spark', 'GPT-5.3-Codex-Spark (thinking: low)', 'manual', TRUE),
      ('codex-model-2', 'codex-connection-2', 'GPT-5.3-Codex-Spark (thinking: high)', 'gpt-5.3-codex-spark', 'GPT-5.3-Codex-Spark (thinking: high)', 'manual', TRUE)
  `)

  const response = await app.handle(new Request('http://localhost/api/provider-connections'))
  const body = (await response.json()) as {
    data: {connections: Array<{id: string; label: string; models: Array<{id: string}>; providerKind: string}>}
  }

  expect(response.status).toBe(200)

  const codexConnections = body.data.connections.filter((connection) => {
    return connection.providerKind === 'codex'
  })
  const consolidatedConnection = codexConnections[0]

  expect(codexConnections).toHaveLength(1)
  expect(consolidatedConnection?.label).toBe('Codex App')
  expect(
    consolidatedConnection?.models
      .map((model) => {
        return model.id
      })
      .sort(),
  ).toEqual(['codex-model-1', 'codex-model-2'])

  const storedConnectionsWithModels = await queryDatabase(`
    SELECT id AS modelId
    FROM app.provider_connection
    WHERE provider_kind = 'codex'
      AND EXISTS (
        SELECT 1
        FROM app.model m
        WHERE m.provider_connection_id = app.provider_connection.id
      )
    ORDER BY id ASC
  `)
  const storedModels = await queryDatabase(`
    SELECT provider_connection_id AS modelId
    FROM app.model
    WHERE id IN ('codex-model-1', 'codex-model-2')
    ORDER BY id ASC
  `)

  expect(
    storedConnectionsWithModels.map((row) => {
      return row.modelId
    }),
  ).toEqual(['codex-connection-1', 'codex-connection-2'])
  expect(
    storedModels.map((row) => {
      return row.modelId
    }),
  ).toEqual(['codex-connection-1', 'codex-connection-2'])
})
