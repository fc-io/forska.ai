import {expect, test} from 'bun:test'

import {getOpenAIChatCompletionRequest, isQwen35Model} from './openaiChatTransport.ts'

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
  expect(request.presence_penalty).toBe(2.0)
  expect(request.extra_body).toEqual({chat_template_kwargs: {enable_thinking: false}, top_k: 40})
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

  expect(request.extra_body).toEqual({chat_template_kwargs: {enable_thinking: false}, top_k: 40})
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
  expect(request.presence_penalty).toBeUndefined()
  expect(request.extra_body).toBeUndefined()
})
