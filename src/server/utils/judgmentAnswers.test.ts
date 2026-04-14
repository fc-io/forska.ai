import {expect, test} from 'bun:test'

import {deriveStrictSummaryAnswer, getNormalizedSummaryAnswer, normalizeSummaryAnswerValue} from './judgmentAnswers.ts'

test('normalizeSummaryAnswerValue normalizes summary answers conservatively', () => {
  expect(normalizeSummaryAnswerValue(' yes ')).toBe('yes')
  expect(normalizeSummaryAnswerValue('NO')).toBe('no')
  expect(normalizeSummaryAnswerValue('maybe')).toBe('maybe')
  expect(normalizeSummaryAnswerValue('  custom ')).toBe('maybe')
  expect(normalizeSummaryAnswerValue('   ')).toBeNull()
  expect(normalizeSummaryAnswerValue(null)).toBeNull()
})

test('getNormalizedSummaryAnswer reuses judgment answer parsing before summary normalization', () => {
  expect(getNormalizedSummaryAnswer({answeredOriginal: ' yes '})).toBe('yes')
  expect(getNormalizedSummaryAnswer({answeredOriginal: '["no"]'})).toBe('no')
  expect(getNormalizedSummaryAnswer({answeredOriginal: '["unexpected"]'})).toBe('maybe')
  expect(getNormalizedSummaryAnswer({answeredOriginal: null, answeredOriginalAsArray: [' maybe ']})).toBe('maybe')
  expect(getNormalizedSummaryAnswer({answeredOriginal: null})).toBeNull()
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
