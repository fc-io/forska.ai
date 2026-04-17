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

test('single prompt quote validation accepts quotes wrapped in harmless outer quotes', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: ['"Effect of an educational intervention among Lebanese dentists"'],
    },
    lastResponse: '{"answer":"yes"}',
    maxRetries: 2,
    recordText: 'Effect of an educational intervention among Lebanese dentists on antibiotic prescribing.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: ['Effect of an educational intervention among Lebanese dentists'],
    },
    kind: 'valid',
  })
})

test('single prompt quote validation accepts quotes wrapped in smart quotes', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: ['\u201cEffect of an educational intervention among Lebanese dentists\u201d'],
    },
    lastResponse: '{"answer":"yes"}',
    maxRetries: 2,
    recordText: 'Effect of an educational intervention among Lebanese dentists on antibiotic prescribing.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: ['Effect of an educational intervention among Lebanese dentists'],
    },
    kind: 'valid',
  })
})

test('single prompt quote validation keeps exact quotes that already include source quotation marks', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'yes', explanation: 'because', quotes: ['"Intervention arm"']},
    lastResponse: '{"answer":"yes"}',
    maxRetries: 2,
    recordText: 'The report labels this cohort as "Intervention arm" in the methods section.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {answer: 'yes', explanation: 'because', quotes: ['"Intervention arm"']},
    kind: 'valid',
  })
})

test('single prompt quote validation still rejects ellipsized quotes', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {answer: 'no', explanation: 'because', quotes: ['Local article...text only.']},
    lastResponse: '{"answer":"no","quotes":["Local article...text only."]}',
    maxRetries: 2,
    recordText: 'Local article text only.',
    retryBasePrompt: 'base prompt',
  })

  expect(result.kind).toBe('retry')
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
    expect(result.nextPrompt).toContain('Do not add surrounding quotation marks unless they appear in the source text.')
    expect(result.nextPrompt).toContain('Do not shorten quotes with ellipses.')
    expect(result.nextPrompt).toContain('Do not include wrapper markers in quotes.')
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
