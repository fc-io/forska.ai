import {expect, test} from 'bun:test'

import {validateSinglePromptJudgmentQuotes} from '../judge.ts'

test('single prompt quote validation accepts matching quotes', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: ['Effect of an educational intervention among Lebanese dentists'],
    },
    lastResponse: '{"answer":"yes"}',
    maxRetries: 2,
    recordText: 'Effect of an educational intervention among Lebanese dentists on antibiotic prescribing.',
    retryBasePrompt: 'base prompt',
  })

  expect(result.kind).toBe('valid')
})

test('single prompt quote validation requests a retry before the final attempt', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'no', explanation: 'because', quotes: ['foreign quote']},
    lastResponse: '{"answer":"no","quotes":["foreign quote"]}',
    maxRetries: 2,
    recordText: 'Local article text only.',
    retryBasePrompt: 'base prompt',
  })

  expect(result.kind).toBe('retry')

  if (result.kind === 'retry') {
    expect(result.nextPrompt).toContain('foreign quote')
    expect(result.error).toBe('Invalid quotes: not substrings of record text')
  }
})

test('single prompt quote validation requeues after the final invalid attempt', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 2,
    judgment: {answer: 'no', explanation: 'because', quotes: ['foreign quote']},
    lastResponse: '{"answer":"no","quotes":["foreign quote"]}',
    maxRetries: 2,
    recordText: 'Local article text only.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({error: 'Invalid quotes: not substrings of record text', kind: 'requeue'})
})
