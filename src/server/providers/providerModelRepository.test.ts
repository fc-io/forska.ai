import {afterAll, beforeAll, expect, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-provider-model-repository-upsert')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let createProviderModel: typeof import('./providerModelRepository.ts').createProviderModel
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
  createProviderModel = repository.createProviderModel
  upsertDiscoveredModels = repository.upsertDiscoveredModels
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
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

test('createProviderModel reuses an existing provider remote variant natural key', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, config_json)
    VALUES (
      'create-natural-key-connection',
      'openrouter',
      'OpenRouter',
      TRUE,
      'api-key',
      CAST('{"archived":false,"disabledModelIds":[],"manualWorkerUrls":[],"workerUrlMode":"manual"}' AS JSON)
    )
  `)

  const connection = {
    authMode: 'api-key' as const,
    baseURL: 'https://openrouter.ai/api/v1',
    config: {disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual' as const},
    createdAt: null,
    enabled: true,
    hasSecret: true,
    id: 'create-natural-key-connection',
    label: 'OpenRouter',
    lastCheckedAt: null,
    lastError: null,
    maxInflightRequests: null,
    providerKind: 'openrouter',
    secretRef: 'secret:test',
    updatedAt: null,
  }
  const firstModel = await createProviderModel({
    connection,
    displayName: 'Manual Duplicate Model',
    metadataJson: {},
    modelName: 'manual/duplicate',
    remoteModelId: 'manual/duplicate',
    source: 'manual',
    variant: null,
    version: null,
  })
  const secondModel = await createProviderModel({
    connection,
    displayName: 'Manual Duplicate Model',
    metadataJson: {},
    modelName: 'manual/duplicate',
    remoteModelId: 'manual/duplicate',
    source: 'manual',
    variant: null,
    version: null,
  })
  const [row] = await queryDatabase<{rowCount: number}>(`
    SELECT COUNT(*) AS rowCount
    FROM app.model
    WHERE provider_connection_id = 'create-natural-key-connection'
      AND remote_model_id = 'manual/duplicate'
  `)

  expect(secondModel.id).toBe(firstModel.id)
  expect(Number(row?.rowCount ?? 0)).toBe(1)
})

test('createProviderModel reuses an existing empty variant model for null variant input', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, config_json)
    VALUES (
      'create-empty-variant-connection',
      'openrouter',
      'OpenRouter Empty Variant',
      TRUE,
      'api-key',
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
      'empty-variant-model',
      'create-empty-variant-connection',
      'Manual Empty Variant Model',
      'manual/empty-variant',
      'Manual Empty Variant Model',
      '',
      'manual',
      TRUE,
      '{}'::JSON
    )
  `)

  const model = await createProviderModel({
    connection: {
      authMode: 'api-key',
      baseURL: 'https://openrouter.ai/api/v1',
      config: {disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
      createdAt: null,
      enabled: true,
      hasSecret: true,
      id: 'create-empty-variant-connection',
      label: 'OpenRouter Empty Variant',
      lastCheckedAt: null,
      lastError: null,
      maxInflightRequests: null,
      providerKind: 'openrouter',
      secretRef: 'secret:test',
      updatedAt: null,
    },
    displayName: 'Manual Empty Variant Model',
    metadataJson: {},
    modelName: 'manual/empty-variant',
    remoteModelId: 'manual/empty-variant',
    source: 'manual',
    variant: null,
    version: null,
  })
  const [row] = await queryDatabase<{rowCount: number}>(`
    SELECT COUNT(*) AS rowCount
    FROM app.model
    WHERE provider_connection_id = 'create-empty-variant-connection'
      AND remote_model_id = 'manual/empty-variant'
  `)

  expect(model.id).toBe('empty-variant-model')
  expect(Number(row?.rowCount ?? 0)).toBe(1)
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

test('upsertDiscoveredModels refreshes a referenced discovered model without replacing its id', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, config_json)
    VALUES (
      'upsert-anthropic-connection',
      'anthropic',
      'Anthropic',
      TRUE,
      'api-key',
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
      'anthropic-discovered-model',
      'upsert-anthropic-connection',
      'Claude Opus 4.7',
      'claude-opus-4-7',
      'Claude Opus 4.7',
      NULL,
      'discovered',
      TRUE,
      CAST('{"discovery":{"providerKind":"anthropic"}}' AS JSON)
    )
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('anthropic-project', 'Anthropic Project', 'anthropic-discovered-model')
  `)

  const savedModels = await upsertDiscoveredModels({
    connection: {
      authMode: 'api-key',
      baseURL: 'https://api.anthropic.com/v1',
      config: {disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
      createdAt: null,
      enabled: true,
      hasSecret: true,
      id: 'upsert-anthropic-connection',
      label: 'Anthropic',
      lastCheckedAt: null,
      lastError: null,
      maxInflightRequests: null,
      providerKind: 'anthropic',
      secretRef: 'secret:test',
      updatedAt: null,
    },
    models: [
      {
        displayName: 'Claude Opus 4.7',
        metadataJson: {id: 'claude-opus-4-7'},
        modelName: 'claude-opus-4-7',
        remoteModelId: 'claude-opus-4-7',
        variant: null,
        version: null,
      },
    ],
  })

  const storedModels = await queryDatabase<{
    id: string
    modelName: string
    projectModelId: string
    source: string
    updatedAt: string | null
  }>(`
    SELECT
      m.id AS id,
      m.remote_model_id AS modelName,
      p.model_id AS projectModelId,
      m.source AS source,
      CAST(m.updated_at AS VARCHAR) AS updatedAt
    FROM app.model m
    INNER JOIN app.project p ON p.id = 'anthropic-project'
    WHERE m.provider_connection_id = 'upsert-anthropic-connection'
  `)
  const [storedModel] = storedModels

  expect(savedModels).toHaveLength(1)
  expect(savedModels[0]?.id).toBe('anthropic-discovered-model')
  expect(storedModel).toMatchObject({
    id: 'anthropic-discovered-model',
    modelName: 'claude-opus-4-7',
    projectModelId: 'anthropic-discovered-model',
    source: 'discovered',
  })
  expect(storedModel?.updatedAt).not.toBeNull()
})
