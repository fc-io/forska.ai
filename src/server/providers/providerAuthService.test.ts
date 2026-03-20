import {expect, mock, test} from 'bun:test'

const providerConnectionHelpersModulePath = new URL('./providerConnectionHelpers.ts', import.meta.url).pathname
const providerConnectionRepositoryModulePath = new URL('./providerConnectionRepository.ts', import.meta.url).pathname
const providerRegistryModulePath = new URL('./providerRegistry.ts', import.meta.url).pathname
const providerSecretStoreModulePath = new URL('./providerSecretStore.ts', import.meta.url).pathname

const state = {
  createProviderConnection: mock(async (_input: unknown) => {
    return null
  }),
  deleteProviderSecret: mock(async (_secretRef: string) => {}),
  deleteProviderConnection: mock(async (_id: string) => {
    return null
  }),
  getProviderConnection: mock(async (id: string) => {
    return {
      authMode: 'none',
      baseURL: 'https://api.example.com/v1',
      config: {workerUrls: []},
      createdAt: null,
      enabled: true,
      hasSecret: false,
      id,
      label: 'Provider Connection',
      lastCheckedAt: null,
      lastError: null,
      providerKind: 'openrouter',
      secretRef: null,
      updatedAt: null,
    }
  }),
  storeProviderSecret: mock(async (_input: {connectionId: string; secret: string}) => {
    return 'keychain:provider-connection:test'
  }),
  readProviderSecret: mock(async (_secretRef: string | null | undefined) => {
    return null
  }),
  updateProviderConnection: mock(async (input: unknown) => {
    return {
      ...(input as object),
      config: {workerUrls: []},
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
    listProviderConnections: async () => {
      return []
    },
    updateProviderConnection: state.updateProviderConnection,
  }
})

void mock.module(providerSecretStoreModulePath, () => {
  return {
    deleteProviderSecret: state.deleteProviderSecret,
    readProviderSecret: state.readProviderSecret,
    storeProviderSecret: state.storeProviderSecret,
  }
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

void mock.module(providerRegistryModulePath, () => {
  return {
    requireProviderRegistryEntry: () => {
      return {
        beginAuth: async () => {
          return {connection: null, message: 'Provide API key', payload: {authMode: 'api-key'}, status: 'pending'}
        },
        catalog: {kind: 'openrouter', label: 'OpenRouter'},
        finishAuth: async ({connection}: {connection: unknown}) => {
          return {
            connection,
            message: 'Captured API key',
            payload: {authMode: 'api-key', secretValue: 'test-key'},
            status: 'complete',
          }
        },
        resolveRuntimeCredentials: async () => {
          return {apiKey: null, baseURL: 'https://api.example.com/v1', headers: {}, secretRef: null}
        },
      }
    },
  }
})

const loadAuthService = () => {
  return import('./providerAuthService.ts')
}

test('finishProviderAuth persists secret and updates connection when auth completes', async () => {
  state.storeProviderSecret.mockClear()
  state.updateProviderConnection.mockClear()
  const service = await loadAuthService()
  const connection = await service.getProviderAuthConnection('connection-1')
  const result = await service.finishProviderAuth({
    connection,
    payload: {authMode: 'api-key'},
    providerKind: 'openrouter',
  })

  expect(result.status).toBe('complete')
  expect(result.connection?.id).toBe('connection-1')
  expect(state.storeProviderSecret).toHaveBeenCalledTimes(1)
  expect(state.updateProviderConnection).toHaveBeenCalledTimes(1)
})
