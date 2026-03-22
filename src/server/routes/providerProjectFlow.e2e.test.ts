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
