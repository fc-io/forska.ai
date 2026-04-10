import {expect, test} from 'bun:test'

import {getOpenAIChatCompletionRequest, getOpenAIListedModels, isQwen35Model} from './openaiChatTransport.ts'

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
