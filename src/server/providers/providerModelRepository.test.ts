import {afterAll, beforeAll, expect, test} from 'bun:test'
import {rmSync} from 'fs'

const tempDbPath = `/tmp/f1-provider-model-repository-upsert-${process.pid}-${Date.now()}.duckdb`

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let upsertDiscoveredModels: typeof import('./providerModelRepository.ts').upsertDiscoveredModels

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
  upsertDiscoveredModels = repository.upsertDiscoveredModels
})

afterAll(async () => {
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
})

test('upsertDiscoveredModels persists discovered models through the transaction path', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, config_json)
    VALUES (
      'upsert-connection',
      'llmstudio',
      'LM Studio',
      TRUE,
      'none',
      CAST('{"archived":false,"disabledModelIds":[],"manualWorkerUrls":[],"workerUrlMode":"manual"}' AS JSON)
    )
  `)

  const savedModels = await upsertDiscoveredModels({
    connection: {
      authMode: 'none',
      baseURL: 'http://127.0.0.1:8080/v1',
      config: {disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
      createdAt: null,
      enabled: true,
      hasSecret: false,
      id: 'upsert-connection',
      label: 'LM Studio',
      lastCheckedAt: null,
      lastError: null,
      maxInflightRequests: null,
      providerKind: 'llmstudio',
      secretRef: null,
      updatedAt: null,
    },
    models: [
      {
        displayName: 'Qwen3-4B-Q4_K_M',
        metadataJson: {id: 'Qwen3-4B-Q4_K_M'},
        modelName: 'Qwen3-4B-Q4_K_M',
        remoteModelId: 'Qwen3-4B-Q4_K_M',
        variant: null,
        version: null,
      },
    ],
  })

  const storedModels = await queryDatabase<{
    displayName: string
    providerConnectionId: string
    remoteModelId: string
    source: string
  }>(`
    SELECT
      display_name AS displayName,
      provider_connection_id AS providerConnectionId,
      remote_model_id AS remoteModelId,
      source
    FROM app.model
    WHERE provider_connection_id = 'upsert-connection'
  `)

  expect(savedModels).toHaveLength(1)
  expect(savedModels[0]).toMatchObject({
    displayName: 'Qwen3-4B-Q4_K_M',
    providerConnectionId: 'upsert-connection',
    remoteModelId: 'Qwen3-4B-Q4_K_M',
  })
  expect(storedModels).toEqual([
    {
      displayName: 'Qwen3-4B-Q4_K_M',
      providerConnectionId: 'upsert-connection',
      remoteModelId: 'Qwen3-4B-Q4_K_M',
      source: 'discovered',
    },
  ])
})

test('upsertDiscoveredModels preserves stored model options when refreshing discovery metadata', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, config_json)
    VALUES (
      'upsert-qwen-connection',
      'sglang',
      'SGLang',
      TRUE,
      'none',
      CAST('{"archived":false,"disabledModelIds":[],"manualWorkerUrls":[],"workerUrlMode":"manual"}' AS JSON)
    )
  `)
  await runDatabase(`
    INSERT INTO app.model (
      id,
      provider_connection_id,
      name,
      remote_model_id,
      display_name,
      variant,
      source,
      enabled,
      metadata_json
    )
    VALUES (
      'legacy-qwen-model',
      'upsert-qwen-connection',
      'Qwen/Qwen3.5-27B',
      'Qwen/Qwen3.5-27B',
      'Qwen/Qwen3.5-27B',
      NULL,
      'manual',
      TRUE,
      CAST('{"options":{"thinking":"enabled"}}' AS JSON)
    )
  `)

  const savedModels = await upsertDiscoveredModels({
    connection: {
      authMode: 'none',
      baseURL: 'http://127.0.0.1:30001/v1',
      config: {disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
      createdAt: null,
      enabled: true,
      hasSecret: false,
      id: 'upsert-qwen-connection',
      label: 'SGLang',
      lastCheckedAt: null,
      lastError: null,
      maxInflightRequests: null,
      providerKind: 'sglang',
      secretRef: null,
      updatedAt: null,
    },
    models: [
      {
        displayName: 'Qwen/Qwen3.5-27B',
        metadataJson: {id: 'Qwen/Qwen3.5-27B'},
        modelName: 'Qwen/Qwen3.5-27B',
        remoteModelId: 'Qwen/Qwen3.5-27B',
        variant: null,
        version: null,
      },
    ],
  })

  const storedModels = await queryDatabase<{
    id: string
    metadataJson: string
    remoteModelId: string
    source: string
    variant: string | null
  }>(`
    SELECT
      id,
      TO_JSON(metadata_json) AS metadataJson,
      remote_model_id AS remoteModelId,
      source,
      variant
    FROM app.model
    WHERE provider_connection_id = 'upsert-qwen-connection'
  `)
  const [storedModel] = storedModels
  const parsedMetadata = storedModel ? (JSON.parse(storedModel.metadataJson) as Record<string, unknown>) : null

  expect(savedModels).toHaveLength(1)
  expect(storedModel).toMatchObject({
    id: 'legacy-qwen-model',
    remoteModelId: 'Qwen/Qwen3.5-27B',
    source: 'discovered',
    variant: null,
  })
  expect(parsedMetadata?.options).toEqual({thinking: 'enabled'})
})
