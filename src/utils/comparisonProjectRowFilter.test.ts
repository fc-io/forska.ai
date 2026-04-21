import {expect, test} from 'bun:test'

import {
  getComparisonProjectPassesRowFilter,
  getComparisonProjectRowFilterLabel,
  getNormalizedComparisonProjectRowFilter,
} from './comparisonProjectRowFilter.ts'

test('rowFilter normalization defaults missing and invalid values to multiple answers', () => {
  expect(getNormalizedComparisonProjectRowFilter(undefined)).toBe('multiple-answers')
  expect(getNormalizedComparisonProjectRowFilter('not-a-filter')).toBe('multiple-answers')
  expect(getNormalizedComparisonProjectRowFilter('fully-answered')).toBe('fully-answered')
  expect(getNormalizedComparisonProjectRowFilter('all')).toBe('all')
})

test('rowFilter labels cover prompt and summary mode language', () => {
  expect(getComparisonProjectRowFilterLabel('multiple-answers', false)).toBe('Rows with more than 1 answered prompt')
  expect(getComparisonProjectRowFilterLabel('multiple-answers', true)).toBe('Rows with more than 1 answer')
  expect(getComparisonProjectRowFilterLabel('fully-answered', false)).toBe('Rows where all shown columns are answered')
  expect(getComparisonProjectRowFilterLabel('all', false)).toBe('All rows')
})

test('rowFilter evaluation keeps prompt and summary sparse row semantics separate', () => {
  const baseEvaluation = {
    answeredColumnCount: 1,
    answeredPromptCount: 1,
    hasAllHumanColumns: false,
    hasAllLlmColumns: true,
  }

  expect(
    getComparisonProjectPassesRowFilter({
      ...baseEvaluation,
      answeredPromptCount: 2,
      isSummaryMode: false,
      rowFilter: 'multiple-answers',
    }),
  ).toBe(true)
  expect(
    getComparisonProjectPassesRowFilter({
      ...baseEvaluation,
      answeredColumnCount: 2,
      isSummaryMode: true,
      rowFilter: 'multiple-answers',
    }),
  ).toBe(true)
  expect(
    getComparisonProjectPassesRowFilter({...baseEvaluation, isSummaryMode: false, rowFilter: 'fully-answered'}),
  ).toBe(false)
  expect(getComparisonProjectPassesRowFilter({...baseEvaluation, isSummaryMode: false, rowFilter: 'all'})).toBe(true)
})
