import {expect, test} from 'bun:test'

import {getOpenAIMessageText} from './providerTransportUtils.ts'

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
