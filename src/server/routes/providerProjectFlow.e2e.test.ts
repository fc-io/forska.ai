import {afterAll, beforeAll, expect, test} from 'bun:test'
import {Elysia} from 'elysia'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-provider-project-flow')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let app: {handle: (request: Request) => Promise<Response>} | null = null
let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {providerConnectionsRoutes},
    {providerModelsRoutes},
    {projectsRoutes},
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('./ProviderConnectionsRoutes.ts'),
    import('./ProviderModelsRoutes.ts'),
    import('./ProjectsRoutes.ts'),
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
  app = new Elysia().use(providerConnectionsRoutes).use(providerModelsRoutes).use(projectsRoutes)
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
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
      body: JSON.stringify({modelId, name: 'Provider Flow Project', prompts: ['Screen for relevance']}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const createProjectBody = (await createProjectResponse.json()) as {data: {id: string; modelId: string}}

  expect(createProjectResponse.status).toBe(200)
  expect(createProjectBody.data.modelId).toBe(modelId)

  const [storedProject] = await queryDatabase<{modelId: string}>(`
    SELECT model_id AS modelId
    FROM app.project
    WHERE id = '${createProjectBody.data.id}'
    LIMIT 1
  `)
  const [storedProjectPrompt] = await queryDatabase<{originalText: string}>(`
    SELECT p.original_text AS originalText
    FROM app.project_prompt pp
    INNER JOIN app.prompt p ON p.id = pp.prompt_id
    WHERE pp.project_id = '${createProjectBody.data.id}'
    LIMIT 1
  `)

  expect(storedProject?.modelId).toBe(modelId)
  expect(storedProjectPrompt?.originalText).toBe('Screen for relevance')
})

test('provider connection patch updates a referenced connection', async () => {
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

  expect(addModelResponse.status).toBe(200)

  const patchConnectionResponse = await app.handle(
    new Request(`http://localhost/api/provider-connections/${connectionId}`, {
      body: JSON.stringify({
        baseURL: 'http://127.0.0.1:4321/v1',
        enabled: true,
        label: 'LM Studio Updated',
        manualWorkerUrls: [],
        maxInflightRequests: 4,
        workerUrlMode: 'manual',
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const patchConnectionBody = (await patchConnectionResponse.json()) as {
    data: {connection: {baseURL: string | null; label: string; maxInflightRequests: number | null}}
  }

  expect(patchConnectionResponse.status).toBe(200)
  expect(patchConnectionBody.data.connection.label).toBe('LM Studio Updated')
  expect(patchConnectionBody.data.connection.baseURL).toBe('http://127.0.0.1:4321/v1')
  expect(patchConnectionBody.data.connection.maxInflightRequests).toBe(4)

  const [storedConnection] = await queryDatabase<{
    baseURL: string | null
    label: string
    maxInflightRequests: number | null
  }>(`
    SELECT
      base_url AS baseURL,
      label,
      max_inflight_requests AS maxInflightRequests
    FROM app.provider_connection
    WHERE id = '${connectionId}'
    LIMIT 1
  `)

  expect(storedConnection).toEqual({
    baseURL: 'http://127.0.0.1:4321/v1',
    label: 'LM Studio Updated',
    maxInflightRequests: 4,
  })
})

test('llama.cpp cli provider connection stores cli mode and uses the local default base URL', async () => {
  if (!app || !queryDatabase) {
    throw new Error('Test app not initialized')
  }

  const createConnectionResponse = await app.handle(
    new Request('http://localhost/api/provider-connections', {
      body: JSON.stringify({label: 'Local llama.cpp CLI', llamaCppMode: 'cli', providerKind: 'llamacpp'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const createConnectionBody = (await createConnectionResponse.json()) as {
    data: {
      connection: {
        authMode: string | null
        baseURL: string | null
        config: {
          archived?: boolean
          disabledModelIds?: string[]
          llamaCppMode?: 'cli' | 'server'
          manualWorkerUrls: string[]
          workerUrlMode: 'manual' | 'runtime'
        }
        id: string
        providerKind: string
        workerState: {
          effectiveWorkerUrls: string[]
          match: {
            candidate: {
              localUrls: string[]
              modelNames: string[]
              reason:
                | 'manual-mode'
                | 'manual-base-url'
                | 'manual-provider'
                | 'manual-worker-url'
                | 'runtime-base-url-overlap'
                | 'no-saved-url'
                | 'runtime-auto-detect'
                | 'runtime-model-overlap'
                | 'runtime-provider-mismatch'
                | 'runtime-provider-missing'
                | 'runtime-url-conflict'
                | 'runtime-url-missing'
                | 'runtime-worker-url-overlap'
                | 'runtime-worker-missing'
              remoteUrls: string[]
              sourceMetadata: {
                cluster: string | null
                jobId: string | null
                kind: 'launcher' | 'local'
                label: string
                sshJumpHost: string | null
              } | null
              source: 'detected-runtime' | 'saved-base-url' | 'saved-manual-worker'
              status: 'available' | 'matched' | 'unavailable'
            } | null
            detectedModelNames: string[]
            effectiveBaseURL: string | null
            effectiveWorkerUrls: string[]
            localUrls: string[]
            modelNames: string[]
            reason:
              | 'manual-mode'
              | 'manual-base-url'
              | 'manual-provider'
              | 'manual-worker-url'
              | 'runtime-base-url-overlap'
              | 'no-saved-url'
              | 'runtime-auto-detect'
              | 'runtime-model-overlap'
              | 'runtime-provider-mismatch'
              | 'runtime-provider-missing'
              | 'runtime-url-conflict'
              | 'runtime-url-missing'
              | 'runtime-worker-url-overlap'
              | 'runtime-worker-missing'
            reasons: string[]
            remoteUrls: string[]
            resolutionMode: 'auto-detect' | 'manual'
            sourceMetadata: {
              cluster: string | null
              jobId: string | null
              kind: 'launcher' | 'local'
              label: string
              sshJumpHost: string | null
            } | null
            source: 'detected-runtime' | 'none' | 'saved-base-url' | 'saved-manual-worker'
            status: 'ambiguous' | 'manual-only' | 'matched' | 'unreachable'
          }
          resolutionMode: 'auto-detect' | 'manual'
          runtimeWorkerUrls: string[]
          workerSource: 'manual' | 'none' | 'runtime'
        }
      }
    }
  }

  expect(createConnectionResponse.status).toBe(200)
  expect(createConnectionBody.data.connection.providerKind).toBe('llamacpp')
  expect(createConnectionBody.data.connection.baseURL).toBe('http://127.0.0.1:8080')
  expect(createConnectionBody.data.connection.authMode).toBe('none')
  expect(createConnectionBody.data.connection.config).toEqual({
    archived: false,
    disabledModelIds: [],
    llamaCppMode: 'cli',
    manualWorkerUrls: [],
    workerUrlMode: 'manual',
  })
  expect(createConnectionBody.data.connection.workerState).toEqual({
    effectiveWorkerUrls: [],
    match: {
      candidate: {
        localUrls: [],
        modelNames: [],
        reason: 'manual-base-url',
        remoteUrls: ['http://127.0.0.1:8080'],
        sourceMetadata: null,
        source: 'saved-base-url',
        status: 'matched',
      },
      detectedModelNames: [],
      effectiveBaseURL: 'http://127.0.0.1:8080',
      effectiveWorkerUrls: [],
      localUrls: [],
      modelNames: [],
      reason: 'manual-base-url',
      reasons: ['manual-mode', 'manual-base-url'],
      remoteUrls: ['http://127.0.0.1:8080'],
      resolutionMode: 'manual',
      sourceMetadata: null,
      source: 'saved-base-url',
      status: 'manual-only',
    },
    resolutionMode: 'manual',
    runtimeWorkerUrls: [],
    workerSource: 'none',
  })

  const connectionId = createConnectionBody.data.connection.id
  const [storedConnection] = await queryDatabase<{
    authMode: string | null
    baseURL: string | null
    configJson: string | null
    maxInflightRequests: number | null
    providerKind: string
  }>(`
    SELECT
      auth_mode AS authMode,
      base_url AS baseURL,
      CAST(config_json AS VARCHAR) AS configJson,
      max_inflight_requests AS maxInflightRequests,
      provider_kind AS providerKind
    FROM app.provider_connection
    WHERE id = '${connectionId}'
    LIMIT 1
  `)

  expect({...storedConnection, configJson: storedConnection?.configJson ? JSON.parse(storedConnection.configJson) : null}).toEqual({
    authMode: 'none',
    baseURL: 'http://127.0.0.1:8080',
    configJson: {
      archived: false,
      disabledModelIds: [],
      llamaCppMode: 'cli',
      manualWorkerUrls: [],
      workerUrlMode: 'manual',
    },
    maxInflightRequests: null,
    providerKind: 'llamacpp',
  })
})

test('llama.cpp server provider connection keeps the local default base URL without extra config', async () => {
  if (!app || !queryDatabase) {
    throw new Error('Test app not initialized')
  }

  const createConnectionResponse = await app.handle(
    new Request('http://localhost/api/provider-connections', {
      body: JSON.stringify({label: 'Local llama.cpp Server', llamaCppMode: 'server', providerKind: 'llamacpp'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const createConnectionBody = (await createConnectionResponse.json()) as {
    data: {
      connection: {
        authMode: string | null
        baseURL: string | null
        config: {
          archived?: boolean
          disabledModelIds?: string[]
          llamaCppMode?: 'cli' | 'server'
          manualWorkerUrls: string[]
          workerUrlMode: 'manual' | 'runtime'
        }
        id: string
        providerKind: string
      }
    }
  }

  expect(createConnectionResponse.status).toBe(200)
  expect(createConnectionBody.data.connection.providerKind).toBe('llamacpp')
  expect(createConnectionBody.data.connection.baseURL).toBe('http://127.0.0.1:8080')
  expect(createConnectionBody.data.connection.config).toEqual({
    archived: false,
    disabledModelIds: [],
    manualWorkerUrls: [],
    workerUrlMode: 'manual',
  })

  const connectionId = createConnectionBody.data.connection.id
  const [storedConnection] = await queryDatabase<{configJson: string | null}>(`
    SELECT CAST(config_json AS VARCHAR) AS configJson
    FROM app.provider_connection
    WHERE id = '${connectionId}'
    LIMIT 1
  `)

  expect(storedConnection?.configJson).toBeNull()
})

test('provider connection delete removes an unreferenced connection and its models', async () => {
  if (!app || !queryDatabase) {
    throw new Error('Test app not initialized')
  }

  const createConnectionResponse = await app.handle(
    new Request('http://localhost/api/provider-connections', {
      body: JSON.stringify({baseURL: 'http://127.0.0.1:1234/v1', label: 'Delete Me', providerKind: 'llmstudio'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const createConnectionBody = (await createConnectionResponse.json()) as {data: {connection: {id: string}}}

  expect(createConnectionResponse.status).toBe(200)

  const connectionId = createConnectionBody.data.connection.id
  const addModelResponse = await app.handle(
    new Request(`http://localhost/api/provider-connections/${connectionId}/models`, {
      body: JSON.stringify({displayName: 'Delete Model', remoteModelId: 'delete-model'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )

  expect(addModelResponse.status).toBe(200)

  const deleteConnectionResponse = await app.handle(
    new Request(`http://localhost/api/provider-connections/${connectionId}`, {method: 'DELETE'}),
  )
  const deleteConnectionBody = (await deleteConnectionResponse.json()) as {
    data: {deleted: boolean; deletedModelCount: number}
  }

  expect(deleteConnectionResponse.status).toBe(200)
  expect(deleteConnectionBody.data.deleted).toBe(true)
  expect(Number(deleteConnectionBody.data.deletedModelCount)).toBe(1)

  const [storedConnection] = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.provider_connection
    WHERE id = '${connectionId}'
    LIMIT 1
  `)
  const [storedModel] = await queryDatabase<{id: string}>(`
    SELECT id
    FROM app.model
    WHERE provider_connection_id = '${connectionId}'
    LIMIT 1
  `)

  expect(storedConnection).toBeUndefined()
  expect(storedModel).toBeUndefined()
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

  const storedConnectionsWithModels = await queryDatabase<{modelId: string}>(`
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
  const storedModels = await queryDatabase<{modelId: string}>(`
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

test('singleton codex delete is blocked when any codex model is still referenced', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES
      ('codex-delete-connection-1', 'codex', 'Codex low', TRUE, 'codex-cli'),
      ('codex-delete-connection-2', 'codex', 'Codex high', TRUE, 'codex-cli')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES
      ('codex-delete-model-1', 'codex-delete-connection-1', 'gpt-5.4 (thinking: low)', 'gpt-5.4', 'gpt-5.4 (thinking: low)', 'manual', TRUE),
      ('codex-delete-model-2', 'codex-delete-connection-2', 'gpt-5.4 (thinking: high)', 'gpt-5.4', 'gpt-5.4 (thinking: high)', 'manual', TRUE)
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('delete-project-1', 'Project using codex', 'codex-delete-model-2')
  `)
  const [visibleCodexModelCount] = await queryDatabase<{count: number}>(`
    SELECT COUNT(*) AS count
    FROM app.model m
    INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE pc.provider_kind = 'codex'
      AND COALESCE(pc.enabled, TRUE) = TRUE
  `)

  const response = await app.handle(
    new Request('http://localhost/api/provider-connections/codex-delete-connection-1', {method: 'DELETE'}),
  )
  const body = (await response.json()) as {data: {archived: boolean; deleted: boolean; deletedModelCount: number}}

  expect(response.status).toBe(200)
  expect(body.data.archived).toBe(true)
  expect(body.data.deleted).toBe(false)
  expect(body.data.deletedModelCount).toBe(visibleCodexModelCount?.count ?? 0)

  const remainingConnections = await queryDatabase<{enabled: boolean; id: string}>(`
    SELECT id, enabled
    FROM app.provider_connection
    WHERE provider_kind = 'codex'
      AND id IN ('codex-delete-connection-1', 'codex-delete-connection-2')
    ORDER BY id ASC
  `)
  const remainingModels = await queryDatabase<{enabled: boolean; id: string}>(`
    SELECT id, enabled
    FROM app.model
    WHERE provider_connection_id IN ('codex-delete-connection-1', 'codex-delete-connection-2')
    ORDER BY id ASC
  `)

  expect(
    remainingConnections.map((row) => {
      return row.id
    }),
  ).toEqual(['codex-delete-connection-1', 'codex-delete-connection-2'])
  expect(
    remainingConnections.map((row) => {
      return row.enabled
    }),
  ).toEqual([false, false])
  expect(
    remainingModels.map((row) => {
      return row.id
    }),
  ).toEqual(['codex-delete-model-1', 'codex-delete-model-2'])
  expect(
    remainingModels.map((row) => {
      return row.enabled
    }),
  ).toEqual([false, false])
})

test('referenced codex model toggle keeps model row and provider config in sync', async () => {
  if (!app || !queryDatabase || !runDatabase) {
    throw new Error('Test app not initialized')
  }

  await runDatabase(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('codex-model-toggle-connection', 'codex', 'Codex toggle', TRUE, 'codex-cli')
  `)
  await runDatabase(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant)
    VALUES (
      'codex-model-toggle-model',
      'codex-model-toggle-connection',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-max',
      'manual',
      TRUE,
      NULL
    )
  `)
  await runDatabase(`
    INSERT INTO app.project (id, name, model_id)
    VALUES ('codex-model-toggle-project', 'Project using codex model', 'codex-model-toggle-model')
  `)

  const response = await app.handle(
    new Request('http://localhost/api/models/codex-model-toggle-model', {
      body: JSON.stringify({displayName: 'gpt-5.1-codex-max', enabled: false}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {model: {enabled: boolean}}}

  expect(response.status).toBe(200)
  expect(body.data.model.enabled).toBe(false)

  const [storedModel] = await queryDatabase<{enabled: boolean}>(`
    SELECT enabled
    FROM app.model
    WHERE id = 'codex-model-toggle-model'
    LIMIT 1
  `)
  const [storedConnectionConfig] = await queryDatabase<{configJson: string | null}>(`
    SELECT CAST(config_json AS VARCHAR) AS configJson
    FROM app.provider_connection
    WHERE id = 'codex-model-toggle-connection'
    LIMIT 1
  `)

  expect(storedModel?.enabled).toBe(false)
  expect(storedConnectionConfig?.configJson).toContain('codex-model-toggle-model')
})
