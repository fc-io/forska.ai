import {expect, mock, test} from 'bun:test'

const providerConnectionHelpersModulePath = new URL('./providerConnectionHelpers.ts', import.meta.url).pathname
const providerConnectionRepositoryModulePath = new URL('./providerConnectionRepository.ts', import.meta.url).pathname
const providerRegistryModulePath = new URL('./providerRegistry.ts', import.meta.url).pathname
const providerRuntimeDetectorModulePath = new URL('./providerRuntimeDetector.ts', import.meta.url).pathname
const providerRuntimeMatchResolverModulePath = new URL('./providerRuntimeMatchResolver.ts', import.meta.url).pathname
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
      config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
      createdAt: null,
      enabled: true,
      hasSecret: false,
      id,
      label: 'Provider Connection',
      lastCheckedAt: null,
      lastError: null,
      maxInflightRequests: null,
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
  resolveProviderConnectionRuntimeMatch: mock(async (_input: unknown): Promise<unknown> => {
    const candidate = {
      localUrls: [] as string[],
      modelNames: [] as string[],
      reason: 'manual-base-url',
      remoteUrls: ['https://api.example.com/v1'],
      sourceMetadata: null,
      source: 'saved-base-url',
      status: 'matched',
    }

    return {
      candidate: candidate as typeof candidate | null,
      detectedModelNames: [] as string[],
      effectiveBaseURL: 'https://api.example.com/v1',
      effectiveWorkerUrls: [] as string[],
      localUrls: [] as string[],
      modelNames: [] as string[],
      reason: 'manual-base-url',
      reasons: ['manual-mode', 'manual-base-url'],
      remoteUrls: ['https://api.example.com/v1'],
      resolutionMode: 'manual',
      sourceMetadata: null,
      source: 'saved-base-url',
      status: 'manual-only',
    }
  }),
  markProviderRuntimeUsage: mock((_input: unknown) => {}),
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

void mock.module(providerRuntimeDetectorModulePath, () => {
  return {markProviderRuntimeUsage: state.markProviderRuntimeUsage}
})

void mock.module(providerRuntimeMatchResolverModulePath, () => {
  return {resolveProviderConnectionRuntimeMatch: state.resolveProviderConnectionRuntimeMatch}
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

test('resolveMatchedProviderRuntimeCredentials keeps the matched effective runtime base URL', async () => {
  state.resolveProviderConnectionRuntimeMatch.mockImplementationOnce(async (_input: unknown) => {
    return {
      candidate: {
        localUrls: ['http://localhost:30001'],
        modelNames: ['Qwen/Qwen3'],
        reason: 'runtime-auto-detect',
        remoteUrls: ['http://localhost:30001/v1'],
        sourceMetadata: {cluster: null, jobId: null, kind: 'local', label: 'local', sshJumpHost: null},
        source: 'detected-runtime',
        status: 'matched',
      },
      detectedModelNames: ['Qwen/Qwen3'],
      effectiveBaseURL: 'http://localhost:30001/v1',
      effectiveWorkerUrls: ['http://localhost:30001'],
      localUrls: ['http://localhost:30001'],
      modelNames: ['Qwen/Qwen3'],
      reason: 'runtime-auto-detect',
      reasons: ['runtime-auto-detect', 'runtime-base-url-overlap'],
      remoteUrls: ['http://localhost:30001/v1'],
      resolutionMode: 'auto-detect',
      sourceMetadata: {cluster: null, jobId: null, kind: 'local', label: 'local', sshJumpHost: null},
      source: 'detected-runtime',
      status: 'matched',
    }
  })
  const service = await loadAuthService()
  const connection = await service.getProviderAuthConnection('connection-1')

  const credentials = connection ? await service.resolveMatchedProviderRuntimeCredentials(connection) : null

  expect(credentials?.baseURL).toBe('http://localhost:30001/v1')
  expect(state.markProviderRuntimeUsage).toHaveBeenCalledWith({
    baseURL: 'http://localhost:30001/v1',
    providerKind: 'openrouter',
  })
})

test('resolveMatchedProviderRuntimeCredentials throws an actionable error for ambiguous auto-detect matches', async () => {
  state.resolveProviderConnectionRuntimeMatch.mockImplementationOnce(async (_input: unknown) => {
    return {
      candidate: null,
      detectedModelNames: ['Qwen/Qwen3'],
      effectiveBaseURL: 'https://api.example.com/v1',
      effectiveWorkerUrls: [] as string[],
      localUrls: [] as string[],
      modelNames: ['Qwen/Qwen3'],
      reason: 'runtime-url-conflict',
      reasons: ['runtime-auto-detect', 'runtime-url-conflict'],
      remoteUrls: ['http://localhost:30001/v1'],
      resolutionMode: 'auto-detect',
      sourceMetadata: null,
      source: 'none',
      status: 'ambiguous',
    }
  })
  const service = await loadAuthService()
  const connection = await service.getProviderAuthConnection('connection-1')
  const getResolutionError = async () => {
    if (!connection) {
      throw new Error('Expected provider connection')
    }

    return service.resolveMatchedProviderRuntimeCredentials(connection)
  }

  try {
    await getResolutionError()
    throw new Error('Expected runtime resolution to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      'OpenRouter runtime selection is ambiguous at https://api.example.com/v1. Update the saved base URL or manual worker URLs so exactly one runtime matches this connection.',
    )
  }
})
