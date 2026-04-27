import {afterEach, expect, mock, test} from 'bun:test'

import type {ProviderConnectionRecord, ProviderModelRecord} from './providerTypes.ts'

type ProviderInvocationServiceModule = typeof import('./providerInvocationService.ts')

const providerAuthServiceModulePath = new URL('./providerAuthService.ts', import.meta.url).pathname
const providerConnectionRepositoryModulePath = new URL('./providerConnectionRepository.ts', import.meta.url).pathname
const providerModelRepositoryModulePath = new URL('./providerModelRepository.ts', import.meta.url).pathname
const providerRegistryModulePath = new URL('./providerRegistry.ts', import.meta.url).pathname
const providerInvocationServiceModulePath = new URL('./providerInvocationService.ts', import.meta.url).pathname

const getProviderConnectionForStoredModel = mock(async (_modelId: string) => {
  throw new Error('stored connection lookup should not run')
})
const getProviderConnection = mock(async (id: string) => {
  return {
    authMode: null,
    baseURL: 'http://runtime.test/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'manual' as const},
    createdAt: null,
    enabled: true,
    hasSecret: false,
    id,
    label: id,
    lastCheckedAt: null,
    lastError: null,
    maxInflightRequests: null,
    providerKind: 'openai' as const,
    secretRef: null,
    updatedAt: null,
  }
})
const getProviderModels = mock(async (_modelIds: string[]) => {
  throw new Error('stored model lookup should not run')
})
const resolveProviderRuntimeCredentials = mock(async (connection: ProviderConnectionRecord) => {
  return {apiKey: null, baseURL: connection.baseURL, headers: {}, secretRef: connection.secretRef}
})
const resolveAdapterRuntimeCredentials = mock(async ({connection}: {connection: ProviderConnectionRecord}) => {
  return {apiKey: null, baseURL: connection.baseURL, headers: {}, secretRef: connection.secretRef}
})
const invoke = mock(async () => {
  return {text: '{}', usage: {completionTokens: 2, promptTokens: 1, totalTokens: 3}}
})
const requireProviderRegistryEntry = mock((_providerKind: string) => {
  return {
    catalog: {defaultBaseURL: null, description: 'Codex', kind: 'codex', label: 'Codex', requiresApiKey: false},
    invoke,
    resolveRuntimeCredentials: resolveAdapterRuntimeCredentials,
  }
})

const loadService = (): Promise<ProviderInvocationServiceModule> => {
  void mock.module(providerAuthServiceModulePath, () => {
    return {resolveProviderRuntimeCredentials}
  })
  void mock.module(providerConnectionRepositoryModulePath, () => {
    return {getProviderConnection, getProviderConnectionForStoredModel}
  })
  void mock.module(providerModelRepositoryModulePath, () => {
    return {getProviderModels}
  })
  void mock.module(providerRegistryModulePath, () => {
    return {requireProviderRegistryEntry}
  })

  return import(`${providerInvocationServiceModulePath}?test=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  mock.restore()
  getProviderConnectionForStoredModel.mockClear()
  getProviderConnection.mockClear()
  getProviderModels.mockClear()
  resolveProviderRuntimeCredentials.mockClear()
  resolveAdapterRuntimeCredentials.mockClear()
  invoke.mockClear()
  requireProviderRegistryEntry.mockClear()
})

test('stored provider invocation can use supplied context without repository lookups', async () => {
  const {invokeStoredProviderModel} = await loadService()
  const connection: ProviderConnectionRecord = {
    authMode: null,
    baseURL: 'http://owner-runtime.test/v1',
    config: {manualWorkerUrls: [], workerUrlMode: 'manual'},
    createdAt: null,
    enabled: true,
    hasSecret: false,
    id: 'connection-owner',
    label: 'Owner connection',
    lastCheckedAt: null,
    lastError: null,
    maxInflightRequests: 4,
    providerKind: 'codex',
    secretRef: null,
    updatedAt: null,
  }
  const model: ProviderModelRecord = {
    baseURL: 'http://owner-runtime.test/v1',
    createdAt: null,
    displayName: 'GPT 5.5',
    enabled: true,
    id: 'model-owner',
    metadataJson: {reasoningEffort: 'xhigh'},
    modelName: 'gpt-5.5',
    name: 'gpt-5.5',
    provider: 'codex',
    providerConnectionId: 'connection-owner',
    remoteModelId: 'gpt-5.5',
    source: null,
    updatedAt: null,
    variant: 'xhigh',
    version: 'xhigh',
  }
  const outputSchema = {type: 'object'}

  const result = await invokeStoredProviderModel({
    baseURLOverride: 'http://override-runtime.test/v1',
    invocationContext: {connection, model},
    maxCompletionTokens: 123,
    modelId: 'model-owner',
    outputSchema,
    prompt: 'Prompt',
    systemPrompt: 'System',
    temperature: 0.2,
  })

  expect(result).toEqual({text: '{}', usage: {completionTokens: 2, promptTokens: 1, totalTokens: 3}})
  expect(getProviderConnectionForStoredModel).not.toHaveBeenCalled()
  expect(getProviderModels).not.toHaveBeenCalled()
  expect(requireProviderRegistryEntry).toHaveBeenCalledWith('codex')
  expect(resolveProviderRuntimeCredentials).not.toHaveBeenCalled()
  expect(resolveAdapterRuntimeCredentials).toHaveBeenCalledWith({
    catalog: {defaultBaseURL: null, description: 'Codex', kind: 'codex', label: 'Codex', requiresApiKey: false},
    connection,
  })
  expect(invoke).toHaveBeenCalledWith({
    connection,
    model,
    request: {maxCompletionTokens: 123, outputSchema, prompt: 'Prompt', systemPrompt: 'System', temperature: 0.2},
    runtimeCredentials: {apiKey: null, baseURL: 'http://override-runtime.test/v1', headers: {}, secretRef: null},
  })
})
