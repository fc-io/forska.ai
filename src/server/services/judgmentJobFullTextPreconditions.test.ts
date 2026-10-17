import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import type {FullTextPreconditionModel} from './judgmentJobFullTextPreconditions.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('judgment-job-full-text-preconditions')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type Dependencies = {
  database: {close: () => Promise<void>; run: (statement: string) => Promise<void>}
  preconditions: typeof import('./judgmentJobFullTextPreconditions.ts')
  service: typeof import('./userConfigQueryService.ts').userConfigQueryService
  usersRoutes: {handle: (request: Request) => Promise<Response>}
}

const dependencies: {current: Dependencies | null} = {current: null}

const getDependencies = (): Dependencies => {
  if (!dependencies.current) {
    throw new Error('Test dependencies not initialized')
  }

  return dependencies.current
}

const baseInputs = {
  canonicalTextVersion: 'canonical-v1',
  converterKind: 'mineru',
  converterOptionsHash: 'options',
  converterVersion: '4.0.12',
  imageTransportVersion: null,
  promptLayoutVersion: 'layout-v2',
  tokenizerId: 'o200k_base',
}

const seedStrategy = async (id: string, inputs: Record<string, unknown>) => {
  await getDependencies().database.run(`
    INSERT INTO app.full_text_strategy (id, label, inputs)
    VALUES ('${id}', '${id}', '${JSON.stringify({...baseInputs, ...inputs})}'::JSON)
  `)
}

const judgeModelMetadata = {
  capabilityOverrides: {contextWindow: {inputTokens: 32_000}, updatedAt: '2026-10-17T00:00:00.000Z'},
}

const visionModelMetadata = {discovery: {capabilities: {supportsImageInput: true}}}

const getModel = (modelName: string, metadataJson: unknown): FullTextPreconditionModel => {
  return {
    model: {metadataJson, providerKind: 'llamacpp', remoteModelId: modelName},
    modelName,
    providerConnectionId: 'llama',
  }
}

const models = {'judge-32k': getModel('judge-32k', judgeModelMetadata), 'vlm-a': getModel('vlm-a', visionModelMetadata)}

const seedModel = async (id: string, metadataJson: unknown) => {
  await getDependencies().database.run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, metadata_json)
    VALUES ('${id}', 'llama', '${id}', '${id}', '${id}', 'manual', TRUE, '${JSON.stringify(metadataJson)}'::JSON)
  `)
}

const setFigureDescriptionModel = async (figureDescriptionModelId: string | null) => {
  const user = await getDependencies().service.getOrCreateUserConfig()
  const response = await getDependencies().usersRoutes.handle(
    new Request('http://localhost/api/users', {
      body: JSON.stringify({
        codexBin: null,
        duckdbBin: null,
        email: user.email,
        figureDescriptionModelId,
        fullTextConversionModelId: null,
        maintenanceWorkerDuckdbMemoryLimit: null,
        name: user.name,
        unpaywallEmail: null,
      }),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )

  expect(response.status).toBe(200)
}

const stringContaining = (text: string): string => {
  return expect.stringContaining(text) as unknown as string
}

const getError = (fullTextStrategyId: string, modelId: keyof typeof models = 'judge-32k') => {
  return getDependencies().preconditions.getFullTextJudgingPreconditionError({
    fullTextStrategyId,
    model: models[modelId],
  })
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('./appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  dependencies.current = {
    database: getAppDatabaseService(),
    preconditions: await import('./judgmentJobFullTextPreconditions.ts'),
    service: (await import('./userConfigQueryService.ts')).userConfigQueryService,
    usersRoutes: (await import('../routes/UsersRoutes.ts')).usersRoutes,
  }

  await getDependencies().database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('llama', 'llamacpp', 'llama', TRUE, 'none', 'http://127.0.0.1:9/v1')
  `)
  await seedModel('vlm-a', visionModelMetadata)
  await seedModel('vlm-b', visionModelMetadata)
  await seedStrategy('fts-000000000000048a', {
    chunkPolicy: {maxPromptTokens: 48_000, mode: 'single_only'},
    figureDescriptionModelId: null,
    figureDescriptionPromptVersion: null,
    figureMode: 'none',
  })
  await seedStrategy('fts-000000000000024a', {
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'chunked'},
    figureDescriptionModelId: 'vlm-a',
    figureDescriptionPromptVersion: 'fig-desc-v1',
    figureMode: 'descriptions',
  })
  await seedStrategy('fts-0000000000000bad', {figureMode: 'none'})
  await seedStrategy('fts-00000000000img24', {
    chunkPolicy: {maxPromptTokens: 24_000, mode: 'single_only'},
    figureDescriptionModelId: null,
    figureDescriptionPromptVersion: null,
    figureMode: 'native_images',
    imageTransportVersion: 'img-v1',
  })
})

afterAll(async () => {
  await dependencies.current?.database.close()
  tempRuntimeRoot.cleanup()
})

test('no-full-text jobs pass and legacy or incomplete strategies are refused', async () => {
  expect(await getError('fts-none')).toBeNull()
  expect(await getError('fts-legacy-v0')).toEqual(stringContaining('Choose a figure mode and a chunk policy'))
  expect(await getError('fts-0000000000000bad')).toEqual(stringContaining('has no stored chunk policy and figure mode'))
  expect(await getError('fts-00000000000unknown')).toEqual(
    stringContaining('has no stored chunk policy and figure mode'),
  )
})

test('a model window smaller than the chunk policy is refused with both numbers', async () => {
  expect(await getError('fts-000000000000048a')).toEqual(
    stringContaining('judge-32k has a 32000-token input window, smaller than the project'),
  )
})

test('descriptions strategies need the installation figure-description model they were resolved with', async () => {
  await setFigureDescriptionModel(null)
  expect(await getError('fts-000000000000024a')).toEqual(stringContaining('no figure-description model is configured'))

  await setFigureDescriptionModel('vlm-b')
  expect(await getError('fts-000000000000024a')).toEqual(
    stringContaining("the installation's figure-description model is model vlm-b (fig-desc-v1)"),
  )

  await setFigureDescriptionModel('vlm-a')
  expect(await getError('fts-000000000000024a')).toBeNull()
})

test('native-images strategies need a model that accepts images', async () => {
  expect(await getError('fts-00000000000img24')).toEqual(stringContaining('Model judge-32k cannot receive images'))
  expect(await getError('fts-00000000000img24', 'vlm-a')).toBeNull()
})
