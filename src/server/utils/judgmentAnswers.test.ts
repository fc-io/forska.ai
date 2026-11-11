import {expect, test} from 'bun:test'

import {
  deriveStrictSummaryAnswer,
  getNormalizedSummaryAnswer,
  normalizePromptSummaryAnswerValue,
  normalizeSummaryAnswerValue,
} from './judgmentAnswers.ts'

test('normalizeSummaryAnswerValue normalizes summary answers conservatively', () => {
  expect(normalizeSummaryAnswerValue(' yes ')).toBe('yes')
  expect(normalizeSummaryAnswerValue('NO')).toBe('no')
  expect(normalizeSummaryAnswerValue('maybe')).toBe('maybe')
  expect(normalizeSummaryAnswerValue('  custom ')).toBe('maybe')
  expect(normalizeSummaryAnswerValue('include')).toBe('maybe')
  expect(normalizeSummaryAnswerValue('   ')).toBeNull()
  expect(normalizeSummaryAnswerValue(null)).toBeNull()
})

test('getNormalizedSummaryAnswer reuses judgment answer parsing before summary normalization', () => {
  expect(getNormalizedSummaryAnswer({answeredOriginal: ' yes '}, 'include')).toBe('yes')
  expect(getNormalizedSummaryAnswer({answeredOriginal: '["no"]'}, 'exclude')).toBe('no')
  expect(getNormalizedSummaryAnswer({answeredOriginal: '["unexpected"]'}, 'combined')).toBe('maybe')
  expect(getNormalizedSummaryAnswer({answeredOriginal: null, answeredOriginalAsArray: [' maybe ']}, 'include')).toBe(
    'maybe',
  )
  expect(getNormalizedSummaryAnswer({answeredOriginal: null}, 'include')).toBeNull()
})

test('normalizePromptSummaryAnswerValue keeps yes, no and maybe whatever the disposition', () => {
  expect(
    (['include', 'exclude', 'combined', null] as const).map((criteriaDisposition) => {
      return ['yes', ' NO ', 'maybe', 'custom', '  '].map((value) => {
        return normalizePromptSummaryAnswerValue(value, criteriaDisposition)
      })
    }),
  ).toEqual([
    ['yes', 'no', 'maybe', 'maybe', null],
    ['yes', 'no', 'maybe', 'maybe', null],
    ['yes', 'no', 'maybe', 'maybe', null],
    ['yes', 'no', 'maybe', 'maybe', null],
  ])
})

test('normalizePromptSummaryAnswerValue maps include and exclude into criterion-match answers by disposition', () => {
  expect(normalizePromptSummaryAnswerValue('include', 'include')).toBe('yes')
  expect(normalizePromptSummaryAnswerValue(' Exclude ', 'include')).toBe('no')
  expect(normalizePromptSummaryAnswerValue('include', 'combined')).toBe('yes')
  expect(normalizePromptSummaryAnswerValue('exclude', 'combined')).toBe('no')
  expect(normalizePromptSummaryAnswerValue('include', 'exclude')).toBe('no')
  expect(normalizePromptSummaryAnswerValue('EXCLUDE', 'exclude')).toBe('yes')
  expect(normalizePromptSummaryAnswerValue('include', null)).toBe('yes')
  expect(normalizePromptSummaryAnswerValue('exclude', null)).toBe('no')
})

test('getNormalizedSummaryAnswer keeps multi-valued include/exclude answers as maybe', () => {
  expect(getNormalizedSummaryAnswer({answeredOriginal: '["include","exclude"]'}, 'include')).toBe('maybe')
  expect(getNormalizedSummaryAnswer({answeredOriginal: null, answeredOriginalAsArray: ['exclude']}, 'exclude')).toBe(
    'yes',
  )
})

test('deriveStrictSummaryAnswer derives the screening decision from include/exclude answers', () => {
  const criteria = [
    {promptId: 'inclusion', criteriaDisposition: 'include'},
    {promptId: 'exclusion', criteriaDisposition: 'exclude'},
    {promptId: 'combined', criteriaDisposition: 'combined'},
  ] as const
  const getSummary = (answers: Record<(typeof criteria)[number]['promptId'], string>) => {
    return deriveStrictSummaryAnswer(
      [...criteria],
      criteria.reduce((answerMap, criterion) => {
        return {
          ...answerMap,
          [criterion.promptId]: normalizePromptSummaryAnswerValue(
            answers[criterion.promptId],
            criterion.criteriaDisposition,
          ),
        }
      }, {}),
    )
  }

  expect(getSummary({combined: 'include', exclusion: 'include', inclusion: 'include'})).toBe('yes')
  expect(getSummary({combined: 'include', exclusion: 'exclude', inclusion: 'include'})).toBe('no')
  expect(getSummary({combined: 'include', exclusion: 'include', inclusion: 'exclude'})).toBe('no')
  expect(getSummary({combined: 'exclude', exclusion: 'include', inclusion: 'include'})).toBe('no')
})

test('deriveStrictSummaryAnswer returns no for exclusion yes', () => {
  expect(
    deriveStrictSummaryAnswer(
      [
        {promptId: 'prompt-1', criteriaDisposition: 'include'},
        {promptId: 'prompt-2', criteriaDisposition: 'exclude'},
      ],
      {'prompt-1': 'yes', 'prompt-2': 'yes'},
    ),
  ).toBe('no')
})

test('deriveStrictSummaryAnswer returns no for inclusion no', () => {
  expect(
    deriveStrictSummaryAnswer(
      [
        {promptId: 'prompt-1', criteriaDisposition: 'include'},
        {promptId: 'prompt-2', criteriaDisposition: 'exclude'},
      ],
      {'prompt-1': 'no', 'prompt-2': 'no'},
    ),
  ).toBe('no')
})

test('deriveStrictSummaryAnswer returns maybe when no hard no applies and any answer is maybe', () => {
  expect(
    deriveStrictSummaryAnswer(
      [
        {promptId: 'prompt-1', criteriaDisposition: 'include'},
        {promptId: 'prompt-2', criteriaDisposition: 'exclude'},
      ],
      {'prompt-1': 'maybe', 'prompt-2': 'no'},
    ),
  ).toBe('maybe')
})

test('deriveStrictSummaryAnswer returns no for combined no', () => {
  expect(deriveStrictSummaryAnswer([{promptId: 'prompt-1', criteriaDisposition: 'combined'}], {'prompt-1': 'no'})).toBe(
    'no',
  )
})

test('deriveStrictSummaryAnswer returns maybe for combined maybe', () => {
  expect(
    deriveStrictSummaryAnswer([{promptId: 'prompt-1', criteriaDisposition: 'combined'}], {'prompt-1': 'maybe'}),
  ).toBe('maybe')
})

test('deriveStrictSummaryAnswer returns yes when inclusions and exclusions are fully satisfied', () => {
  expect(
    deriveStrictSummaryAnswer(
      [
        {promptId: 'prompt-1', criteriaDisposition: 'include'},
        {promptId: 'prompt-2', criteriaDisposition: 'exclude'},
      ],
      {'prompt-1': 'yes', 'prompt-2': 'no'},
    ),
  ).toBe('yes')
})

test('deriveStrictSummaryAnswer returns null when an answer is missing', () => {
  expect(
    deriveStrictSummaryAnswer(
      [
        {promptId: 'prompt-1', criteriaDisposition: 'include'},
        {promptId: 'prompt-2', criteriaDisposition: 'exclude'},
      ],
      {'prompt-1': 'yes'},
    ),
  ).toBeNull()
  expect(
    deriveStrictSummaryAnswer(
      [
        {promptId: 'prompt-1', criteriaDisposition: 'combined'},
        {promptId: 'prompt-2', criteriaDisposition: 'exclude'},
      ],
      {'prompt-1': 'yes'},
    ),
  ).toBeNull()
})

test('deriveStrictSummaryAnswer handles zero-inclusion and zero-exclusion projects without special cases', () => {
  expect(deriveStrictSummaryAnswer([{promptId: 'prompt-1', criteriaDisposition: 'exclude'}], {'prompt-1': 'no'})).toBe(
    'yes',
  )
  expect(deriveStrictSummaryAnswer([{promptId: 'prompt-1', criteriaDisposition: 'include'}], {'prompt-1': 'yes'})).toBe(
    'yes',
  )
  expect(
    deriveStrictSummaryAnswer([{promptId: 'prompt-1', criteriaDisposition: 'combined'}], {'prompt-1': 'yes'}),
  ).toBe('yes')
  expect(deriveStrictSummaryAnswer([], {})).toBe('yes')
})

test('deriveStrictSummaryAnswer warns and returns null when enabled prompt criteria metadata is missing', () => {
  const warnings: string[] = []

  expect(
    deriveStrictSummaryAnswer([{promptId: 'prompt-1', criteriaDisposition: null}], {'prompt-1': 'yes'}, (message) => {
      warnings.push(message)
    }),
  ).toBeNull()
  expect(warnings).toEqual([
    'Cannot derive strict summary answer for prompt prompt-1: missing criteria disposition metadata on an enabled summary prompt.',
  ])
})
