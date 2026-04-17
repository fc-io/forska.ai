import {afterEach, expect, mock, test} from 'bun:test'

import {invokeAnthropicMessagesModel, listAnthropicMessageModels} from './anthropicMessagesTransport.ts'

const originalFetch = globalThis.fetch
const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => {
  return new Response(JSON.stringify({data: [{display_name: 'Claude Opus 4.7', id: 'claude-opus-4-7'}]}), {
    headers: {'content-type': 'application/json'},
    status: 200,
  })
})

afterEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify({data: [{display_name: 'Claude Opus 4.7', id: 'claude-opus-4-7'}]}), {
      headers: {'content-type': 'application/json'},
      status: 200,
    })
  })
  globalThis.fetch = originalFetch
})

test('lists Anthropic models from the models endpoint', async () => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

  const models = await listAnthropicMessageModels({
    apiKey: 'test-key',
    baseURL: 'https://api.anthropic.com/v1',
    providerLabel: 'Anthropic',
  })

  expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', expect.any(Object))
  expect(models).toEqual([
    {
      displayName: 'Claude Opus 4.7',
      metadataJson: {display_name: 'Claude Opus 4.7', id: 'claude-opus-4-7'},
      modelName: 'claude-opus-4-7',
      remoteModelId: 'claude-opus-4-7',
      variant: null,
      version: null,
    },
  ])
})

test('includes Anthropic error details and request id on failed message requests', async () => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        error: {message: 'model claude-opus-4-7 is not available for this workspace', type: 'invalid_request_error'},
        request_id: 'req_123',
      }),
      {headers: {'content-type': 'application/json', 'request-id': 'req_123'}, status: 400},
    )
  })

  await expect(
    invokeAnthropicMessagesModel({
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com/v1',
      maxCompletionTokens: 2000,
      modelName: 'claude-opus-4-7',
      prompt: 'Hello',
      systemPrompt: 'Return JSON',
      temperature: 0.2,
    }),
  ).rejects.toThrow(
    'Anthropic request failed (400): [invalid_request_error] model claude-opus-4-7 is not available for this workspace request_id=req_123',
  )
})
