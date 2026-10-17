import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('figure-description-model-config')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type DatabaseService = {
  close: () => Promise<void>
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

type Dependencies = {
  database: DatabaseService
  environment: typeof import('../../fullText/fullTextStrategyEnvironment.ts')
  resolver: typeof import('../../fullText/fullTextStrategyResolver.ts')
  service: typeof import('../userConfigQueryService.ts').userConfigQueryService
  usersRoutes: {handle: (request: Request) => Promise<Response>}
}

const dependencies: {current: Dependencies | null} = {current: null}

const getDependencies = (): Dependencies => {
  if (!dependencies.current) {
    throw new Error('Test dependencies not initialized')
  }

  return dependencies.current
}

const imageDiscoveryMetadata = (supportsImageInput: boolean) => {
  return JSON.stringify({discovery: {capabilities: {supportsImageInput}}})
}

const seedConnection = async ({
  enabled = true,
  id,
  providerKind,
}: {
  enabled?: boolean
  id: string
  providerKind: string
}) => {
  await getDependencies().database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${id}', '${providerKind}', '${id}', ${enabled ? 'TRUE' : 'FALSE'}, 'none', 'http://127.0.0.1:9/v1')
  `)
}

const seedModel = async ({
  connectionId,
  enabled = true,
  id,
  metadataJson = null,
  remoteModelId = id,
}: {
  connectionId: string
  enabled?: boolean
  id: string
  metadataJson?: string | null
  remoteModelId?: string
}) => {
  await getDependencies().database.run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, metadata_json)
    VALUES (
      '${id}', '${connectionId}', '${id}', '${remoteModelId}', '${id}', 'manual', ${enabled ? 'TRUE' : 'FALSE'},
      ${metadataJson ? `CAST('${metadataJson}' AS JSON)` : 'NULL'}
    )
  `)
}

const patchUsers = async (figureDescriptionModelId: string | null | undefined) => {
  const user = await getDependencies().service.getOrCreateUserConfig()

  return getDependencies().usersRoutes.handle(
    new Request('http://localhost/api/users', {
      body: JSON.stringify({
        codexBin: null,
        duckdbBin: null,
        email: user.email,
        ...(figureDescriptionModelId === undefined ? {} : {figureDescriptionModelId}),
        fullTextConversionModelId: null,
        maintenanceWorkerDuckdbMemoryLimit: null,
        name: user.name,
        unpaywallEmail: null,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../../db/migrateDuckdb.ts'),
      import('../appDatabaseService.ts'),
      import('../../utils/duckdbService.ts'),
      import('../../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  dependencies.current = {
    database: getAppDatabaseService(),
    environment: await import('../../fullText/fullTextStrategyEnvironment.ts'),
    resolver: await import('../../fullText/fullTextStrategyResolver.ts'),
    service: (await import('../userConfigQueryService.ts')).userConfigQueryService,
    usersRoutes: (await import('../../routes/UsersRoutes.ts')).usersRoutes,
  }

  await seedConnection({id: 'llama', providerKind: 'llamacpp'})
  await seedConnection({id: 'llama-off', enabled: false, providerKind: 'llamacpp'})
  await seedConnection({id: 'codex', providerKind: 'codex'})
  await seedConnection({id: 'anthropic', providerKind: 'anthropic'})
  await seedConnection({id: 'docling', providerKind: 'docling'})
  await seedModel({connectionId: 'llama', id: 'vlm-discovered', metadataJson: imageDiscoveryMetadata(true)})
  await seedModel({connectionId: 'llama', id: 'text-discovered', metadataJson: imageDiscoveryMetadata(false)})
  await seedModel({connectionId: 'llama', id: 'text-unknown'})
  await seedModel({
    connectionId: 'llama',
    id: 'vlm-user-override',
    metadataJson: JSON.stringify({
      capabilityOverrides: {supportsImageInput: true, updatedAt: '2026-10-17T00:00:00.000Z'},
      discovery: {capabilities: {supportsImageInput: false}},
    }),
  })
  await seedModel({
    connectionId: 'llama',
    id: 'vlm-user-off',
    metadataJson: JSON.stringify({
      capabilityOverrides: {supportsImageInput: false, updatedAt: '2026-10-17T00:00:00.000Z'},
      discovery: {capabilities: {supportsImageInput: true}},
    }),
  })
  await seedModel({
    connectionId: 'llama',
    enabled: false,
    id: 'vlm-disabled',
    metadataJson: imageDiscoveryMetadata(true),
  })
  await seedModel({connectionId: 'llama-off', id: 'vlm-connection-off', metadataJson: imageDiscoveryMetadata(true)})
  await seedModel({connectionId: 'codex', id: 'codex-gpt-5.5', remoteModelId: 'gpt-5.5'})
  await seedModel({connectionId: 'codex', id: 'codex-spark', remoteModelId: 'gpt-5.3-codex-spark'})
  await seedModel({connectionId: 'anthropic', id: 'anthropic-sonnet', remoteModelId: 'claude-sonnet-5-5'})
  await seedModel({connectionId: 'docling', id: 'docling-standard', metadataJson: imageDiscoveryMetadata(true)})
})

afterAll(async () => {
  await dependencies.current?.database.close()
  tempRuntimeRoot.cleanup()
})

test('figure-description model options list only enabled image-capable models on image transports', async () => {
  const options = await getDependencies().service.listFigureDescriptionModelOptions()

  expect(
    options.map((option) => {
      return [option.id, option.capabilitySource]
    }),
  ).toEqual([
    ['anthropic-sonnet', 'shipped'],
    ['codex-gpt-5.5', 'shipped'],
    ['vlm-discovered', 'discovery'],
    ['vlm-user-override', 'user'],
  ])
})

test('GET /api/users/figure-description-models returns the same options', async () => {
  const response = await getDependencies().usersRoutes.handle(
    new Request('http://localhost/api/users/figure-description-models'),
  )
  const body = (await response.json()) as {data: Array<{id: string; label: string; providerKind: string}>}

  expect(response.status).toBe(200)
  expect(
    body.data.map((option) => {
      return [option.id, option.label, option.providerKind]
    }),
  ).toEqual([
    ['anthropic-sonnet', 'anthropic-sonnet (anthropic)', 'anthropic'],
    ['codex-gpt-5.5', 'codex-gpt-5.5 (codex)', 'codex'],
    ['vlm-discovered', 'vlm-discovered (llama)', 'llamacpp'],
    ['vlm-user-override', 'vlm-user-override (llama)', 'llamacpp'],
  ])
})

test('saving refuses models that cannot receive images and keeps None explicit', async () => {
  const refused = await Promise.all(
    ['text-discovered', 'text-unknown', 'vlm-user-off', 'vlm-disabled', 'codex-spark', 'docling-standard'].map(
      async (modelId) => {
        return (await patchUsers(modelId)).status
      },
    ),
  )

  expect(
    refused.every((status) => {
      return status >= 400
    }),
  ).toBe(true)
  expect(await getDependencies().service.getFigureDescriptionModelConfig()).toBeNull()
  expect((await getDependencies().environment.getFullTextStrategyEnvironment()).figureDescription).toBeNull()
})

test('a saved image-capable model fills the strategy environment and the resolver accepts Descriptions', async () => {
  const saved = await patchUsers('vlm-discovered')
  const savedBody = (await saved.json()) as {data: {figureDescriptionModelId: string | null}}

  expect(saved.status).toBe(200)
  expect(savedBody.data.figureDescriptionModelId).toBe('vlm-discovered')
  expect(await getDependencies().service.getFigureDescriptionModelConfig()).toEqual({
    modelId: 'vlm-discovered',
    modelLabel: 'vlm-discovered (llama)',
    providerConnectionId: 'llama',
    providerKind: 'llamacpp',
  })

  const environment = await getDependencies().environment.getFullTextStrategyEnvironment()
  const {fullTextStrategyErrorMessages, resolveFullTextStrategy} = getDependencies().resolver
  const resolution = resolveFullTextStrategy(
    {chunkPolicy: {maxPromptTokens: 48_000, mode: 'single_only'}, figureMode: 'descriptions'},
    environment,
  )

  expect(environment.figureDescription).toEqual({modelId: 'vlm-discovered', promptVersion: 'fig-desc-v1'})
  expect(environment.imageTransportVersion).toBe('img-v1')
  expect(resolution.errors).not.toContain(fullTextStrategyErrorMessages.figureDescriptionModelMissing)

  const omitted = await patchUsers(undefined)
  const omittedBody = (await omitted.json()) as {data: {figureDescriptionModelId: string | null}}

  expect(omittedBody.data.figureDescriptionModelId).toBe('vlm-discovered')
})

test('a configured model that loses image input is no longer the figure-description model', async () => {
  await getDependencies().database.run(`
    UPDATE app.model
    SET metadata_json = CAST('${imageDiscoveryMetadata(false)}' AS JSON)
    WHERE id = 'vlm-discovered'
  `)

  expect(await getDependencies().service.getFigureDescriptionModelConfig()).toBeNull()
  expect((await getDependencies().environment.getFullTextStrategyEnvironment()).figureDescription).toBeNull()

  const cleared = await patchUsers(null)
  const clearedBody = (await cleared.json()) as {data: {figureDescriptionModelId: string | null}}

  expect(clearedBody.data.figureDescriptionModelId).toBeNull()
})
