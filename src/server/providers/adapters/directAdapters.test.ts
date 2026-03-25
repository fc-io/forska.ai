import {expect, mock, test} from 'bun:test'

const openAIResponsesTransportModulePath = new URL('../transports/openaiResponsesTransport.ts', import.meta.url)
  .pathname
const anthropicMessagesTransportModulePath = new URL('../transports/anthropicMessagesTransport.ts', import.meta.url)
  .pathname
const geminiGenerateContentTransportModulePath = new URL(
  '../transports/geminiGenerateContentTransport.ts',
  import.meta.url,
).pathname
const codexAppTransportModulePath = new URL('../transports/codexAppTransport.ts', import.meta.url).pathname

const openAIResponsesState = {
  invoke: mock(async (_input: unknown) => {
    return {text: 'openai-response', usage: {completionTokens: 1, promptTokens: 2, totalTokens: 3}}
  }),
  list: mock(async (_input: unknown) => {
    return [
      {
        displayName: 'gpt-4.1',
        metadataJson: null,
        modelName: 'gpt-4.1',
        remoteModelId: 'gpt-4.1',
        variant: null,
        version: null,
      },
    ]
  }),
}

const anthropicState = {
  invoke: mock(async (_input: unknown) => {
    return {text: 'anthropic-response', usage: {completionTokens: 2, promptTokens: 3, totalTokens: 5}}
  }),
  list: mock(async (_input: unknown) => {
    return [
      {
        displayName: 'claude-sonnet',
        metadataJson: null,
        modelName: 'claude-sonnet',
        remoteModelId: 'claude-sonnet',
        variant: null,
        version: null,
      },
    ]
  }),
}

const googleState = {
  invoke: mock(async (_input: unknown) => {
    return {text: 'google-response', usage: {completionTokens: 4, promptTokens: 5, totalTokens: 9}}
  }),
  list: mock(async (_input: unknown) => {
    return [
      {
        displayName: 'gemini-2.5-pro',
        metadataJson: null,
        modelName: 'gemini-2.5-pro',
        remoteModelId: 'gemini-2.5-pro',
        variant: null,
        version: null,
      },
    ]
  }),
}

const codexState = {
  currentJob: null as null | {id: string; state: 'completed' | 'failed' | 'running'; error: string | null},
  health: mock(async () => {
    return {lastError: null, message: 'Codex connected.', modelCount: null, ok: true}
  }),
  invoke: mock(async (_input: unknown) => {
    return {text: 'codex-response', usage: {completionTokens: 0, promptTokens: 0, totalTokens: 0}}
  }),
  list: mock(async () => {
    return [
      {
        displayName: 'codex-mini',
        metadataJson: null,
        modelName: 'codex-mini',
        remoteModelId: 'codex-mini',
        variant: null,
        version: null,
      },
    ]
  }),
  runtimeStatus: mock(async () => {
    return {
      appServerReady: true,
      cli: {loggedIn: true, method: 'chatgpt' as const, ok: true, raw: 'logged in'},
      codexBin: '/usr/local/bin/codex',
      message: 'Codex connected.',
    }
  }),
  startLogin: mock(() => {
    codexState.currentJob = {error: null, id: 'job-1', state: 'running'}
    return {
      deviceCode: 'ABCD-EFGH',
      deviceUrl: 'https://chatgpt.com/device',
      error: null,
      exitCode: null,
      finishedAt: null,
      id: 'job-1',
      output: [],
      signal: null,
      startedAt: new Date().toISOString(),
      state: 'running' as const,
    }
  }),
}

void mock.module(openAIResponsesTransportModulePath, () => {
  return {invokeOpenAIResponsesModel: openAIResponsesState.invoke, listOpenAIResponseModels: openAIResponsesState.list}
})

void mock.module(anthropicMessagesTransportModulePath, () => {
  return {invokeAnthropicMessagesModel: anthropicState.invoke, listAnthropicMessageModels: anthropicState.list}
})

void mock.module(geminiGenerateContentTransportModulePath, () => {
  return {invokeGeminiGenerateContentModel: googleState.invoke, listGeminiModels: googleState.list}
})

void mock.module(codexAppTransportModulePath, () => {
  return {
    getCodexAppDeviceLoginJob: (id: string) => {
      return codexState.currentJob?.id === id ? codexState.currentJob : null
    },
    getCodexAppHealthResult: codexState.health,
    getCodexAppRuntimeStatus: codexState.runtimeStatus,
    getCurrentCodexAppDeviceLoginJob: () => {
      return codexState.currentJob
    },
    invokeCodexAppModel: codexState.invoke,
    listCodexAppModels: codexState.list,
    startCodexAppDeviceLogin: codexState.startLogin,
  }
})

const loadOpenAIAdapter = () => {
  return import('./openaiAdapter.ts')
}

const loadAnthropicAdapter = () => {
  return import('./anthropicAdapter.ts')
}

const loadGoogleAdapter = () => {
  return import('./googleAdapter.ts')
}

const loadCodexAdapter = () => {
  return import('./codexAdapter.ts')
}

const getRuntimeCredentials = (baseURL: string) => {
  return {apiKey: 'test-key', baseURL, headers: {}, secretRef: 'env:TEST_KEY'}
}

const getCatalog = (kind: 'openai' | 'anthropic' | 'google' | 'codex', label: string) => {
  return {
    defaultBaseURL: null,
    description: label,
    kind,
    label,
    requiresApiKey: kind !== 'codex',
    supportsDiscovery: true,
    supportsWorkerUrls: false,
  }
}

test('openai adapter delegates health and invoke to responses transport', async () => {
  openAIResponsesState.list.mockClear()
  openAIResponsesState.invoke.mockClear()
  const {createOpenAIAdapter} = await loadOpenAIAdapter()
  const adapter = createOpenAIAdapter(getCatalog('openai', 'OpenAI API'))

  const health = await adapter.health({
    connection: null as never,
    runtimeCredentials: getRuntimeCredentials('https://api.openai.com/v1'),
  })
  const result = await adapter.invoke({
    connection: null as never,
    model: {modelName: 'gpt-4.1', name: 'gpt-4.1', remoteModelId: 'gpt-4.1'} as never,
    request: {
      maxCompletionTokens: 100,
      outputSchema: {type: 'object'},
      prompt: 'hello',
      systemPrompt: 'system',
      temperature: 0.2,
    },
    runtimeCredentials: getRuntimeCredentials('https://api.openai.com/v1'),
  })

  expect(health.ok).toBe(true)
  expect(result.text).toBe('openai-response')
  expect(openAIResponsesState.list).toHaveBeenCalledTimes(1)
  expect(openAIResponsesState.invoke).toHaveBeenCalledTimes(1)
})

test('anthropic adapter delegates health and invoke to messages transport', async () => {
  anthropicState.list.mockClear()
  anthropicState.invoke.mockClear()
  const {createAnthropicAdapter} = await loadAnthropicAdapter()
  const adapter = createAnthropicAdapter(getCatalog('anthropic', 'Anthropic'))

  const health = await adapter.health({
    connection: null as never,
    runtimeCredentials: getRuntimeCredentials('https://api.anthropic.com/v1'),
  })
  const result = await adapter.invoke({
    connection: null as never,
    model: {modelName: 'claude-sonnet', name: 'claude-sonnet', remoteModelId: 'claude-sonnet'} as never,
    request: {
      maxCompletionTokens: 100,
      outputSchema: {type: 'object'},
      prompt: 'hello',
      systemPrompt: 'system',
      temperature: 0.2,
    },
    runtimeCredentials: getRuntimeCredentials('https://api.anthropic.com/v1'),
  })

  expect(health.ok).toBe(true)
  expect(result.text).toBe('anthropic-response')
  expect(anthropicState.list).toHaveBeenCalledTimes(1)
  expect(anthropicState.invoke).toHaveBeenCalledTimes(1)
})

test('google adapter delegates health and invoke to generate-content transport', async () => {
  googleState.list.mockClear()
  googleState.invoke.mockClear()
  const {createGoogleAdapter} = await loadGoogleAdapter()
  const adapter = createGoogleAdapter(getCatalog('google', 'Google'))

  const health = await adapter.health({
    connection: null as never,
    runtimeCredentials: getRuntimeCredentials('https://generativelanguage.googleapis.com/v1beta'),
  })
  const result = await adapter.invoke({
    connection: null as never,
    model: {modelName: 'gemini-2.5-pro', name: 'gemini-2.5-pro', remoteModelId: 'gemini-2.5-pro'} as never,
    request: {
      maxCompletionTokens: 100,
      outputSchema: {type: 'object'},
      prompt: 'hello',
      systemPrompt: 'system',
      temperature: 0.2,
    },
    runtimeCredentials: getRuntimeCredentials('https://generativelanguage.googleapis.com/v1beta'),
  })

  expect(health.ok).toBe(true)
  expect(result.text).toBe('google-response')
  expect(googleState.list).toHaveBeenCalledTimes(1)
  expect(googleState.invoke).toHaveBeenCalledTimes(1)
})

test('codex adapter composes health from runtime status and model listing', async () => {
  codexState.health.mockClear()
  codexState.list.mockClear()
  codexState.invoke.mockClear()
  codexState.runtimeStatus.mockClear()
  const {createCodexAdapter} = await loadCodexAdapter()
  const adapter = createCodexAdapter(getCatalog('codex', 'Codex App'))

  const health = await adapter.health({
    connection: null as never,
    runtimeCredentials: {apiKey: null, baseURL: null, headers: {}, secretRef: null},
  })
  const result = await adapter.invoke({
    connection: null as never,
    model: {modelName: 'codex-mini', name: 'codex-mini', remoteModelId: 'codex-mini', version: 'medium'} as never,
    request: {
      maxCompletionTokens: 100,
      outputSchema: {type: 'object'},
      prompt: 'hello',
      systemPrompt: 'system',
      temperature: 0.2,
    },
    runtimeCredentials: {apiKey: null, baseURL: null, headers: {}, secretRef: null},
  })

  expect(health.ok).toBe(true)
  expect(health.modelCount).toBe(1)
  expect(result.text).toBe('codex-response')
  expect(codexState.health).toHaveBeenCalledTimes(1)
  expect(codexState.list).toHaveBeenCalledTimes(1)
  expect(codexState.invoke).toHaveBeenCalledTimes(1)
})

test('openai adapter begin/finish auth lifecycle handles API key flow', async () => {
  const {createOpenAIAdapter} = await loadOpenAIAdapter()
  const adapter = createOpenAIAdapter(getCatalog('openai', 'OpenAI API'))

  const beginResult = await adapter.beginAuth?.({connection: null, providerKind: 'openai'})
  const finishResult = await adapter.finishAuth?.({
    connection: null,
    payload: {authMode: 'api-key', secretValue: 'test-key'},
    providerKind: 'openai',
  })

  expect(beginResult?.status).toBe('pending')
  expect(finishResult?.status).toBe('complete')
  expect(finishResult?.payload?.secretValue).toBe('test-key')
})

test('codex adapter begin auth starts device login when not connected', async () => {
  codexState.currentJob = null
  codexState.startLogin.mockClear()
  codexState.runtimeStatus.mockImplementationOnce(async () => {
    return {
      appServerReady: false,
      cli: {loggedIn: false, method: null, ok: true, raw: 'not logged in'} as never,
      codexBin: '/usr/local/bin/codex',
      message: 'Codex not logged in.',
    }
  })
  const {createCodexAdapter} = await loadCodexAdapter()
  const adapter = createCodexAdapter(getCatalog('codex', 'Codex App'))
  const result = await adapter.beginAuth?.({connection: null, providerKind: 'codex'})

  expect(result?.status).toBe('pending')
  expect(codexState.startLogin).toHaveBeenCalledTimes(1)
})
