import {afterEach, expect, mock, test} from 'bun:test'

import {invokeAnthropicMessagesModel, listAnthropicMessageModels} from './anthropicMessagesTransport.ts'

const originalFetch = globalThis.fetch
const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => {
  return new Response(JSON.stringify({data: [{display_name: 'Claude Opus 4.7', id: 'claude-opus-4-7'}]}), {
    headers: {'content-type': 'application/json'},
    status: 200,
  })
})

const getFirstRequestBody = (): unknown => {
  const body = fetchMock.mock.calls[0]?.[1]?.body

  return typeof body === 'string' ? (JSON.parse(body) as unknown) : null
}

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

  const error = await invokeAnthropicMessagesModel({
    apiKey: 'test-key',
    baseURL: 'https://api.anthropic.com/v1',
    maxCompletionTokens: 2000,
    modelName: 'claude-opus-4-7',
    outputSchema: {type: 'object'},
    prompt: 'Hello',
    systemPrompt: 'Return JSON',
    temperature: 0.2,
    version: null,
  }).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught
    },
  )

  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error ? error.message : null).toBe(
    'Anthropic request failed (400): [invalid_request_error] model claude-opus-4-7 is not available for this workspace request_id=req_123',
  )
})

test('omits temperature for claude-opus-4-7 requests', async () => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        content: [{text: 'Hello', type: 'text'}],
        stop_reason: 'max_tokens',
        usage: {input_tokens: 1, output_tokens: 1},
      }),
      {headers: {'content-type': 'application/json'}, status: 200},
    )
  })

  const result = await invokeAnthropicMessagesModel({
    apiKey: 'test-key',
    baseURL: 'https://api.anthropic.com/v1',
    maxCompletionTokens: 32,
    modelName: 'claude-opus-4-7',
    outputSchema: {type: 'object'},
    prompt: 'Hello',
    systemPrompt: 'Return JSON',
    temperature: 0.2,
    version: null,
  })

  expect(result.stopReason).toBe('max_tokens')
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({method: 'POST'})
  expect(getFirstRequestBody()).toEqual({
    max_tokens: 32,
    messages: [{content: 'Hello', role: 'user'}],
    model: 'claude-opus-4-7',
    output_config: {format: {schema: {type: 'object'}, type: 'json_schema'}},
    system: 'Return JSON',
  })
})

test('keeps temperature for Anthropic models that still accept it', async () => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({content: [{text: 'Hello', type: 'text'}], usage: {input_tokens: 1, output_tokens: 1}}),
      {headers: {'content-type': 'application/json'}, status: 200},
    )
  })

  await invokeAnthropicMessagesModel({
    apiKey: 'test-key',
    baseURL: 'https://api.anthropic.com/v1',
    maxCompletionTokens: 32,
    modelName: 'claude-sonnet-4-6',
    outputSchema: {type: 'object'},
    prompt: 'Hello',
    systemPrompt: 'Return JSON',
    temperature: 0.2,
    version: null,
  })

  expect(getFirstRequestBody()).toEqual({
    max_tokens: 32,
    messages: [{content: 'Hello', role: 'user'}],
    model: 'claude-sonnet-4-6',
    output_config: {format: {schema: {type: 'object'}, type: 'json_schema'}},
    system: 'Return JSON',
    temperature: 0.2,
  })
})

test('uses adaptive thinking and effort for Anthropic effort variants', async () => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({content: [{text: 'Hello', type: 'text'}], usage: {input_tokens: 1, output_tokens: 1}}),
      {headers: {'content-type': 'application/json'}, status: 200},
    )
  })

  await invokeAnthropicMessagesModel({
    apiKey: 'test-key',
    baseURL: 'https://api.anthropic.com/v1',
    maxCompletionTokens: 32,
    modelName: 'claude-opus-4-7',
    outputSchema: {type: 'object'},
    prompt: 'Hello',
    systemPrompt: 'Return JSON',
    temperature: 0.2,
    version: 'xhigh',
  })

  expect(getFirstRequestBody()).toEqual({
    max_tokens: 32,
    messages: [{content: 'Hello', role: 'user'}],
    model: 'claude-opus-4-7',
    output_config: {effort: 'xhigh', format: {schema: {type: 'object'}, type: 'json_schema'}},
    system: 'Return JSON',
    thinking: {display: 'omitted', type: 'adaptive'},
  })
})
