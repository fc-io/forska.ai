import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

import type {ProviderConnectionRecord, ProviderModelRecord} from '../providers/providerTypes.ts'

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const codexAppTransportModulePath = new URL('../providers/transports/codexAppTransport.ts', import.meta.url).pathname
const providerConnectionRepositoryModulePath = new URL('../providers/providerConnectionRepository.ts', import.meta.url)
  .pathname
const providerModelRepositoryModulePath = new URL('../providers/providerModelRepository.ts', import.meta.url).pathname

type ModelsRoutesModule = typeof import('./ModelsRoutes.ts')

const getCodexConnection = (): ProviderConnectionRecord => {
  return {
    authMode: 'codex-cli',
    baseURL: null,
    config: {disabledModelIds: [], manualWorkerUrls: [], workerUrlMode: 'manual'},
    createdAt: null,
    enabled: true,
    hasSecret: false,
    id: 'codex-connection-1',
    label: 'Codex',
    lastCheckedAt: null,
    lastError: null,
    maxInflightRequests: null,
    providerKind: 'codex',
    secretRef: null,
    updatedAt: null,
  }
}

const getAnthropicBaseModel = (): ProviderModelRecord => {
  return {
    baseURL: null,
    createdAt: null,
    displayName: 'Claude Sonnet 4.6',
    enabled: true,
    id: 'anthropic-base-model-1',
    metadataJson: null,
    modelName: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    providerConnectionId: 'anthropic-connection-1',
    remoteModelId: 'claude-sonnet-4-6',
    source: 'manual',
    updatedAt: null,
    variant: null,
    version: null,
  }
}

const state = {
  createProviderConnection: mock(async () => {
    return getCodexConnection()
  }),
  createProviderModel: mock(async (input: {metadataJson: unknown}) => {
    return {
      ...getAnthropicBaseModel(),
      id: 'codex-model-1',
      metadataJson: input.metadataJson,
      provider: 'codex',
      providerConnectionId: 'codex-connection-1',
    }
  }),
  getCodexAppDeviceLoginJob: mock((_jobId: string) => {
    return null
  }),
  getCodexAppRuntimeStatus: mock(async () => {
    return {
      appServerReady: true,
      cli: {loggedIn: true, method: 'api-key', ok: true, raw: 'Logged in'},
      codexBin: 'codex',
      message: 'Codex connected.',
    }
  }),
  getCurrentCodexAppDeviceLoginJob: mock(() => {
    return null
  }),
  getCodexAppHealthResult: mock(async () => {
    return {lastError: null, message: 'Codex connected.', modelCount: null, ok: true}
  }),
  getFirstEnabledProviderConnection: mock(async (providerKind: string) => {
    return providerKind === 'codex' ? getCodexConnection() : null
  }),
  getProviderConnection: mock(async (id: string) => {
    return id === 'codex-connection-1' ? getCodexConnection() : null
  }),
  listProviderConnections: mock(async () => {
    return []
  }),
  listSelectableProviderModels: mock(async () => {
    return [getAnthropicBaseModel()]
  }),
  listCodexAppModels: mock(async () => {
    return []
  }),
  queryJson: mock(async (_statement: string) => {
    return []
  }),
  startCodexAppDeviceLogin: mock(() => {
    return {id: 'codex-login-1', state: 'running'}
  }),
  updateProviderModel: mock(async () => {
    return getAnthropicBaseModel()
  }),
}

const registerModuleMocks = () => {
  void mock.module(providerConnectionRepositoryModulePath, () => {
    return {
      createProviderConnection: state.createProviderConnection,
      deleteProviderConnection: mock(async () => {
        return {
          archived: false,
          comparisonProjectCount: 0,
          deleted: true,
          deletedModelCount: 0,
          judgmentCount: 0,
          projectCount: 0,
        }
      }),
      getFirstEnabledProviderConnection: state.getFirstEnabledProviderConnection,
      getProviderConnectionForStoredModel: mock(async () => {
        return getCodexConnection()
      }),
      getProviderConnection: state.getProviderConnection,
      listProviderConnections: state.listProviderConnections,
      setProviderConnectionCheckState: mock(async () => {}),
      updateProviderConnection: mock(async () => {
        return getCodexConnection()
      }),
    }
  })

  void mock.module(providerModelRepositoryModulePath, () => {
    return {
      createProviderModel: state.createProviderModel,
      listSelectableProviderModels: state.listSelectableProviderModels,
      updateProviderModel: state.updateProviderModel,
      upsertDiscoveredModels: mock(async () => {
        return []
      }),
    }
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

  void mock.module(codexAppTransportModulePath, () => {
    return {
      getCodexAppDeviceLoginJob: state.getCodexAppDeviceLoginJob,
      getCodexAppHealthResult: state.getCodexAppHealthResult,
      getCodexAppRuntimeStatus: state.getCodexAppRuntimeStatus,
      getCurrentCodexAppDeviceLoginJob: state.getCurrentCodexAppDeviceLoginJob,
      invokeCodexAppModel: mock(async () => {
        return {text: '{}', usage: {completionTokens: 0, promptTokens: 0, totalTokens: 0}}
      }),
      listCodexAppModels: state.listCodexAppModels,
      startCodexAppDeviceLogin: state.startCodexAppDeviceLogin,
    }
  })
}

const loadRoutes = async () => {
  registerModuleMocks()

  const {modelsRoutes} = (await import(`./ModelsRoutes.ts?test=${Date.now()}-${Math.random()}`)) as ModelsRoutesModule

  return new Elysia().use(modelsRoutes)
}

afterEach(() => {
  mock.restore()
})

test('models ensure rejects Anthropic materialization', async () => {
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/models/ensure', {
      body: JSON.stringify({
        modelName: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        provider: 'anthropic',
        version: 'high',
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: null; error: string}

  expect(response.status).toBe(400)
  expect(body).toEqual({data: null, error: 'Unsupported provider'})
  expect(state.createProviderModel).not.toHaveBeenCalled()
})

test('models ensure materializes Codex variants with prompt-affecting thinking metadata', async () => {
  state.createProviderModel.mockClear()
  const app = await loadRoutes()
  const response = await app.handle(
    new Request('http://localhost/api/models/ensure', {
      body: JSON.stringify({modelName: 'codex-thinking', name: 'Codex Thinking', provider: 'codex', version: 'high'}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {data: {modelId: string}; error: null}
  const [createInput] = state.createProviderModel.mock.calls[0] ?? []
  const metadataJson = (createInput as {metadataJson: {options?: {thinking?: string}}} | undefined)?.metadataJson

  expect(response.status).toBe(200)
  expect(body).toEqual({data: {modelId: 'codex-model-1'}, error: null})
  expect(metadataJson?.options?.thinking).toBe('high')
})

test('models list keeps Anthropic thinking variants as virtual ids with provider connection handoff data', async () => {
  const app = await loadRoutes()
  const response = await app.handle(new Request('http://localhost/api/models'))
  const body = (await response.json()) as {
    data: Array<{id: string; modelName: string; providerConnectionId?: string | null; version: string | null}>
  }
  const virtualVariant = body.data.find((model) => {
    return model.id === 'anthropic:claude-sonnet-4-6:high'
  })

  expect(response.status).toBe(200)
  expect(virtualVariant).toMatchObject({
    id: 'anthropic:claude-sonnet-4-6:high',
    modelName: 'claude-sonnet-4-6',
    providerConnectionId: 'anthropic-connection-1',
    version: 'high',
  })
})
