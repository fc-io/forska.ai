import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const providerAuthServiceModulePath = new URL('../providers/providerAuthService.ts', import.meta.url).pathname
const getCodexMaxInflightModulePath = new URL('../cron/judgmentsJobs/getCodexMaxInflight.ts', import.meta.url).pathname
const getJudgmentsCapacityModulePath = new URL('../cron/judgmentsJobs/getJudgmentsCapacity.ts', import.meta.url)
  .pathname
const providerConnectionHelpersModulePath = new URL('../providers/providerConnectionHelpers.ts', import.meta.url)
  .pathname
const providerConnectionRepositoryModulePath = new URL('../providers/providerConnectionRepository.ts', import.meta.url)
  .pathname
const providerHealthServiceModulePath = new URL('../providers/providerHealthService.ts', import.meta.url).pathname
const providerRuntimeMatchResolverModulePath = new URL('../providers/providerRuntimeMatchResolver.ts', import.meta.url)
  .pathname
const providerRegistryModulePath = new URL('../providers/providerRegistry.ts', import.meta.url).pathname
const providerSecretStoreModulePath = new URL('../providers/providerSecretStore.ts', import.meta.url).pathname
const providerCatalogModulePath = new URL('../services/providerCatalog.ts', import.meta.url).pathname

type ProviderConnectionsRoutesModule = typeof import('./ProviderConnectionsRoutes.ts')

const state = {
  createProviderConnection: mock(async (input: unknown) => {
    const typedInput = input as {maxInflightRequests?: number | null}

    return {
      ...(input as object),
      config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
      createdAt: null,
      enabled: true,
      hasSecret: false,
      id: 'connection-1',
      lastCheckedAt: null,
      lastError: null,
      maxInflightRequests: typedInput.maxInflightRequests ?? null,
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
          maxInflightRequests: null,
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
        maxInflightRequests: null,
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
        maxInflightRequests: null,
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
  getCodexMaxInflight: mock(() => {
    return 4
  }),
  getJudgmentsCapacity: mock((_runningJobCount: number) => {
    return {
      addToQueueMaxBatchSize: 100,
      maxBurst: 12,
      maxInflight: 12,
      perWorkerMaxBurstRequests: 12,
      perWorkerMaxInflightRequests: 12,
      perWorkerMaxRunningRequests: 12,
      readyTargetPerJob: 24,
      readyTargetTotal: 24,
      workerCount: 1,
    }
  }),
  resolveMatchedProviderRuntimeCredentials: mock(async (_connection: unknown) => {
    return {apiKey: null, baseURL: 'https://api.example.com/v1', headers: {}, secretRef: null}
  }),
  resolveProviderConnectionRuntimeMatchFromSummaries: mock((_input: unknown): unknown => {
    return {
      candidate: null,
      detectedModelNames: [],
      effectiveBaseURL: 'https://api.example.com/v1',
      effectiveWorkerUrls: [],
      localUrls: [],
      modelNames: [],
      reason: 'manual-base-url',
      reasons: ['manual-mode', 'manual-base-url'],
      remoteUrls: ['https://api.example.com/v1'],
      resolutionMode: 'manual',
      sourceMetadata: null,
      source: 'saved-base-url',
      status: 'manual-only',
    }
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

const registerModuleMocks = () => {
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

  void mock.module(getCodexMaxInflightModulePath, () => {
    return {getCodexMaxInflight: state.getCodexMaxInflight}
  })

  void mock.module(getJudgmentsCapacityModulePath, () => {
    return {getJudgmentsCapacity: state.getJudgmentsCapacity}
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
          {
            defaultBaseURL: null,
            description: 'mock',
            kind: 'codex',
            label: 'Codex App',
            requiresApiKey: false,
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
          : providerKind === 'codex'
            ? {
                defaultBaseURL: null,
                description: 'mock',
                kind: 'codex',
                label: 'Codex App',
                requiresApiKey: false,
                supportsDiscovery: true,
                supportsWorkerUrls: false,
              }
            : null
      },
      isCodexProvider: (providerKind: string) => {
        return providerKind === 'codex'
      },
      normalizeProviderKind: (providerKind: string) => {
        return providerKind as 'codex' | 'openrouter' | 'unknown'
      },
    }
  })

  void mock.module(providerRuntimeMatchResolverModulePath, () => {
    return {
      resolveProviderConnectionRuntimeMatchFromSummaries: state.resolveProviderConnectionRuntimeMatchFromSummaries,
    }
  })

  void mock.module(providerAuthServiceModulePath, () => {
    return {
      beginProviderAuth: state.beginProviderAuth,
      finishProviderAuth: state.finishProviderAuth,
      getProviderAuthConnection: state.getProviderAuthConnection,
      resolveMatchedProviderRuntimeCredentials: state.resolveMatchedProviderRuntimeCredentials,
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
}

const loadRoutes = async () => {
  registerModuleMocks()

  const {providerConnectionsRoutes} = (await import(
    `./ProviderConnectionsRoutes.ts?test=${Date.now()}-${Math.random()}`
  )) as ProviderConnectionsRoutesModule

  return new Elysia().use(providerConnectionsRoutes)
}

afterEach(async () => {
  const {resetJudgmentEndpointAvailabilityForTests} =
    await import('../cron/judgmentsJobs/judgmentEndpointAvailability.ts')

  resetJudgmentEndpointAvailabilityForTests()
  mock.restore()
})

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

test('provider connections route round-trips maxInflightRequests on create', async () => {
  state.createProviderConnection.mockClear()
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-connections', {
      body: JSON.stringify({
        apiKey: 'test-key',
        label: 'OpenRouter',
        maxInflightRequests: 3,
        providerKind: 'openrouter',
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {connection: {maxInflightRequests: number | null}}}

  expect(response.status).toBe(200)
  expect(body.data.connection.maxInflightRequests).toBe(3)
  expect(state.createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({maxInflightRequests: 3}))
})

test('provider connections route rejects invalid maxInflightRequests on create', async () => {
  const app = await loadRoutes()

  const zeroResponse = await app.handle(
    new Request('http://localhost/api/provider-connections', {
      body: JSON.stringify({
        apiKey: 'test-key',
        label: 'OpenRouter',
        maxInflightRequests: 0,
        providerKind: 'openrouter',
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const negativeResponse = await app.handle(
    new Request('http://localhost/api/provider-connections', {
      body: JSON.stringify({
        apiKey: 'test-key',
        label: 'OpenRouter',
        maxInflightRequests: -1,
        providerKind: 'openrouter',
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const decimalResponse = await app.handle(
    new Request('http://localhost/api/provider-connections', {
      body: JSON.stringify({
        apiKey: 'test-key',
        label: 'OpenRouter',
        maxInflightRequests: 1.5,
        providerKind: 'openrouter',
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )

  expect(zeroResponse.status).toBe(400)
  expect(await zeroResponse.text()).toBe('maxInflightRequests must be null or a positive integer')
  expect(negativeResponse.status).toBe(400)
  expect(await negativeResponse.text()).toBe('maxInflightRequests must be null or a positive integer')
  expect(decimalResponse.status).toBe(400)
  expect(await decimalResponse.text()).toBe('maxInflightRequests must be null or a positive integer')
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

test('provider connections list returns runtime state with display labels', async () => {
  state.resolveProviderConnectionRuntimeMatchFromSummaries.mockClear()
  state.resolveProviderConnectionRuntimeMatchFromSummaries.mockImplementationOnce((_input: unknown): unknown => {
    return {
      candidate: {
        localUrls: ['http://localhost:30020'],
        modelNames: ['Qwen/Qwen3'],
        reason: 'runtime-auto-detect',
        remoteUrls: ['https://remote-tunnel.example/v1'],
        sourceMetadata: {
          cluster: 'remote',
          jobId: 'job-123',
          kind: 'launcher',
          label: 'Remote',
          sshJumpHost: 'remote-jump',
        },
        source: 'detected-runtime',
        status: 'matched',
      },
      detectedModelNames: ['Qwen/Qwen3'],
      effectiveBaseURL: 'https://remote-tunnel.example/v1',
      effectiveWorkerUrls: ['http://localhost:30020'],
      localUrls: ['http://localhost:30020'],
      modelNames: ['Qwen/Qwen3'],
      reason: 'runtime-auto-detect',
      reasons: ['runtime-auto-detect', 'runtime-base-url-overlap', 'runtime-model-overlap'],
      remoteUrls: ['https://remote-tunnel.example/v1'],
      resolutionMode: 'auto-detect',
      sourceMetadata: {
        cluster: 'remote',
        jobId: 'job-123',
        kind: 'launcher',
        label: 'Remote',
        sshJumpHost: 'remote-jump',
      },
      source: 'detected-runtime',
      status: 'matched',
    }
  })
  state.listProviderConnections.mockImplementationOnce((async () => {
    return [
      {
        authMode: 'none',
        baseURL: 'https://remote-tunnel.example/v1',
        config: {manualWorkerUrls: [], workerUrlMode: 'runtime'},
        createdAt: null,
        enabled: true,
        hasSecret: false,
        id: 'connection-1',
        label: 'SGLang Remote',
        lastCheckedAt: null,
        lastError: null,
        maxInflightRequests: 6,
        models: [{modelName: 'Qwen/Qwen3', remoteModelId: 'Qwen/Qwen3'}],
        providerKind: 'sglang',
        secretRef: null,
        updatedAt: null,
      },
    ]
  }) as never)

  const app = await loadRoutes()
  const response = await app.handle(new Request('http://localhost/api/provider-connections'))
  const body = (await response.json()) as {
    data: {
      connections: Array<{
        effectiveMaxInflightRequests: number
        maxInflightRequests: number | null
        runtimeState: {
          detectedModelNames: string[]
          effectiveBaseURL: string | null
          effectiveWorkerUrls: string[]
          reason: string
          reasonLabel: string
          reasonLabels: string[]
          sourceMetadata: {
            cluster: string | null
            jobId: string | null
            kind: string
            label: string
            sshJumpHost: string | null
          } | null
          status: string
          statusLabel: string
        }
      }>
    }
  }

  expect(response.status).toBe(200)
  expect(body.data.connections[0]?.effectiveMaxInflightRequests).toBe(6)
  expect(body.data.connections[0]?.maxInflightRequests).toBe(6)
  expect(body.data.connections[0]?.runtimeState).toEqual({
    detectedModelNames: ['Qwen/Qwen3'],
    endpointAvailability: {
      cooldownRemainingMs: null,
      lastFailureKind: null,
      lastFailureMessage: null,
      localProbeLiveCount: 0,
      observedAggregateProbeLiveCount: null,
      probeInProgress: false,
      status: 'healthy',
    },
    effectiveBaseURL: 'https://remote-tunnel.example/v1',
    effectiveWorkerUrls: ['http://localhost:30020'],
    reason: 'runtime-auto-detect',
    reasonLabel: 'Auto-detect matched the active Remote runtime.',
    reasonLabels: [
      'Auto-detect matched the active Remote runtime.',
      'The saved base URL overlaps the detected runtime URL.',
      'A saved model on this connection is currently served by the detected runtime.',
    ],
    sourceMetadata: {
      cluster: 'remote',
      jobId: 'job-123',
      kind: 'launcher',
      label: 'Remote',
      sshJumpHost: 'remote-jump',
    },
    status: 'matched',
    statusLabel: 'matched Remote',
  })
  expect(state.resolveProviderConnectionRuntimeMatchFromSummaries).toHaveBeenCalledTimes(1)
})

test('provider connections route exposes the current runtime/global inflight default when no override is saved', async () => {
  state.listProviderConnections.mockImplementationOnce(async () => {
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
        maxInflightRequests: null,
        models: [],
        providerKind: 'openrouter',
        secretRef: 'keychain:provider-connection:test',
        updatedAt: null,
      },
    ]
  })

  const app = await loadRoutes()
  const response = await app.handle(new Request('http://localhost/api/provider-connections'))
  const body = (await response.json()) as {data: {connections: Array<{effectiveMaxInflightRequests: number}>}}

  expect(response.status).toBe(200)
  expect(body.data.connections[0]?.effectiveMaxInflightRequests).toBe(12)
  expect(state.getJudgmentsCapacity).toHaveBeenCalledWith(1)
})

test('provider connections route exposes shared endpoint availability diagnostics', async () => {
  const {classifyConnectionFailure, recordConnectionFailure} = await import('../cron/judgmentsJobs/connectionHealth.ts')

  state.resolveProviderConnectionRuntimeMatchFromSummaries.mockImplementationOnce((_input: unknown): unknown => {
    return {
      candidate: null,
      detectedModelNames: [],
      effectiveBaseURL: 'https://api-paused.example.com/v1',
      effectiveWorkerUrls: [],
      localUrls: [],
      modelNames: [],
      reason: 'manual-base-url',
      reasons: ['manual-mode', 'manual-base-url'],
      remoteUrls: ['https://api-paused.example.com/v1'],
      resolutionMode: 'manual',
      sourceMetadata: null,
      source: 'saved-base-url',
      status: 'manual-only',
    }
  })

  state.listProviderConnections.mockImplementationOnce(async () => {
    return [
      {
        authMode: 'api-key',
        baseURL: 'https://api-paused.example.com/v1',
        config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
        createdAt: null,
        enabled: true,
        hasSecret: true,
        id: 'connection-paused',
        label: 'Paused Connection',
        lastCheckedAt: null,
        lastError: 'persisted last error',
        maxInflightRequests: null,
        models: [],
        providerKind: 'openrouter',
        secretRef: 'keychain:provider-connection:test',
        updatedAt: null,
      },
    ]
  })

  recordConnectionFailure({
    effectiveBaseURL: 'https://api-paused.example.com/v1',
    failure: classifyConnectionFailure({
      context: {
        effectiveBaseURL: 'https://api-paused.example.com/v1',
        endpointPath: '/v1/models',
        providerKind: 'openrouter',
      },
      error: Object.assign(new Error('Service unavailable'), {status: 503}),
    }),
    providerConnectionId: 'connection-paused',
  })

  const app = await loadRoutes()
  const response = await app.handle(new Request('http://localhost/api/provider-connections'))
  const body = (await response.json()) as {
    data: {
      connections: Array<{
        lastError: string | null
        runtimeState: {
          endpointAvailability: {
            cooldownRemainingMs: number | null
            lastFailureKind: string | null
            lastFailureMessage: string | null
            probeInProgress: boolean
            status: string
          } | null
        }
      }>
    }
  }

  expect(response.status).toBe(200)
  expect(body.data.connections[0]?.lastError).toBe('persisted last error')
  expect(body.data.connections[0]?.runtimeState.endpointAvailability).toMatchObject({
    lastFailureKind: 'endpoint_unavailable',
    probeInProgress: false,
    status: 'cooldown',
  })
  expect(body.data.connections[0]?.runtimeState.endpointAvailability?.lastFailureMessage).toContain(
    'Provider endpoint outage:',
  )
  expect(body.data.connections[0]?.runtimeState.endpointAvailability?.cooldownRemainingMs).toBeGreaterThan(0)
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

test('provider connections route rejects invalid maxInflightRequests on update', async () => {
  state.updateProviderConnection.mockClear()
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-connections/connection-1', {
      body: JSON.stringify({label: 'OpenRouter', maxInflightRequests: 2.2}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )

  expect(response.status).toBe(400)
  expect(await response.text()).toBe('maxInflightRequests must be null or a positive integer')
  expect(state.updateProviderConnection).not.toHaveBeenCalled()
})

test('provider connections route defers deleting the existing secret until update succeeds', async () => {
  state.deleteProviderSecret.mockClear()
  state.updateProviderConnection.mockClear()
  state.updateProviderConnection.mockImplementationOnce(async (_input: unknown) => {
    throw new Error('Database unavailable')
  })

  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-connections/connection-1', {
      body: JSON.stringify({clearSecret: true, label: 'OpenRouter'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )
  const bodyText = await response.text()

  expect(response.status).toBe(500)
  expect(bodyText).toContain('Database unavailable')
  expect(state.updateProviderConnection).toHaveBeenCalledTimes(1)
  expect(state.deleteProviderSecret).not.toHaveBeenCalled()
})

test('provider connections route removes the replaced secret only after a successful update', async () => {
  state.deleteProviderSecret.mockClear()
  state.storeProviderSecret.mockClear()
  state.updateProviderConnection.mockClear()
  state.storeProviderSecret.mockImplementationOnce(async () => {
    return 'keychain:provider-connection:new-secret'
  })

  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-connections/connection-1', {
      body: JSON.stringify({apiKey: 'new-secret', label: 'OpenRouter'}),
      headers: {'content-type': 'application/json'},
      method: 'PATCH',
    }),
  )

  expect(response.status).toBe(200)
  expect(state.storeProviderSecret).toHaveBeenCalledTimes(1)
  expect(state.updateProviderConnection).toHaveBeenCalledTimes(1)
  expect(state.deleteProviderSecret).toHaveBeenCalledWith('keychain:provider-connection:test')
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

test('provider connections route reports matched-runtime resolution errors for discovered models', async () => {
  state.resolveMatchedProviderRuntimeCredentials.mockClear()
  state.resolveMatchedProviderRuntimeCredentials.mockImplementationOnce(async (_connection: unknown) => {
    throw new Error(
      'OpenRouter runtime selection is ambiguous at https://api.example.com/v1. Update the saved base URL or manual worker URLs so exactly one runtime matches this connection.',
    )
  })
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-connections/connection-1/discovered-models'),
  )
  const bodyText = await response.text()

  expect(response.status).toBe(400)
  expect(bodyText).toContain('runtime selection is ambiguous')
  expect(state.resolveMatchedProviderRuntimeCredentials).toHaveBeenCalledTimes(1)
})

test('provider connections route reports matched-runtime resolution errors for connection tests', async () => {
  state.testProviderConnectionHealth.mockClear()
  state.testProviderConnectionHealth.mockImplementationOnce(async (_connection: unknown) => {
    throw new Error(
      "OpenRouter runtime auto-detect found an active runtime, but it does not overlap this connection's saved base URL or manual worker URLs. Update the saved URLs or switch the connection to manual settings.",
    )
  })
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/provider-connections/connection-1/test', {method: 'POST'}),
  )
  const bodyText = await response.text()

  expect(response.status).toBe(400)
  expect(bodyText).toContain('does not overlap this connection')
  expect(state.testProviderConnectionHealth).toHaveBeenCalledTimes(1)
})
