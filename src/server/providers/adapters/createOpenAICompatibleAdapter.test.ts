import {expect, mock, test} from 'bun:test'

const openAIChatTransportModulePath = new URL('../transports/openaiChatTransport.ts', import.meta.url).pathname

const transportState = {
  invoke: mock(async (_input: unknown) => {
    return {text: 'ok', usage: {completionTokens: 1, promptTokens: 2, totalTokens: 3}}
  }),
  listChat: mock(async (_input: unknown) => {
    return [
      {
        displayName: 'chat-model',
        metadataJson: null,
        modelName: 'chat-model',
        remoteModelId: 'chat-model',
        variant: null,
        version: null,
      },
    ]
  }),
  listNativeOllama: mock(async (_input: unknown) => {
    return [
      {
        displayName: 'ollama-model',
        metadataJson: null,
        modelName: 'ollama-model',
        remoteModelId: 'ollama-model',
        variant: null,
        version: null,
      },
    ]
  }),
}

void mock.module(openAIChatTransportModulePath, () => {
  return {
    invokeOpenAIChatModel: transportState.invoke,
    listNativeOllamaModels: transportState.listNativeOllama,
    listOpenAIChatModels: transportState.listChat,
  }
})

const loadFactory = () => {
  return import('./createOpenAICompatibleAdapter.ts')
}

const getOllamaConnectionInput = () => {
  return {
    connection: {
      authMode: 'none' as const,
      baseURL: 'http://127.0.0.1:11434/v1',
      config: {manualWorkerUrls: [], workerUrlMode: 'manual' as const},
      createdAt: null,
      enabled: true,
      hasSecret: false,
      id: 'ollama-1',
      label: 'Ollama',
      lastCheckedAt: null,
      lastError: null,
      providerKind: 'ollama' as const,
      secretRef: null,
      updatedAt: null,
    },
    runtimeCredentials: {apiKey: null, baseURL: 'http://127.0.0.1:11434/v1', headers: {}, secretRef: null},
  }
}

test('OpenAI-compatible adapter uses native Ollama discovery when enabled', async () => {
  transportState.listNativeOllama.mockClear()
  transportState.listChat.mockClear()
  const {createOpenAICompatibleAdapter} = await loadFactory()
  const adapter = createOpenAICompatibleAdapter(
    {
      defaultBaseURL: 'http://127.0.0.1:11434/v1',
      description: 'Local Ollama',
      kind: 'ollama',
      label: 'Ollama',
      requiresApiKey: false,
      supportsDiscovery: true,
      supportsWorkerUrls: true,
    },
    {transportFamily: 'ollama-native-discovery', useNativeOllamaDiscovery: true},
  )

  const models = await adapter.listModels(getOllamaConnectionInput())

  expect(models[0]?.modelName).toBe('ollama-model')
  expect(transportState.listNativeOllama).toHaveBeenCalledTimes(1)
  expect(transportState.listChat).toHaveBeenCalledTimes(0)
})

test('OpenAI-compatible adapter falls back to chat discovery when native Ollama discovery fails', async () => {
  transportState.listNativeOllama.mockClear()
  transportState.listChat.mockClear()
  transportState.listNativeOllama.mockImplementationOnce(async () => {
    throw new Error('native failed')
  })
  const {createOpenAICompatibleAdapter} = await loadFactory()
  const adapter = createOpenAICompatibleAdapter(
    {
      defaultBaseURL: 'http://127.0.0.1:11434/v1',
      description: 'Local Ollama',
      kind: 'ollama',
      label: 'Ollama',
      requiresApiKey: false,
      supportsDiscovery: true,
      supportsWorkerUrls: true,
    },
    {transportFamily: 'ollama-native-discovery', useNativeOllamaDiscovery: true},
  )

  const models = await adapter.listModels(getOllamaConnectionInput())

  expect(models[0]?.modelName).toBe('chat-model')
  expect(transportState.listNativeOllama).toHaveBeenCalledTimes(1)
  expect(transportState.listChat).toHaveBeenCalledTimes(1)
})
