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

test('single prompt quote validation normalizes apostrophes back to the source substring', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: [
        "Our purpose is to characterise lesions' features, helping diagnose, treat and emphasize the relevance of an adequate anamnesis.",
      ],
    },
    lastResponse: '{"answer":"no"}',
    maxRetries: 2,
    recordText:
      'Our purpose is to characterise lesions’ features, helping diagnose, treat and emphasize the relevance of an adequate anamnesis.',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: [
        'Our purpose is to characterise lesions’ features, helping diagnose, treat and emphasize the relevance of an adequate anamnesis.',
      ],
    },
    kind: 'valid',
  })
})

test('single prompt quote validation normalizes internal double quotes back to the source substring', () => {
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: ['The leading causes were dose selection (C3) (1264, 61.9%) and "other domain" (C9) (543, 26.6%)'],
    },
    lastResponse: '{"answer":"no"}',
    maxRetries: 2,
    recordText: 'The leading causes were dose selection (C3) (1264, 61.9%) and “other domain” (C9) (543, 26.6%)',
    retryBasePrompt: 'base prompt',
  })

  expect(result).toEqual({
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: ['The leading causes were dose selection (C3) (1264, 61.9%) and “other domain” (C9) (543, 26.6%)'],
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

test('single prompt quote validation drops criteria quotes when article quotes remain valid', () => {
  const retryBasePrompt = `## article_title

Barriers in implementing antibiotic stewardship programmes at paediatric units in academic hospitals in Thailand

## article_summary

OBJECTIVE: To explore the barriers that hinder and the facilitators that strengthen the implementation of the antimicrobial stewardship (AMS) programme at paediatric units in academic hospitals in Thailand.

## Question

Inclusion criteria:
Antimicrobial stewardship can also be an intervention`
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: [
        'implementation of the antimicrobial stewardship (AMS) programme at paediatric units in academic hospitals in Thailand',
        'Antimicrobial stewardship can also be an intervention',
      ],
    },
    lastResponse: '{"answer":"yes"}',
    maxRetries: 2,
    recordText:
      'Barriers in implementing antibiotic stewardship programmes at paediatric units in academic hospitals in Thailand\n\nOBJECTIVE: To explore the barriers that hinder and the facilitators that strengthen the implementation of the antimicrobial stewardship (AMS) programme at paediatric units in academic hospitals in Thailand.',
    retryBasePrompt,
  })

  expect(result).toEqual({
    judgment: {
      answer: 'yes',
      explanation: 'because',
      quotes: [
        'implementation of the antimicrobial stewardship (AMS) programme at paediatric units in academic hospitals in Thailand',
      ],
    },
    kind: 'valid',
  })
})

test('single prompt quote validation accepts empty quotes when only criteria text was quoted', () => {
  const retryBasePrompt = `## article_title

Antibiotic use and resistance: Information sources and application by dentists in Jordan.

## article_summary

The present study aimed to evaluate dentists' preferred sources of information.

## Question

Inclusion criteria:
Interventions aimed at improving antibiotic prescribing/use`
  const result = validateSinglePromptJudgmentQuotes({
    attempt: 1,
    judgment: {
      answer: 'no',
      explanation: 'because',
      quotes: ['Interventions aimed at improving antibiotic prescribing/use'],
    },
    lastResponse: '{"answer":"no"}',
    maxRetries: 2,
    recordText:
      "Antibiotic use and resistance: Information sources and application by dentists in Jordan.\n\nThe present study aimed to evaluate dentists' preferred sources of information.",
    retryBasePrompt,
  })

  expect(result).toEqual({judgment: {answer: 'no', explanation: 'because', quotes: []}, kind: 'valid'})
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
    expect(result.nextPrompt).toContain(
      'never from the question, inclusion criteria, exclusion criteria, or any instructions',
    )
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
