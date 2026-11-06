import {expect, test} from 'bun:test'

import {getOpenAICompatibleUsage, getOpenAIMessageText} from './providerTransportUtils.ts'

test('returns assistant content string without reasoning fallback', () => {
  expect(
    getOpenAIMessageText({
      content: '{"answer":"yes"}',
      reasoning_content: 'Thinking Process:\n\n{"answer":"no"}',
      role: 'assistant',
    } as never),
  ).toBe('{"answer":"yes"}')
})

test('returns empty string when only reasoning content is present', () => {
  expect(
    getOpenAIMessageText({
      content: null,
      reasoning_content: 'Thinking Process:\n\n{"answer":"yes"}',
      role: 'assistant',
    } as never),
  ).toBe('')
})

test('maps OpenAI-compatible cached prompt and reasoning tokens, NULL when the server omits them', () => {
  expect(
    getOpenAICompatibleUsage({
      completion_tokens: 50,
      completion_tokens_details: {reasoning_tokens: 40},
      prompt_tokens: 900,
      prompt_tokens_details: {cached_tokens: 512},
      total_tokens: 950,
    }),
  ).toEqual({
    cacheCreationInputTokens: null,
    cacheReadInputTokens: 512,
    completionTokens: 50,
    promptTokens: 900,
    thinkingTokens: 40,
    totalTokens: 950,
  })
  expect(getOpenAICompatibleUsage({completion_tokens: 5, prompt_tokens: 9, total_tokens: 14})).toEqual({
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    completionTokens: 5,
    promptTokens: 9,
    thinkingTokens: null,
    totalTokens: 14,
  })
  expect(getOpenAICompatibleUsage(null).cacheReadInputTokens).toBeNull()
})
