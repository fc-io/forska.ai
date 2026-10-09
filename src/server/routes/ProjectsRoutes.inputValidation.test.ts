import {afterAll, beforeAll, expect, mock, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('projects-routes-input-validation')
const appReadOnlyDatabaseServiceModulePath = new URL('../services/appReadOnlyDatabaseService.ts', import.meta.url).href

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const connectionId = 'input-validation-connection'
const modelId = 'input-validation-model'
const existingProjectId = 'input-validation-existing-project'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let testReadOnlyDatabase: {queryJson: <T>(statement: string) => Promise<T[]>} | null = null

const registerModuleMocks = () => {
  void mock.module(appReadOnlyDatabaseServiceModulePath, () => {
    const getTestReadOnlyDatabase = () => {
      if (!testReadOnlyDatabase) {
        throw new Error('Test read-only database not initialized')
      }

      return testReadOnlyDatabase
    }

    return {
      closeAppReadOnlyDatabaseServices: async () => {},
      getApiReadOnlyAppDatabaseService: getTestReadOnlyDatabase,
      getJudgeWorkerReadOnlyAppDatabaseService: getTestReadOnlyDatabase,
    }
  })
}

const requestJson = async (path: string, method: 'PATCH' | 'POST', body: Record<string, unknown>) => {
  if (!app) {
    throw new Error('Test app not initialized')
  }

  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      body: JSON.stringify(body),
      headers: {'content-type': 'application/json'},
      method,
    }),
  )

  return {status: response.status, text: await response.text()}
}

const countProjectsNamed = async (name: string) => {
  if (!queryDatabase) {
    throw new Error('Database not initialized')
  }

  const [row] = await queryDatabase<{total: number | bigint}>(`
    SELECT COUNT(*) AS total
    FROM app.project
    WHERE name = '${name}'
  `)

  return Number(row?.total ?? 0)
}

beforeAll(async () => {
  registerModuleMocks()

  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()
  testReadOnlyDatabase = database
  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = (statement) => {
    return database.queryJson(statement)
  }
  runDatabase = (statement) => {
    return database.run(statement)
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
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, archived)
    VALUES ('${existingProjectId}', 'Input validation existing project', '${modelId}', TRUE, TRUE, FALSE, FALSE, FALSE)
  `)

  const {projectsRoutes} = await import('./ProjectsRoutes.ts')

  app = new Elysia().use(projectsRoutes)
})

afterAll(async () => {
  await closeDatabase?.()
  testReadOnlyDatabase = null
  tempRuntimeRoot.cleanup()
  mock.restore()
})

test('create route returns 400 when date_from is after date_to', async () => {
  const response = await requestJson('/api/projects', 'POST', {
    dateFrom: '2026-02-01',
    dateTo: '2026-01-01',
    modelId,
    name: 'Reversed date range project',
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('date_from must be on or before date_to')
})

test('create route returns 400 for an unparseable date', async () => {
  const response = await requestJson('/api/projects', 'POST', {
    dateFrom: 'not-a-date',
    modelId,
    name: 'Unparseable date project',
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('Invalid date value provided')
})

test('create route returns 400 when both full text modes are enabled', async () => {
  const response = await requestJson('/api/projects', 'POST', {
    modelId,
    name: 'Both full text modes project',
    useFulltext: true,
    useFulltextNoImages: true,
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('Cannot enable both')
})

test('create route returns 400 for a model that does not exist', async () => {
  const response = await requestJson('/api/projects', 'POST', {modelId: 'missing-model', name: 'Missing model project'})

  expect(response.status).toBe(400)
  expect(response.text).toContain('Selected model does not exist or is disabled')
})

test('create route returns 400 for an unknown import route and rolls the project insert back', async () => {
  const response = await requestJson('/api/projects', 'POST', {
    importRoutes: ['covidence:does-not-exist'],
    modelId,
    name: 'Unknown import route project',
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('One or more selected import routes are invalid')
  expect(await countProjectsNamed('Unknown import route project')).toBe(0)
})

test('create route returns 400 for an existing prompt id that does not exist', async () => {
  const response = await requestJson('/api/projects', 'POST', {
    existingPromptIds: [{order: 0, originalId: 'missing-prompt'}],
    modelId,
    name: 'Missing existing prompt project',
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('Existing prompt not found: missing-prompt')
  expect(await countProjectsNamed('Missing existing prompt project')).toBe(0)
})

test('edit route returns 400 when date_from is after date_to', async () => {
  const response = await requestJson(`/api/projects/${existingProjectId}/edit`, 'PATCH', {
    dateFrom: '2026-02-01',
    dateTo: '2026-01-01',
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('date_from must be on or before date_to')
})

test('edit route returns 400 for a model that does not exist', async () => {
  const response = await requestJson(`/api/projects/${existingProjectId}/edit`, 'PATCH', {modelId: 'missing-model'})

  expect(response.status).toBe(400)
  expect(response.text).toContain('Selected model does not exist or is disabled')
})

test('edit route returns 400 when both full text modes are enabled', async () => {
  const response = await requestJson(`/api/projects/${existingProjectId}/edit`, 'PATCH', {
    useFulltext: true,
    useFulltextNoImages: true,
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('Cannot enable both')
})

test('edit route returns 400 for a prompt original id that does not exist', async () => {
  const response = await requestJson(`/api/projects/${existingProjectId}/edit`, 'PATCH', {
    prompts: [{enabled: true, order: 0, originalId: 'missing-prompt', originalText: 'Does the study report X?'}],
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('Prompt not found: missing-prompt')
})

test('edit route returns 400 for an unknown import route', async () => {
  const response = await requestJson(`/api/projects/${existingProjectId}/edit`, 'PATCH', {
    importRoutes: ['covidence:does-not-exist'],
  })

  expect(response.status).toBe(400)
  expect(response.text).toContain('One or more selected import routes are invalid')
})
