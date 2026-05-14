import {afterAll, beforeAll, expect, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-provider-connection-repository')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let deleteProviderConnection: typeof import('./providerConnectionRepository.ts').deleteProviderConnection

const insertProviderConnectionFixture = async ({connectionId, modelId}: {connectionId: string; modelId: string}) => {
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
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES (
      '${modelId}',
      '${connectionId}',
      'openrouter/test-model',
      'openrouter/test-model',
      'OpenRouter Test Model',
      'manual',
      TRUE
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
    import('./providerConnectionRepository.ts'),
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
  deleteProviderConnection = repository.deleteProviderConnection
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('deleteProviderConnection removes an unreferenced connection and its models in one transaction', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  await insertProviderConnectionFixture({connectionId: 'delete-connection', modelId: 'delete-model'})

  const result = await deleteProviderConnection('delete-connection')

  const [storedConnection] = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.provider_connection
    WHERE id = 'delete-connection'
    LIMIT 1
  `)
  const [storedModel] = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.model
    WHERE provider_connection_id = 'delete-connection'
    LIMIT 1
  `)
  const [orphanSummary] = await queryDatabase<{orphanModelCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS orphanModelCount
    FROM app.model m
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.provider_connection_id = 'delete-connection'
      AND pc.id IS NULL
  `)

  expect(result.archived).toBe(false)
  expect(result.deleted).toBe(true)
  expect(Number(result.deletedModelCount)).toBe(1)
  expect(storedConnection).toBeUndefined()
  expect(storedModel).toBeUndefined()
  expect(orphanSummary?.orphanModelCount).toBe(0)
})

test('deleteProviderConnection archives a referenced connection without orphaning provider_connection_id values', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  await insertProviderConnectionFixture({connectionId: 'archive-connection', modelId: 'archive-model'})
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('archive-project', 'Archive Project', 'archive-model')
  `)

  const result = await deleteProviderConnection('archive-connection')

  const [storedConnection] = await queryDatabase<{configJson: string; enabled: boolean; id: string}>(`
    SELECT
      id,
      enabled,
      TO_JSON(config_json) AS configJson
    FROM app.provider_connection
    WHERE id = 'archive-connection'
    LIMIT 1
  `)
  const [storedModel] = await queryDatabase<{enabled: boolean; providerConnectionId: string}>(`
    SELECT
      enabled,
      provider_connection_id AS providerConnectionId
    FROM app.model
    WHERE id = 'archive-model'
    LIMIT 1
  `)

  expect(result.archived).toBe(true)
  expect(result.deleted).toBe(false)
  expect(Number(result.deletedModelCount)).toBe(1)
  expect(Number(result.projectCount)).toBe(1)
  expect(storedConnection?.enabled).toBe(false)
  expect(JSON.parse(storedConnection?.configJson ?? '{}')).toMatchObject({archived: true})
  expect(storedModel).toEqual({enabled: false, providerConnectionId: 'archive-connection'})
})

test('deleteProviderConnection archives comparison-project-only model usage without orphaning models', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  await insertProviderConnectionFixture({
    connectionId: 'comparison-archive-connection',
    modelId: 'comparison-archive-model',
  })
  await runDatabase(`
    INSERT INTO app.comparison_project (id, name, model_ids, compare_with_humans, human_judgment_mode)
    VALUES ('comparison-archive-project', 'Comparison Archive Project', ['comparison-archive-model'], FALSE, 'prompt')
  `)

  const result = await deleteProviderConnection('comparison-archive-connection')

  const [storedConnection] = await queryDatabase<{configJson: string; enabled: boolean; id: string}>(`
    SELECT
      id,
      enabled,
      TO_JSON(config_json) AS configJson
    FROM app.provider_connection
    WHERE id = 'comparison-archive-connection'
    LIMIT 1
  `)
  const [storedModel] = await queryDatabase<{enabled: boolean; providerConnectionId: string}>(`
    SELECT
      enabled,
      provider_connection_id AS providerConnectionId
    FROM app.model
    WHERE id = 'comparison-archive-model'
    LIMIT 1
  `)
  const [orphanSummary] = await queryDatabase<{orphanModelCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS orphanModelCount
    FROM app.model m
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE m.provider_connection_id = 'comparison-archive-connection'
      AND pc.id IS NULL
  `)

  expect(result.archived).toBe(true)
  expect(result.deleted).toBe(false)
  expect(Number(result.comparisonProjectCount)).toBe(1)
  expect(Number(result.projectCount)).toBe(0)
  expect(Number(result.judgmentCount)).toBe(0)
  expect(storedConnection?.enabled).toBe(false)
  expect(JSON.parse(storedConnection?.configJson ?? '{}')).toMatchObject({archived: true})
  expect(storedModel).toEqual({enabled: false, providerConnectionId: 'comparison-archive-connection'})
  expect(orphanSummary?.orphanModelCount).toBe(0)
})

test('deleteProviderConnection rolls back unreferenced model cleanup when connection cleanup fails later', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  await insertProviderConnectionFixture({connectionId: 'rollback-delete-connection', modelId: 'rollback-delete-model'})

  const deleteError = await deleteProviderConnection('rollback-delete-connection', {
    afterModelCleanup: async () => {
      throw new Error('simulated delete failure')
    },
  })
    .then(() => {
      return null
    })
    .catch((error: unknown) => {
      return error
    })

  const [storedConnection] = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.provider_connection
    WHERE id = 'rollback-delete-connection'
    LIMIT 1
  `)
  const [storedModel] = await queryDatabase<{providerConnectionId: string}>(`
    SELECT provider_connection_id AS providerConnectionId
    FROM app.model
    WHERE id = 'rollback-delete-model'
    LIMIT 1
  `)

  expect(deleteError).toBeInstanceOf(Error)
  expect((deleteError as Error | null)?.message).toContain('simulated delete failure')
  expect(storedConnection?.id).toBe('rollback-delete-connection')
  expect(storedModel?.providerConnectionId).toBe('rollback-delete-connection')
})

test('deleteProviderConnection rolls back archive writes when model archive cleanup fails later', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  await insertProviderConnectionFixture({
    connectionId: 'rollback-archive-connection',
    modelId: 'rollback-archive-model',
  })
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('rollback-archive-project', 'Rollback Archive Project', 'rollback-archive-model')
  `)

  const deleteError = await deleteProviderConnection('rollback-archive-connection', {
    afterModelCleanup: async () => {
      throw new Error('simulated archive failure')
    },
  })
    .then(() => {
      return null
    })
    .catch((error: unknown) => {
      return error
    })

  const [storedConnection] = await queryDatabase<{configJson: string; enabled: boolean}>(`
    SELECT
      enabled,
      TO_JSON(config_json) AS configJson
    FROM app.provider_connection
    WHERE id = 'rollback-archive-connection'
    LIMIT 1
  `)
  const [storedModel] = await queryDatabase<{enabled: boolean; providerConnectionId: string}>(`
    SELECT
      enabled,
      provider_connection_id AS providerConnectionId
    FROM app.model
    WHERE id = 'rollback-archive-model'
    LIMIT 1
  `)

  expect(deleteError).toBeInstanceOf(Error)
  expect((deleteError as Error | null)?.message).toContain('simulated archive failure')
  expect(storedConnection?.enabled).toBe(true)
  expect(JSON.parse(storedConnection?.configJson ?? '{}')).toMatchObject({archived: false})
  expect(storedModel).toEqual({enabled: true, providerConnectionId: 'rollback-archive-connection'})
})
