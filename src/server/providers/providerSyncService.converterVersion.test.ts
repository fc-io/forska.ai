import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Elysia} from 'elysia'

import {localUserDefaults} from '../../utils/localUser.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('provider-sync-converter-version')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type ConverterServer = ReturnType<typeof globalThis.Bun.serve>

const converterState = {doclingServeVersion: '1.37.0', mineruHealthy: true, mineruVersion: '4.0.12'}

const state: {
  app: {handle: (request: Request) => Promise<Response>} | null
  database: {
    close: () => Promise<void>
    queryJson: <T>(statement: string) => Promise<T[]>
    run: (statement: string) => Promise<void>
  } | null
  doclingServer: ConverterServer | null
  environment: typeof import('../fullText/fullTextStrategyEnvironment.ts') | null
  mineruServer: ConverterServer | null
  userConfig: typeof import('../services/userConfigQueryService.ts') | null
} = {app: null, database: null, doclingServer: null, environment: null, mineruServer: null, userConfig: null}

const getState = () => {
  if (!state.app || !state.database || !state.environment || !state.userConfig) {
    throw new Error('Test dependencies not initialized')
  }

  return {app: state.app, database: state.database, environment: state.environment, userConfig: state.userConfig}
}

const getMineruResponse = (request: Request): Response => {
  return new URL(request.url).pathname === '/v1/health' && converterState.mineruHealthy
    ? Response.json({status: 'ok', version: converterState.mineruVersion})
    : new Response('unavailable', {status: 503})
}

const getDoclingResponse = (request: Request): Response => {
  return new URL(request.url).pathname === '/version'
    ? Response.json({docling: '2.140.0', 'docling-serve': converterState.doclingServeVersion, python: '3.12'})
    : new Response('not found', {status: 404})
}

const postJson = async (path: string, body?: unknown): Promise<{body: unknown; status: number}> => {
  const response = await getState().app.handle(
    new Request(`http://localhost${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : {'content-type': 'application/json'},
      method: 'POST',
    }),
  )

  return {body: await response.json(), status: response.status}
}

const createConnection = async ({baseURL, providerKind}: {baseURL: string; providerKind: string}) => {
  const created = await postJson('/api/provider-connections', {baseURL, label: providerKind, providerKind})

  return (created.body as {data: {connection: {id: string}}}).data.connection.id
}

const syncConnection = async (connectionId: string) => {
  return postJson(`/api/provider-connections/${connectionId}/sync-models`)
}

const getSyncedModelId = (synced: {body: unknown}): string => {
  return (synced.body as {data: {models: {id: string}[]}}).data.models[0]?.id ?? ''
}

const selectConversionModel = async (modelId: string) => {
  await getState()
    .userConfig.getUserConfigQueryService()
    .updateUserConfig({
      email: localUserDefaults.email,
      fullTextConversionModelId: modelId,
      maintenanceWorkerDuckdbMemoryLimit: null,
      name: localUserDefaults.name,
      unpaywallEmail: null,
    })
}

const getStoredConverter = async (modelId: string) => {
  const [row] = await getState().database.queryJson<{metadataJson: string}>(
    `SELECT CAST(metadata_json AS VARCHAR) AS metadataJson FROM app.model WHERE id = '${modelId}'`,
  )

  return (JSON.parse(row?.metadataJson ?? 'null') as {converter?: unknown} | null)?.converter
}

const getConnectionCheckState = async (connectionId: string) => {
  const [row] = await getState().database.queryJson<{lastCheckedAt: string | null; lastError: string | null}>(`
    SELECT CAST(last_checked_at AS VARCHAR) AS lastCheckedAt, last_error AS lastError
    FROM app.provider_connection
    WHERE id = '${connectionId}'
  `)

  return row
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    {providerConnectionsRoutes},
    {providerModelsRoutes},
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('../services/appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('../routes/ProviderConnectionsRoutes.ts'),
    import('../routes/ProviderModelsRoutes.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  state.database = getAppDatabaseService()
  state.app = new Elysia().use(providerConnectionsRoutes).use(providerModelsRoutes)
  state.environment = await import('../fullText/fullTextStrategyEnvironment.ts')
  state.userConfig = await import('../services/userConfigQueryService.ts')
  state.mineruServer = globalThis.Bun.serve({fetch: getMineruResponse, port: 0})
  state.doclingServer = globalThis.Bun.serve({fetch: getDoclingResponse, port: 0})
})

afterAll(async () => {
  await state.mineruServer?.stop(true)
  await state.doclingServer?.stop(true)
  await state.database?.close()
  tempRuntimeRoot.cleanup()
})

test('a MinerU connection created and synced through the routes gives the full-text strategy its server version', async () => {
  const {environment} = getState()
  const connectionId = await createConnection({
    baseURL: `http://127.0.0.1:${state.mineruServer?.port}`,
    providerKind: 'mineru',
  })
  const synced = await syncConnection(connectionId)
  const modelId = getSyncedModelId(synced)

  await selectConversionModel(modelId)

  expect(synced.status).toBe(200)
  expect(await getStoredConverter(modelId)).toEqual({kind: 'mineru', serverVersion: '4.0.12', tier: 'standard'})
  expect((await environment.getFullTextStrategyEnvironment()).conversionModel).toMatchObject({
    converterKind: 'mineru',
    converterVersion: '4.0.12',
    modelLabel: 'MinerU standard',
  })

  converterState.mineruVersion = '4.0.13'
  await syncConnection(connectionId)

  expect((await environment.getFullTextStrategyEnvironment()).conversionModel?.converterVersion).toBe('4.0.13')

  converterState.mineruHealthy = false
  const failed = await syncConnection(connectionId)
  converterState.mineruHealthy = true

  expect(failed.status).toBe(400)
  expect((await getConnectionCheckState(connectionId))?.lastError).toStartWith('MinerU health check failed: 503')
  expect((await environment.getFullTextStrategyEnvironment()).conversionModel?.converterVersion).toBe('4.0.13')
})

test('a referenced Docling model keeps its converter block on re-sync and takes the new server version', async () => {
  const {database, environment} = getState()
  const connectionId = await createConnection({
    baseURL: `http://127.0.0.1:${state.doclingServer?.port}`,
    providerKind: 'docling',
  })
  const modelId = getSyncedModelId(await syncConnection(connectionId))

  await selectConversionModel(modelId)
  await database.run(`INSERT INTO app.project (id, name, model_id) VALUES ('docling-project', 'Docling', '${modelId}')`)

  expect((await environment.getFullTextStrategyEnvironment()).conversionModel?.converterVersion).toBe(
    'docling=2.140.0 docling-serve=1.37.0',
  )

  converterState.doclingServeVersion = '1.38.0'
  const resynced = await syncConnection(connectionId)

  expect(getSyncedModelId(resynced)).toBe(modelId)
  expect(await getStoredConverter(modelId)).toEqual({
    kind: 'docling',
    pipeline: 'standard',
    serverVersion: 'docling=2.140.0 docling-serve=1.38.0',
  })
  expect((await environment.getFullTextStrategyEnvironment()).conversionModel?.converterVersion).toBe(
    'docling=2.140.0 docling-serve=1.38.0',
  )
})
