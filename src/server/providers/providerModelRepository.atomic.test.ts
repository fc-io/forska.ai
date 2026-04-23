import {afterAll, beforeAll, expect, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-provider-model-repository')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let updateProviderModel: typeof import('./providerModelRepository.ts').updateProviderModel

const insertProviderModelFixture = async ({connectionId, modelId}: {connectionId: string; modelId: string}) => {
  if (!runDatabase) {
    throw new Error('Test database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, config_json)
    VALUES (
      '${connectionId}',
      'openrouter',
      'OpenRouter',
      TRUE,
      'api-key',
      CAST('{"archived":false,"disabledModelIds":[],"manualWorkerUrls":[],"workerUrlMode":"manual"}' AS JSON)
    )
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant)
    VALUES (
      '${modelId}',
      '${connectionId}',
      'openrouter/test-model',
      'openrouter/test-model',
      'OpenRouter Test Model',
      'manual',
      TRUE,
      NULL
    )
  `)
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    repository,
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('./providerModelRepository.ts'),
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
  updateProviderModel = repository.updateProviderModel
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('updateProviderModel disables model row and provider config in one transaction', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  await insertProviderModelFixture({connectionId: 'atomic-toggle-connection', modelId: 'atomic-toggle-model'})

  const updated = await updateProviderModel({
    displayName: 'OpenRouter Test Model',
    enabled: false,
    id: 'atomic-toggle-model',
    variant: null,
  })

  const [storedModel] = await queryDatabase<{enabled: boolean}>(`
    SELECT enabled
    FROM app.model
    WHERE id = 'atomic-toggle-model'
    LIMIT 1
  `)
  const [storedConnection] = await queryDatabase<{configJson: string}>(`
    SELECT TO_JSON(config_json) AS configJson
    FROM app.provider_connection
    WHERE id = 'atomic-toggle-connection'
    LIMIT 1
  `)

  expect(updated.enabled).toBe(false)
  expect(storedModel?.enabled).toBe(false)
  expect(JSON.parse(storedConnection?.configJson ?? '{}')).toMatchObject({disabledModelIds: ['atomic-toggle-model']})
})

test('updateProviderModel rolls back model enabled change when provider config write fails later', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  await insertProviderModelFixture({connectionId: 'atomic-failure-connection', modelId: 'atomic-failure-model'})

  const updateError = await updateProviderModel(
    {displayName: 'OpenRouter Test Model', enabled: false, id: 'atomic-failure-model', variant: null},
    {
      afterModelWrite: async () => {
        throw new Error('simulated provider config failure')
      },
    },
  )
    .then(() => {
      return null
    })
    .catch((error: unknown) => {
      return error
    })

  const [storedModel] = await queryDatabase<{enabled: boolean}>(`
    SELECT enabled
    FROM app.model
    WHERE id = 'atomic-failure-model'
    LIMIT 1
  `)
  const [storedConnection] = await queryDatabase<{configJson: string}>(`
    SELECT TO_JSON(config_json) AS configJson
    FROM app.provider_connection
    WHERE id = 'atomic-failure-connection'
    LIMIT 1
  `)

  expect(updateError).toBeInstanceOf(Error)
  expect((updateError as Error | null)?.message).toContain('simulated provider config failure')
  expect(storedModel?.enabled).toBe(true)
  expect(JSON.parse(storedConnection?.configJson ?? '{}')).toMatchObject({disabledModelIds: []})
})
