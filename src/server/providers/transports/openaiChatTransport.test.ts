import {expect, mock, test} from 'bun:test'

import {
  getOpenAIChatCompletionRequest,
  getOpenAIListedModels,
  invokeOpenAIChatModel,
  isQwen35Model,
} from './openaiChatTransport.ts'

test('detects Qwen3.5 model ids', () => {
  expect(isQwen35Model('Qwen/Qwen3.5-27B')).toBe(true)
  expect(isQwen35Model('Qwen/Qwen3.5-122B-A10B')).toBe(true)
  expect(isQwen35Model('Qwen3.5-27B')).toBe(true)
  expect(isQwen35Model(' qwen/qwen3.5-27b ')).toBe(true)
  expect(isQwen35Model('Qwen/Qwen3-32B')).toBe(false)
  expect(isQwen35Model('meta-llama/Llama-3.3-70B-Instruct')).toBe(false)
})

test('uses Qwen3.5 non-thinking request settings for structured output', () => {
  const request = getOpenAIChatCompletionRequest({
    maxCompletionTokens: 2000,
    modelName: 'Qwen/Qwen3.5-27B',
    outputSchema: {type: 'object'},
    prompt: 'Prompt',
    systemPrompt: 'System',
    temperature: 0.2,
  })

  expect(request.temperature).toBe(1.0)
  expect(request.top_p).toBe(1.0)
  expect(request.top_k).toBe(40)
  expect(request.presence_penalty).toBe(2.0)
  expect(request.chat_template_kwargs).toEqual({enable_thinking: false})
})

test('uses Qwen3.5 thinking request settings when model options enable thinking', () => {
  const request = getOpenAIChatCompletionRequest({
    maxCompletionTokens: 2000,
    modelName: 'Qwen/Qwen3.5-27B',
    modelOptions: {thinking: 'enabled'},
    outputSchema: {type: 'object'},
    prompt: 'Prompt',
    systemPrompt: 'System',
    temperature: 0.2,
  })

  expect(request.chat_template_kwargs).toEqual({enable_thinking: true})
  expect(request.temperature).toBe(1.0)
})

test('uses Qwen3.5 non-thinking request settings without org prefix', () => {
  const request = getOpenAIChatCompletionRequest({
    maxCompletionTokens: 2000,
    modelName: 'Qwen3.5-27B',
    outputSchema: {type: 'object'},
    prompt: 'Prompt',
    systemPrompt: 'System',
    temperature: 0.2,
  })

  expect(request.top_k).toBe(40)
  expect(request.chat_template_kwargs).toEqual({enable_thinking: false})
})

test('keeps default request settings for non-Qwen models', () => {
  const request = getOpenAIChatCompletionRequest({
    maxCompletionTokens: 2000,
    modelName: 'meta-llama/Llama-3.3-70B-Instruct',
    outputSchema: {type: 'object'},
    prompt: 'Prompt',
    systemPrompt: 'System',
    temperature: 0.2,
  })

  expect(request.temperature).toBe(0.2)
  expect(request.top_p).toBeUndefined()
  expect(request.top_k).toBeUndefined()
  expect(request.presence_penalty).toBeUndefined()
  expect(request.chat_template_kwargs).toBeUndefined()
})

test('uses OpenAI-compatible reasoning effort for thinking levels', () => {
  const request = getOpenAIChatCompletionRequest({
    maxCompletionTokens: 2000,
    modelName: 'openai/gpt-oss-120b',
    modelOptions: {thinking: 'max', thinkingMode: 'enabled'},
    outputSchema: {type: 'object'},
    prompt: 'Prompt',
    systemPrompt: 'System',
    temperature: 0.2,
  })

  expect(request.reasoning_effort).toBe('max')
  expect(request.thinking).toEqual({type: 'enabled'})
  expect(request.chat_template_kwargs).toBeUndefined()
})

test('lists OpenAI models without transport-specific variants', () => {
  expect(getOpenAIListedModels({metadataJson: {id: 'Qwen/Qwen3.5-27B'}, modelName: 'Qwen/Qwen3.5-27B'})).toEqual([
    {
      displayName: 'Qwen/Qwen3.5-27B',
      metadataJson: {id: 'Qwen/Qwen3.5-27B'},
      modelName: 'Qwen/Qwen3.5-27B',
      remoteModelId: 'Qwen/Qwen3.5-27B',
      variant: null,
      version: null,
    },
  ])
})

test('maps image prompts to a text part followed by image_url data URIs', () => {
  const request = getOpenAIChatCompletionRequest({
    maxCompletionTokens: 256,
    modelName: 'qwen3-vl:2b-instruct',
    outputSchema: {type: 'object'},
    prompt: {
      images: [
        {bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg'},
        {bytes: new Uint8Array([4, 5]), mimeType: 'image/png'},
      ],
      text: 'Describe the figure.',
    },
    systemPrompt: 'System',
    temperature: 0,
  })

  expect(request.messages).toEqual([
    {content: 'System', role: 'system'},
    {
      content: [
        {text: 'Describe the figure.', type: 'text'},
        {image_url: {url: 'data:image/jpeg;base64,AQID'}, type: 'image_url'},
        {image_url: {url: 'data:image/png;base64,BAU='}, type: 'image_url'},
      ],
      role: 'user',
    },
  ])
})

test('keeps text-only prompts as a plain string user message', () => {
  const request = getOpenAIChatCompletionRequest({
    maxCompletionTokens: 256,
    modelName: 'qwen2.5:1.5b',
    outputSchema: {type: 'object'},
    prompt: 'Prompt',
    systemPrompt: 'System',
    temperature: 0,
  })

  expect(request.messages[1]).toEqual({content: 'Prompt', role: 'user'})
})

test('posts the multipart chat payload over the wire', async () => {
  const originalFetch = globalThis.fetch
  const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        choices: [{finish_reason: 'stop', index: 0, message: {content: '{"description":"x"}', role: 'assistant'}}],
        created: 0,
        id: 'chatcmpl-test',
        model: 'qwen3-vl:2b-instruct',
        object: 'chat.completion',
        usage: {completion_tokens: 3, prompt_tokens: 40, total_tokens: 43},
      }),
      {headers: {'content-type': 'application/json'}, status: 200},
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

  const result = await invokeOpenAIChatModel({
    apiKey: null,
    baseURL: `http://openai-chat-image-${Date.now()}.test/v1`,
    maxCompletionTokens: 256,
    modelName: 'qwen3-vl:2b-instruct',
    outputSchema: {type: 'object'},
    prompt: {images: [{bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg'}], text: 'Describe.'},
    systemPrompt: 'System',
    temperature: 0,
  }).finally(() => {
    globalThis.fetch = originalFetch
  })
  const init = fetchMock.mock.calls[0]?.[1]
  const body = JSON.parse(init?.body as string) as {messages: unknown[]}

  expect(result.text).toBe('{"description":"x"}')
  expect(String(fetchMock.mock.calls[0]?.[0] as string)).toEndWith('/v1/chat/completions')
  expect(body.messages[1]).toEqual({
    content: [
      {text: 'Describe.', type: 'text'},
      {image_url: {url: 'data:image/jpeg;base64,AQID'}, type: 'image_url'},
    ],
    role: 'user',
  })
})
