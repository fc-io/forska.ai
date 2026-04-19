import {afterEach, expect, mock, test} from 'bun:test'

import {invokeAnthropicMessagesModel, listAnthropicMessageModels} from './anthropicMessagesTransport.ts'
import {ProviderInvocationError} from '../providerTypes.ts'

const originalFetch = globalThis.fetch
const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => {
  return new Response(JSON.stringify({data: [{display_name: 'Claude Opus 4.7', id: 'claude-opus-4-7'}]}), {
    headers: {'content-type': 'application/json'},
    status: 200,
  })
})

const getRequestBody = (index: number): unknown => {
  const body = fetchMock.mock.calls[index]?.[1]?.body

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
  expect(getRequestBody(0)).toEqual({
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

  expect(getRequestBody(0)).toEqual({
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

  expect(getRequestBody(0)).toEqual({
    max_tokens: 32,
    messages: [{content: 'Hello', role: 'user'}],
    model: 'claude-opus-4-7',
    output_config: {effort: 'xhigh', format: {schema: {type: 'object'}, type: 'json_schema'}},
    system: 'Return JSON',
    thinking: {display: 'omitted', type: 'adaptive'},
  })
})

test('continues Anthropic pause_turn responses until text arrives', async () => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        content: [{signature: 'sig_1', thinking: 'working', type: 'thinking'}],
        stop_reason: 'pause_turn',
        usage: {input_tokens: 2, output_tokens: 24},
      }),
      {headers: {'content-type': 'application/json'}, status: 200},
    )
  })
  fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        content: [{text: '{"answer":"no","explanation":"No intervention is described.","quotes":[]}', type: 'text'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 3, output_tokens: 12},
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
    version: 'max',
  })

  expect(result).toEqual({
    stopReason: 'end_turn',
    text: '{"answer":"no","explanation":"No intervention is described.","quotes":[]}',
    usage: {completionTokens: 36, promptTokens: 5, totalTokens: 41},
  })
  expect(getRequestBody(1)).toEqual({
    max_tokens: 32,
    messages: [
      {content: 'Hello', role: 'user'},
      {content: [{signature: 'sig_1', thinking: 'working', type: 'thinking'}], role: 'assistant'},
    ],
    model: 'claude-opus-4-7',
    output_config: {effort: 'max', format: {schema: {type: 'object'}, type: 'json_schema'}},
    system: 'Return JSON',
    thinking: {display: 'omitted', type: 'adaptive'},
  })
})

test('retries without thinking after an empty thinking-only response', async () => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        content: [{data: 'sig_1', type: 'redacted_thinking'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 2, output_tokens: 24},
      }),
      {headers: {'content-type': 'application/json'}, status: 200},
    )
  })
  fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        content: [{text: '{"answer":"no","explanation":"No intervention is described.","quotes":[]}', type: 'text'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 3, output_tokens: 12},
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
    version: 'max',
  })

  expect(result).toEqual({
    stopReason: 'end_turn',
    text: '{"answer":"no","explanation":"No intervention is described.","quotes":[]}',
    usage: {completionTokens: 36, promptTokens: 5, totalTokens: 41},
  })
  expect(getRequestBody(0)).toEqual({
    max_tokens: 32,
    messages: [{content: 'Hello', role: 'user'}],
    model: 'claude-opus-4-7',
    output_config: {effort: 'max', format: {schema: {type: 'object'}, type: 'json_schema'}},
    system: 'Return JSON',
    thinking: {display: 'omitted', type: 'adaptive'},
  })
  expect(getRequestBody(1)).toEqual({
    max_tokens: 32,
    messages: [{content: 'Hello', role: 'user'}],
    model: 'claude-opus-4-7',
    output_config: {format: {schema: {type: 'object'}, type: 'json_schema'}},
    system: 'Return JSON',
  })
})

test('throws a classified error when Anthropic still returns no text after fallback', async () => {
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        content: [{data: 'sig_1', type: 'redacted_thinking'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 2, output_tokens: 24},
      }),
      {headers: {'content-type': 'application/json'}, status: 200},
    )
  })
  fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        content: [{type: 'redacted_thinking'}],
        stop_reason: 'end_turn',
        usage: {input_tokens: 3, output_tokens: 12},
      }),
      {headers: {'content-type': 'application/json'}, status: 200},
    )
  })

  const error = await invokeAnthropicMessagesModel({
    apiKey: 'test-key',
    baseURL: 'https://api.anthropic.com/v1',
    maxCompletionTokens: 32,
    modelName: 'claude-opus-4-7',
    outputSchema: {type: 'object'},
    prompt: 'Hello',
    systemPrompt: 'Return JSON',
    temperature: 0.2,
    version: 'max',
  }).then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught
    },
  )

  expect(error).toBeInstanceOf(ProviderInvocationError)
  expect(error instanceof ProviderInvocationError ? error.code : null).toBe('anthropic_empty_response')
  expect(error instanceof ProviderInvocationError ? error.usage : null).toEqual({
    completionTokens: 36,
    promptTokens: 5,
    totalTokens: 41,
  })
  expect(error instanceof Error ? error.message : null).toContain('failure_code=anthropic_empty_response')
})
