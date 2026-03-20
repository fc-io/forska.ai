import {expect, mock, test} from 'bun:test'

const providerCatalogModulePath = new URL('./providerCatalog.ts', import.meta.url).pathname
const providerRegistryModulePath = new URL('../providers/providerRegistry.ts', import.meta.url).pathname

const registryState = {
  invoke: mock(async (input: unknown) => {
    return {text: JSON.stringify(input), usage: {completionTokens: 1, promptTokens: 2, totalTokens: 3}}
  }),
  listModels: mock(async (_input: unknown) => {
    return [
      {
        displayName: 'shim-model',
        metadataJson: null,
        modelName: 'shim-model',
        remoteModelId: 'shim-model',
        variant: null,
        version: null,
      },
    ]
  }),
  resolveRuntimeCredentials: mock(
    async ({connection}: {connection: {baseURL: string | null; secretRef: string | null}}) => {
      return {apiKey: null, baseURL: connection.baseURL, headers: {}, secretRef: connection.secretRef}
    },
  ),
  testConnection: mock(async (_input: unknown) => {
    return {lastError: null, message: 'Shim connected', modelCount: 1, ok: true}
  }),
}

void mock.module(providerCatalogModulePath, () => {
  return {
    getProviderCatalogEntry: (providerKind: string) => {
      return {
        defaultBaseURL: providerKind === 'openrouter' ? 'https://openrouter.ai/api/v1' : null,
        description: 'mock',
        kind: providerKind,
        label: providerKind,
        requiresApiKey: false,
        supportsDiscovery: true,
        supportsWorkerUrls: false,
      }
    },
    getProviderDefaultBaseURL: (providerKind: string) => {
      return providerKind === 'openrouter' ? 'https://openrouter.ai/api/v1' : null
    },
    normalizeProviderKind: (providerKind: string) => {
      return providerKind as 'openrouter'
    },
  }
})

void mock.module(providerRegistryModulePath, () => {
  return {
    requireProviderRegistryEntry: () => {
      return {
        catalog: {
          defaultBaseURL: 'https://openrouter.ai/api/v1',
          description: 'mock',
          kind: 'openrouter',
          label: 'OpenRouter',
          requiresApiKey: false,
          supportsDiscovery: true,
          supportsWorkerUrls: false,
        },
        invoke: registryState.invoke,
        kind: 'openrouter',
        listModels: registryState.listModels,
        resolveRuntimeCredentials: registryState.resolveRuntimeCredentials,
        testConnection: registryState.testConnection,
        transportFamily: 'openai-chat',
      }
    },
  }
})

const loadProviderClientService = () => {
  return import('./providerClientService.ts')
}

test('providerClientService list shim delegates to registry entry', async () => {
  registryState.listModels.mockClear()
  registryState.resolveRuntimeCredentials.mockClear()
  const service = await loadProviderClientService()
  const models = await service.listProviderModels({baseURL: null, providerKind: 'openrouter', secretRef: null})

  expect(models[0]?.modelName).toBe('shim-model')
  expect(registryState.resolveRuntimeCredentials).toHaveBeenCalledTimes(1)
  expect(registryState.listModels).toHaveBeenCalledTimes(1)
})

test('providerClientService invoke shim delegates to registry entry', async () => {
  registryState.invoke.mockClear()
  const service = await loadProviderClientService()
  const result = await service.invokeProviderModel({
    baseURL: 'https://openrouter.ai/api/v1',
    maxCompletionTokens: 100,
    modelName: 'shim-model',
    outputSchema: {type: 'object'},
    prompt: 'hello',
    providerKind: 'openrouter',
    secretRef: null,
    systemPrompt: 'system',
    temperature: 0.2,
    version: null,
  })

  expect(result.usage.totalTokens).toBe(3)
  expect(registryState.invoke).toHaveBeenCalledTimes(1)
})
