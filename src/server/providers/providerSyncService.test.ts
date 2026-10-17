import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('provider-sync-discovery-refresh')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const ollamaCapabilitiesByModel: Record<string, string[]> = {
  'qwen2.5:1.5b': ['completion', 'tools'],
  'qwen3-vl:2b-instruct': ['completion', 'vision'],
}

const state: {
  database: {
    close: () => Promise<void>
    queryJson: <T>(statement: string) => Promise<T[]>
    run: (statement: string) => Promise<void>
  } | null
  ollamaServer: {port: number; stop: (force?: boolean) => void} | null
  sync: typeof import('./providerSyncService.ts') | null
} = {database: null, ollamaServer: null, sync: null}

const getState = () => {
  if (!state.database || !state.sync) {
    throw new Error('Test dependencies not initialized')
  }

  return {database: state.database, sync: state.sync}
}

const getOllamaResponse = async (request: Request): Promise<Response> => {
  const {pathname} = new URL(request.url)

  if (pathname === '/api/tags') {
    return Response.json({
      models: Object.keys(ollamaCapabilitiesByModel).map((model) => {
        return {model, name: model}
      }),
    })
  }

  if (pathname === '/api/show') {
    const {model} = (await request.json()) as {model: string}

    return Response.json({
      capabilities: ollamaCapabilitiesByModel[model] ?? [],
      model_info: {'qwen2.context_length': 32768},
    })
  }

  return new Response('not found', {status: 404})
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
  state.ollamaServer = globalThis.Bun.serve({fetch: getOllamaResponse, port: 0})

  await state.database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url, config_json)
    VALUES (
      'ollama-connection',
      'ollama',
      'Ollama',
      TRUE,
      'none',
      'http://127.0.0.1:${state.ollamaServer.port}/v1',
      CAST('{"archived":false,"disabledModelIds":[],"manualWorkerUrls":[],"workerUrlMode":"manual"}' AS JSON)
    );

    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, variant, source, enabled, metadata_json)
    VALUES (
      'ollama-qwen25',
      'ollama-connection',
      'Qwen 2.5 local',
      'qwen2.5:1.5b',
      'Qwen 2.5 local',
      NULL,
      'discovered',
      TRUE,
      CAST('{"discovery":{"capabilities":{"reasoningEfforts":[]},"providerKind":"ollama","source":"provider"},"options":{},"capabilityOverrides":{"contextWindow":{"inputTokens":16000,"totalTokens":16000},"updatedAt":"2026-10-17T08:00:00.000Z"}}' AS JSON)
    );

    INSERT INTO app.project (id, name, model_id) VALUES ('ollama-project', 'Ollama project', 'ollama-qwen25');
  `)
})

afterAll(async () => {
  state.ollamaServer?.stop(true)
  await state.database?.close()
  tempRuntimeRoot.cleanup()
})

test('re-sync refreshes discovery capabilities of a referenced Ollama model and keeps its id, name and user overrides', async () => {
  const {database, sync} = getState()
  const {resolveProviderModelCapabilities} = await import('./providerModelCapabilities.ts')

  await sync.syncProviderConnectionModelsById('ollama-connection')

  const rows = await database.queryJson<{
    displayName: string
    id: string
    metadataJson: string
    projectModelId: string
    remoteModelId: string
  }>(`
    SELECT
      m.id,
      m.display_name AS displayName,
      m.remote_model_id AS remoteModelId,
      CAST(m.metadata_json AS VARCHAR) AS metadataJson,
      (SELECT p.model_id FROM app.project p WHERE p.id = 'ollama-project') AS projectModelId
    FROM app.model m
    WHERE m.provider_connection_id = 'ollama-connection'
    ORDER BY m.remote_model_id
  `)
  const capabilities = rows.map((row) => {
    const resolved = resolveProviderModelCapabilities({
      metadataJson: JSON.parse(row.metadataJson),
      providerKind: 'ollama',
      remoteModelId: row.remoteModelId,
    })

    return {
      contextWindow: resolved.contextWindow
        ? {inputTokens: resolved.contextWindow.inputTokens, source: resolved.contextWindow.source}
        : null,
      remoteModelId: row.remoteModelId,
      supportsImageInput: resolved.supportsImageInput
        ? {source: resolved.supportsImageInput.source, value: resolved.supportsImageInput.value}
        : null,
    }
  })

  expect(
    rows.map(({displayName, id, projectModelId, remoteModelId}) => {
      return {displayName, id: remoteModelId === 'qwen2.5:1.5b' ? id : 'new', projectModelId}
    }),
  ).toEqual([
    {displayName: 'Qwen 2.5 local', id: 'ollama-qwen25', projectModelId: 'ollama-qwen25'},
    {displayName: 'qwen3-vl:2b-instruct', id: 'new', projectModelId: 'ollama-qwen25'},
  ])
  expect(capabilities).toEqual([
    {
      contextWindow: {inputTokens: 16000, source: 'user'},
      remoteModelId: 'qwen2.5:1.5b',
      supportsImageInput: {source: 'discovery', value: false},
    },
    {
      contextWindow: {inputTokens: 32768, source: 'discovery'},
      remoteModelId: 'qwen3-vl:2b-instruct',
      supportsImageInput: {source: 'discovery', value: true},
    },
  ])
  expect((JSON.parse(rows[0]?.metadataJson ?? 'null') as {capabilityOverrides?: unknown}).capabilityOverrides).toEqual({
    contextWindow: {inputTokens: 16000, totalTokens: 16000},
    updatedAt: '2026-10-17T08:00:00.000Z',
  })
})

test('a second re-sync with unchanged discovery leaves the referenced row untouched', async () => {
  const {database, sync} = getState()
  const readUpdatedAt = async () => {
    const [row] = await database.queryJson<{updatedAt: string}>(
      `SELECT CAST(updated_at AS VARCHAR) AS updatedAt FROM app.model WHERE id = 'ollama-qwen25'`,
    )

    return row?.updatedAt
  }
  const before = await readUpdatedAt()

  await sync.syncProviderConnectionModelsById('ollama-connection')

  expect(await readUpdatedAt()).toBe(before)
})
