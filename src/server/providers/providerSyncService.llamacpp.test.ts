import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('provider-sync-llamacpp-window')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const llamaState: {propsReportsContext: boolean} = {propsReportsContext: true}

const state: {
  database: {
    close: () => Promise<void>
    queryJson: <T>(statement: string) => Promise<T[]>
    run: (statement: string) => Promise<void>
  } | null
  llamaServer: ReturnType<typeof globalThis.Bun.serve> | null
  sync: typeof import('./providerSyncService.ts') | null
} = {database: null, llamaServer: null, sync: null}

const getState = () => {
  if (!state.database || !state.sync || !state.llamaServer) {
    throw new Error('Test dependencies not initialized')
  }

  return {database: state.database, llamaServer: state.llamaServer, sync: state.sync}
}

const getLlamaServerResponse = (request: Request): Response => {
  const {pathname} = new URL(request.url)
  const props = llamaState.propsReportsContext
    ? {default_generation_settings: {n_ctx: 8192}, modalities: {vision: false}, total_slots: 4}
    : {modalities: {vision: false}, total_slots: 4}

  return pathname === '/v1/models'
    ? Response.json({
        data: [{id: 'qwen2.5-1.5b-instruct', meta: {n_ctx_train: 32768}, object: 'model', owned_by: 'llamacpp'}],
        object: 'list',
      })
    : pathname === '/props'
      ? Response.json(props)
      : new Response('not found', {status: 404})
}

const getRejectionMessage = async (promise: Promise<unknown>): Promise<string | null> => {
  return promise.then(
    () => {
      return null
    },
    (error: unknown) => {
      return error instanceof Error ? error.message : String(error)
    },
  )
}

const getModelRow = async () => {
  const [row] = await getState().database.queryJson<{metadataJson: string; updatedAt: string}>(`
    SELECT CAST(metadata_json AS VARCHAR) AS metadataJson, CAST(updated_at AS VARCHAR) AS updatedAt
    FROM app.model
    WHERE id = 'llama-qwen'
  `)

  return row
}

const getResolvedContextWindow = async () => {
  const {resolveProviderModelCapabilities} = await import('./providerModelCapabilities.ts')
  const row = await getModelRow()
  const contextWindow = resolveProviderModelCapabilities({
    metadataJson: JSON.parse(row?.metadataJson ?? 'null'),
    providerKind: 'llamacpp',
    remoteModelId: 'qwen2.5-1.5b-instruct',
  }).contextWindow

  return contextWindow ? {inputTokens: contextWindow.inputTokens, source: contextWindow.source} : null
}

const getConnectionCheckState = async () => {
  const [row] = await getState().database.queryJson<{lastCheckedAt: string | null; lastError: string | null}>(`
    SELECT CAST(last_checked_at AS VARCHAR) AS lastCheckedAt, last_error AS lastError
    FROM app.provider_connection
    WHERE id = 'llama-connection'
  `)

  return row
}

beforeAll(async () => {
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

  state.database = getAppDatabaseService()
  state.sync = await import('./providerSyncService.ts')
  state.llamaServer = globalThis.Bun.serve({fetch: getLlamaServerResponse, port: 0})

  await state.database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url, config_json)
    VALUES (
      'llama-connection',
      'llamacpp',
      'llama.cpp',
      TRUE,
      'none',
      'http://127.0.0.1:${state.llamaServer.port}/v1',
      CAST('{"archived":false,"disabledModelIds":[],"llamaCppMode":"server","manualWorkerUrls":[],"workerUrlMode":"manual"}' AS JSON)
    );

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, variant, source, enabled, metadata_json)
    VALUES (
      'llama-qwen',
      'llama-connection',
      'qwen2.5-1.5b-instruct',
      'qwen2.5-1.5b-instruct',
      'qwen2.5-1.5b-instruct',
      NULL,
      'discovered',
      TRUE,
      CAST('{"discovery":{"capabilities":{"reasoningEfforts":[]},"contextWindow":{"inputTokens":32768,"outputTokens":null,"totalTokens":32768},"providerKind":"llamacpp","source":"provider"},"options":{}}' AS JSON)
    );

    INSERT INTO app.project (id, name, model_id) VALUES ('llama-project', 'llama.cpp project', 'llama-qwen');
  `)
})

afterAll(async () => {
  await state.llamaServer?.stop(true)
  await state.database?.close()
  tempRuntimeRoot.cleanup()
})

test('re-sync replaces the trained 32,768-token window with the per-slot n_ctx from /props', async () => {
  const {sync} = getState()

  expect(await getResolvedContextWindow()).toEqual({inputTokens: 32768, source: 'discovery'})

  await sync.syncProviderConnectionModelsById('llama-connection')

  expect(await getResolvedContextWindow()).toEqual({inputTokens: 8192, source: 'discovery'})
  expect((await getConnectionCheckState())?.lastError).toBeNull()
})

test('a re-sync whose /props has no n_ctx fails, records the error on the connection and leaves the model row as is', async () => {
  const {sync} = getState()
  const before = await getModelRow()

  llamaState.propsReportsContext = false
  expect(await getRejectionMessage(sync.syncProviderConnectionModelsById('llama-connection'))).toContain(
    '/props did not report default_generation_settings.n_ctx',
  )
  llamaState.propsReportsContext = true

  const checkState = await getConnectionCheckState()

  expect(checkState?.lastError).toStartWith(`llama.cpp http://127.0.0.1:${getState().llamaServer.port}/props`)
  expect(checkState?.lastCheckedAt).not.toBeNull()
  expect(await getModelRow()).toEqual(before)
})

test('a re-sync against a stopped server fails, records the error and keeps the last synced window', async () => {
  const {llamaServer, sync} = getState()

  await sync.syncProviderConnectionModelsById('llama-connection')
  const before = await getModelRow()
  await llamaServer.stop(true)

  expect(await getRejectionMessage(sync.syncProviderConnectionModelsById('llama-connection'))).not.toBeNull()
  expect((await getConnectionCheckState())?.lastError).not.toBeNull()
  expect((await getModelRow())?.metadataJson).toBe(before?.metadataJson)
  expect(await getResolvedContextWindow()).toEqual({inputTokens: 8192, source: 'discovery'})
})
