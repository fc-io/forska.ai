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

test('updateProviderModel disables a referenced model without rewriting unchanged variant', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  await insertProviderModelFixture({
    connectionId: 'atomic-referenced-toggle-connection',
    modelId: 'atomic-referenced-toggle-model',
  })
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('atomic-referenced-toggle-project', 'Referenced Toggle Project', 'atomic-referenced-toggle-model')
  `)

  const updated = await updateProviderModel({
    displayName: 'OpenRouter Test Model',
    enabled: false,
    id: 'atomic-referenced-toggle-model',
    variant: null,
  })

  const [storedModel] = await queryDatabase<{enabled: boolean}>(`
    SELECT enabled
    FROM app.model
    WHERE id = 'atomic-referenced-toggle-model'
    LIMIT 1
  `)
  const [storedConnection] = await queryDatabase<{configJson: string}>(`
    SELECT TO_JSON(config_json) AS configJson
    FROM app.provider_connection
    WHERE id = 'atomic-referenced-toggle-connection'
    LIMIT 1
  `)

  expect(updated.enabled).toBe(false)
  expect(storedModel?.enabled).toBe(false)
  expect(JSON.parse(storedConnection?.configJson ?? '{}')).toMatchObject({
    disabledModelIds: ['atomic-referenced-toggle-model'],
  })
})

test('updateProviderModel re-enables model row and removes provider config disabled id', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  await insertProviderModelFixture({connectionId: 'atomic-enable-connection', modelId: 'atomic-enable-model'})
  await runDatabase(`
    UPDATE app.model
    SET enabled = FALSE
    WHERE id = 'atomic-enable-model'
  `)
  await runDatabase(`
    UPDATE app.provider_connection
    SET config_json = CAST('{"archived":false,"disabledModelIds":["atomic-enable-model"],"manualWorkerUrls":[],"workerUrlMode":"manual"}' AS JSON)
    WHERE id = 'atomic-enable-connection'
  `)

  const updated = await updateProviderModel({
    displayName: 'OpenRouter Test Model',
    enabled: true,
    id: 'atomic-enable-model',
    variant: null,
  })

  const [storedModel] = await queryDatabase<{enabled: boolean}>(`
    SELECT enabled
    FROM app.model
    WHERE id = 'atomic-enable-model'
    LIMIT 1
  `)
  const [storedConnection] = await queryDatabase<{configJson: string}>(`
    SELECT TO_JSON(config_json) AS configJson
    FROM app.provider_connection
    WHERE id = 'atomic-enable-connection'
    LIMIT 1
  `)

  expect(updated.enabled).toBe(true)
  expect(storedModel?.enabled).toBe(true)
  expect(JSON.parse(storedConnection?.configJson ?? '{}')).toMatchObject({disabledModelIds: []})
})

test('updateProviderModel updates a model referenced by projects and judgments', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  await insertProviderModelFixture({connectionId: 'referenced-update-connection', modelId: 'referenced-update-model'})
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('referenced-update-project', 'Referenced Update Project', 'referenced-update-model')
  `)
  await runDatabase(`
    INSERT INTO app.article (id, article_title)
    VALUES ('referenced-update-article', 'Referenced Update Article')
  `)
  await runDatabase(`
    INSERT INTO app.prompt (id, original_text)
    VALUES ('referenced-update-prompt', 'Include?')
  `)
  await runDatabase(`
    INSERT INTO app.judgment (id, article_id, prompt_id, model_id)
    VALUES (
      'referenced-update-judgment',
      'referenced-update-article',
      'referenced-update-prompt',
      'referenced-update-model'
    )
  `)

  const updated = await updateProviderModel({
    displayName: 'Updated Referenced Model',
    enabled: true,
    id: 'referenced-update-model',
    options: {thinking: 'high'},
    variant: null,
  })
  const [storedModel] = await queryDatabase<{displayName: string; thinking: string | null}>(`
    SELECT
      display_name AS displayName,
      json_extract_string(metadata_json, '$.options.thinking') AS thinking
    FROM app.model
    WHERE id = 'referenced-update-model'
    LIMIT 1
  `)

  expect(updated.displayName).toBe('Updated Referenced Model')
  expect(storedModel).toEqual({displayName: 'Updated Referenced Model', thinking: 'high'})
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
