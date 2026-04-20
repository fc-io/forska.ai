import {expect, test} from 'bun:test'

import {getRetryPromptForFailure} from './judge.ts'

test('retries anthropic empty responses with the original prompt', () => {
  const basePrompt = 'Return valid JSON only.'

  expect(
    getRetryPromptForFailure({
      basePrompt,
      failureCode: 'anthropic_refusal_empty_response',
      lastError: 'Anthropic returned no text content',
      lastResponse: '',
    }),
  ).toBe(basePrompt)
})

test('retries non-provider-empty failures with schema guidance', () => {
  const retryPrompt = getRetryPromptForFailure({
    basePrompt: 'Return valid JSON only.',
    failureCode: null,
    lastError: 'JSON Parse error: Unexpected EOF',
    lastResponse: '{"answer":"yes"',
  })

  expect(retryPrompt).toContain('Your previous answer did not match the required JSON schema')
  expect(retryPrompt).toContain('JSON Parse error: Unexpected EOF')
  expect(retryPrompt).toContain('{"answer":"yes"')
})
