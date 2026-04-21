import {expect, test} from 'bun:test'

import {
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
