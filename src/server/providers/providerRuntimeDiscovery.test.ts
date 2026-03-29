import {afterEach, expect, mock, test} from 'bun:test'

import {discoverOpenAICompatibleRuntimeModel} from './providerRuntimeDiscovery.ts'

const originalFetch = globalThis.fetch

const fetchMock = mock(async (_input: RequestInfo | URL) => {
  return new Response(JSON.stringify({data: [{id: 'model-a'}, {id: 'model-b'}]}), {
    headers: {'content-type': 'application/json'},
    status: 200,
  })
})

afterEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (_input: RequestInfo | URL) => {
    return new Response(JSON.stringify({data: [{id: 'model-a'}, {id: 'model-b'}]}), {
      headers: {'content-type': 'application/json'},
      status: 200,
    })
  })
  globalThis.fetch = originalFetch
})

test('runtime discovery reads saved local OpenAI-compatible endpoints from /v1/models', async () => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

  const result = await discoverOpenAICompatibleRuntimeModel({
    baseURL: 'http://127.0.0.1:1234/v1',
    providerKind: 'llmstudio',
  })

  expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:1234/v1/models', expect.any(Object))
  expect(result).toEqual({
    baseURL: 'http://127.0.0.1:1234/v1',
    contextLength: null,
    modelName: 'model-a',
    modelNames: ['model-a', 'model-b'],
    raw: {data: [{id: 'model-a'}, {id: 'model-b'}]},
    servedModelName: 'model-b',
  })
})

test('runtime discovery prefers Ollama native model discovery for saved endpoints', async () => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL) => {
    return new Response(JSON.stringify({models: [{model: 'llama3.2:latest', name: 'llama3.2:latest'}]}), {
      headers: {'content-type': 'application/json'},
      status: 200,
    })
  })

  const result = await discoverOpenAICompatibleRuntimeModel({
    baseURL: 'http://127.0.0.1:11434/v1',
    providerKind: 'ollama',
  })

  expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', expect.any(Object))
  expect(result).toEqual({
    baseURL: 'http://127.0.0.1:11434/v1',
    contextLength: null,
    modelName: 'llama3.2:latest',
    modelNames: ['llama3.2:latest'],
    raw: {models: [{model: 'llama3.2:latest', name: 'llama3.2:latest'}]},
    servedModelName: 'llama3.2:latest',
  })
})
