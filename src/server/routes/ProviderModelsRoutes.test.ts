import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const providerConnectionRepositoryModulePath = new URL('../providers/providerConnectionRepository.ts', import.meta.url)
  .pathname
const providerModelRepositoryModulePath = new URL('../providers/providerModelRepository.ts', import.meta.url).pathname
const providerSyncServiceModulePath = new URL('../providers/providerSyncService.ts', import.meta.url).pathname

type ProviderModelsRoutesModule = typeof import('./ProviderModelsRoutes.ts')

const state = {
  createProviderModel: mock(async (_input: unknown) => {
    return {
      displayName: 'Manual Model',
      enabled: true,
      id: 'model-1',
      metadataJson: null,
      modelName: 'manual-model',
      name: 'Manual Model',
      provider: 'openrouter',
      providerConnectionId: 'connection-1',
      remoteModelId: 'manual-model',
      source: 'manual',
      variant: null,
      version: null,
    }
  }),
  getProviderConnection: mock(async (id: string) => {
    return id === 'missing'
      ? null
      : {
          authMode: 'api-key',
          baseURL: 'https://api.example.com/v1',
          config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
          createdAt: null,
          enabled: true,
          hasSecret: true,
          id,
          label: 'Provider Connection',
          lastCheckedAt: null,
          lastError: null,
          maxInflightRequests: null,
          providerKind: 'openrouter',
          secretRef: 'keychain:test',
          updatedAt: null,
        }
  }),
  queryJson: mock(async (_statement: string) => {
    return []
  }),
  syncProviderConnectionModels: mock(async (_connection: unknown) => {
    return {savedModels: [{id: 'model-2'}]}
  }),
  updateProviderModel: mock(async (_input: unknown) => {
    return {
      displayName: 'Updated Model',
      enabled: false,
      id: 'model-1',
      metadataJson: null,
      modelName: 'manual-model',
      name: 'Updated Model',
      provider: 'openrouter',
      providerConnectionId: 'connection-1',
      remoteModelId: 'manual-model',
      source: 'manual',
      variant: null,
      version: null,
    }
  }),
}

const registerModuleMocks = () => {
  void mock.module(providerConnectionRepositoryModulePath, () => {
    return {getProviderConnection: state.getProviderConnection}
  })

  void mock.module(providerModelRepositoryModulePath, () => {
    return {createProviderModel: state.createProviderModel, updateProviderModel: state.updateProviderModel}
  })

  void mock.module(providerSyncServiceModulePath, () => {
    return {syncProviderConnectionModels: state.syncProviderConnectionModels}
  })

  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: (statement: string) => {
            return state.queryJson(statement)
          },
        }
      },
    }
  })
}

const loadRoutes = async () => {
  registerModuleMocks()

  const {providerModelsRoutes} = (await import(
    `./ProviderModelsRoutes.ts?test=${Date.now()}-${Math.random()}`
  )) as ProviderModelsRoutesModule

  return new Elysia().use(providerModelsRoutes)
}

afterEach(() => {
  mock.restore()
})

test('provider models route syncs models for a connection', async () => {
  state.syncProviderConnectionModels.mockClear()
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-connections/connection-1/sync-models', {method: 'POST'}),
  )
  const body = (await response.json()) as {data: {count: number}}

  expect(response.status).toBe(200)
  expect(body.data.count).toBe(1)
  expect(state.syncProviderConnectionModels).toHaveBeenCalledTimes(1)
})

test('provider models route adds a manual model', async () => {
  state.createProviderModel.mockClear()
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-connections/connection-1/models', {
      body: JSON.stringify({displayName: 'Manual Model', remoteModelId: 'manual-model'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {modelId: string}}

  expect(response.status).toBe(200)
  expect(body.data.modelId).toBe('model-1')
  expect(state.createProviderModel).toHaveBeenCalledTimes(1)
})

test('provider models route updates model enabled state and label', async () => {
  state.updateProviderModel.mockClear()
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/models/model-1', {
      body: JSON.stringify({displayName: 'Updated Model', enabled: false}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const body = (await response.json()) as {data: {model: {displayName: string; enabled: boolean}}}

  expect(response.status).toBe(200)
  expect(body.data.model.displayName).toBe('Updated Model')
  expect(body.data.model.enabled).toBe(false)
  expect(state.updateProviderModel).toHaveBeenCalledTimes(1)
})
