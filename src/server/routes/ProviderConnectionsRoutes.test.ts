import {expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const providerAuthServiceModulePath = new URL('../providers/providerAuthService.ts', import.meta.url).pathname
const providerConnectionHelpersModulePath = new URL('../providers/providerConnectionHelpers.ts', import.meta.url)
  .pathname
const providerConnectionRepositoryModulePath = new URL('../providers/providerConnectionRepository.ts', import.meta.url)
  .pathname
const providerHealthServiceModulePath = new URL('../providers/providerHealthService.ts', import.meta.url).pathname
const providerRegistryModulePath = new URL('../providers/providerRegistry.ts', import.meta.url).pathname
const providerSecretStoreModulePath = new URL('../providers/providerSecretStore.ts', import.meta.url).pathname
const providerCatalogModulePath = new URL('../services/providerCatalog.ts', import.meta.url).pathname

const state = {
  createProviderConnection: mock(async (input: unknown) => {
    return {
      ...(input as object),
      config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
      createdAt: null,
      enabled: true,
      hasSecret: false,
      id: 'connection-1',
      lastCheckedAt: null,
      lastError: null,
      secretRef: null,
      updatedAt: null,
    }
  }),
  beginProviderAuth: mock(async (_input: unknown) => {
    return {
      connection: null,
      message: 'Provide an API key',
      payload: {authMode: 'api-key', hasStoredSecret: false},
      status: 'pending',
    }
  }),
  deleteProviderConnection: mock(async (_id: string) => {
    return {
      archived: false,
      comparisonProjectCount: 0,
      deleted: true,
      deletedModelCount: 2,
      judgmentCount: 0,
      projectCount: 0,
    }
  }),
  deleteProviderSecret: mock(async (_secretRef: string | null | undefined) => {}),
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
          providerKind: 'openrouter',
          secretRef: 'keychain:provider-connection:test',
          updatedAt: null,
        }
  }),
  listProviderConnections: mock(async () => {
    return [
      {
        authMode: 'api-key',
        baseURL: 'https://api.example.com/v1',
        config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
        createdAt: null,
        enabled: true,
        hasSecret: true,
        id: 'connection-1',
        label: 'Provider Connection',
        lastCheckedAt: null,
        lastError: null,
        models: [],
        providerKind: 'openrouter',
        secretRef: 'keychain:provider-connection:test',
        updatedAt: null,
      },
    ]
  }),
  finishProviderAuth: mock(async (_input: unknown) => {
    return {
      connection: {
        authMode: 'api-key',
        baseURL: 'https://api.example.com/v1',
        config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
        createdAt: null,
        enabled: true,
        hasSecret: true,
        id: 'connection-1',
        label: 'Provider Connection',
        lastCheckedAt: null,
        lastError: null,
        providerKind: 'openrouter',
        secretRef: 'keychain:provider-connection:test',
        updatedAt: null,
      },
      message: 'OpenRouter credentials captured',
      payload: {authMode: 'api-key', hasStoredSecret: true},
      status: 'complete',
    }
  }),
  getProviderAuthConnection: mock(async (_connectionId: string | null | undefined) => {
    return null
  }),
  resolveProviderRuntimeCredentials: mock(async (_connection: unknown) => {
    return {apiKey: null, baseURL: 'https://api.example.com/v1', headers: {}, secretRef: null}
  }),
  storeProviderSecret: mock(async (_input: {connectionId: string; secret: string}) => {
    return 'keychain:provider-connection:test'
  }),
  testProviderConnectionHealth: mock(async (_connection: unknown) => {
    return {lastError: null, message: 'Connected', modelCount: 2, ok: true}
  }),
  updateProviderConnection: mock(async (input: unknown) => {
    return {
      ...(input as object),
      config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
      createdAt: null,
      hasSecret: true,
      lastCheckedAt: null,
      lastError: null,
      providerKind: 'openrouter',
      updatedAt: null,
    }
  }),
}

void mock.module(providerConnectionRepositoryModulePath, () => {
  return {
    createProviderConnection: state.createProviderConnection,
    deleteProviderConnection: state.deleteProviderConnection,
    getProviderConnection: state.getProviderConnection,
    listProviderConnections: state.listProviderConnections,
    updateProviderConnection: state.updateProviderConnection,
  }
})

void mock.module(providerSecretStoreModulePath, () => {
  return {deleteProviderSecret: state.deleteProviderSecret, storeProviderSecret: state.storeProviderSecret}
})

void mock.module(providerHealthServiceModulePath, () => {
  return {testProviderConnectionHealth: state.testProviderConnectionHealth}
})

void mock.module(providerConnectionHelpersModulePath, () => {
  return {
    getProviderConnectionAuthMode: ({secretRef}: {secretRef: string | null}) => {
      return secretRef ? 'api-key' : 'none'
    },
    getResolvedProviderBaseURL: ({baseURL}: {baseURL: string | null}) => {
      return baseURL
    },
  }
})

void mock.module(providerCatalogModulePath, () => {
  return {
    getProviderCatalog: () => {
      return [
        {
          defaultBaseURL: null,
          description: 'mock',
          kind: 'openrouter',
          label: 'OpenRouter',
          requiresApiKey: true,
          supportsDiscovery: true,
          supportsWorkerUrls: false,
        },
      ]
    },
    getProviderCatalogEntry: (providerKind: string) => {
      return providerKind === 'openrouter'
        ? {
            defaultBaseURL: null,
            description: 'mock',
            kind: 'openrouter',
            label: 'OpenRouter',
            requiresApiKey: true,
            supportsDiscovery: true,
            supportsWorkerUrls: false,
          }
        : null
    },
    isCodexProvider: (providerKind: string) => {
      return providerKind === 'codex'
    },
    normalizeProviderKind: (providerKind: string) => {
      return providerKind as 'openrouter' | 'unknown'
    },
  }
})

void mock.module(providerAuthServiceModulePath, () => {
  return {
    beginProviderAuth: state.beginProviderAuth,
    finishProviderAuth: state.finishProviderAuth,
    getProviderAuthConnection: state.getProviderAuthConnection,
    resolveProviderRuntimeCredentials: state.resolveProviderRuntimeCredentials,
  }
})

void mock.module(providerRegistryModulePath, () => {
  return {
    requireProviderRegistryEntry: () => {
      return {
        listModels: async () => {
          return [
            {
              displayName: 'remote-model',
              metadataJson: null,
              modelName: 'remote-model',
              remoteModelId: 'remote-model',
              variant: null,
              version: null,
            },
          ]
        },
      }
    },
  }
})

const loadRoutes = async () => {
  const {providerConnectionsRoutes} = await import('./ProviderConnectionsRoutes.ts')

  return new Elysia().use(providerConnectionsRoutes)
}

test('provider connections route creates a provider connection', async () => {
  state.createProviderConnection.mockClear()
  state.storeProviderSecret.mockClear()
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-connections', {
      body: JSON.stringify({apiKey: 'test-key', label: 'OpenRouter', providerKind: 'openrouter'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {connection: {id: string}}}

  expect(response.status).toBe(200)
  expect(body.data.connection.id).toBe('connection-1')
  expect(state.createProviderConnection).toHaveBeenCalledTimes(1)
  expect(state.storeProviderSecret).toHaveBeenCalledTimes(1)
})

test('provider connections route rolls back the connection if secret storage fails', async () => {
  state.createProviderConnection.mockClear()
  state.deleteProviderConnection.mockClear()
  state.storeProviderSecret.mockImplementationOnce(async () => {
    throw new Error('Keychain unavailable')
  })

  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-connections', {
      body: JSON.stringify({apiKey: 'test-key', label: 'OpenRouter', providerKind: 'openrouter'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const bodyText = await response.text()

  expect(response.status).toBe(500)
  expect(bodyText).toContain('Keychain unavailable')
  expect(state.createProviderConnection).toHaveBeenCalledTimes(1)
  expect(state.deleteProviderConnection).toHaveBeenCalledTimes(1)
  expect(state.deleteProviderConnection).toHaveBeenCalledWith('connection-1')
})

test('provider auth begin route returns lifecycle state', async () => {
  state.beginProviderAuth.mockClear()
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-auth/openrouter/begin', {
      body: JSON.stringify({}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {result: {status: string}}}

  expect(response.status).toBe(200)
  expect(body.data.result.status).toBe('pending')
  expect(state.beginProviderAuth).toHaveBeenCalledTimes(1)
})

test('provider auth finish route returns lifecycle completion', async () => {
  state.finishProviderAuth.mockClear()
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-auth/openrouter/finish', {
      body: JSON.stringify({payload: {secretValue: 'test-key'}}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {result: {status: string; connection: {id: string}}}}

  expect(response.status).toBe(200)
  expect(body.data.result.status).toBe('complete')
  expect(body.data.result.connection.id).toBe('connection-1')
  expect(state.finishProviderAuth).toHaveBeenCalledTimes(1)
})

test('provider connections route disables a provider connection', async () => {
  state.updateProviderConnection.mockClear()
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-connections/connection-1', {
      body: JSON.stringify({enabled: false, label: 'OpenRouter'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )

  expect(response.status).toBe(200)
  expect(state.updateProviderConnection).toHaveBeenCalledTimes(1)
})

test('provider connections route removes a provider connection', async () => {
  state.deleteProviderConnection.mockClear()
  state.deleteProviderSecret.mockClear()
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-connections/connection-1', {method: 'DELETE'}),
  )
  const body = (await response.json()) as {data: {archived: boolean; deleted: boolean; deletedModelCount: number}}

  expect(response.status).toBe(200)
  expect(body.data.archived).toBe(false)
  expect(body.data.deleted).toBe(true)
  expect(body.data.deletedModelCount).toBe(2)
  expect(state.deleteProviderConnection).toHaveBeenCalledTimes(1)
  expect(state.deleteProviderSecret).toHaveBeenCalledTimes(1)
})
