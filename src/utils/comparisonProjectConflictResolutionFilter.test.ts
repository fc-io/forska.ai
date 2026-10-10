import {expect, test} from 'bun:test'

import {
  getComparisonProjectConflictResolutionProvenanceFilterOptions,
  getNormalizedComparisonProjectConflictResolutionProvenanceFilters,
} from './comparisonProjectConflictResolutionFilter.ts'

test('resolution prompt filter options map each provenance value to its label', () => {
  expect(getComparisonProjectConflictResolutionProvenanceFilterOptions()).toEqual([
    {label: 'Current prompts', value: 'current'},
    {label: 'Older prompts', value: 'outdated'},
    {label: 'Unknown', value: 'unknown'},
  ])
})

test('resolution prompt filters normalize to canonical order and drop unknown values', () => {
  expect(getNormalizedComparisonProjectConflictResolutionProvenanceFilters('unknown,current,bogus,current')).toEqual([
    'current',
    'unknown',
  ])
  expect(getNormalizedComparisonProjectConflictResolutionProvenanceFilters(['outdated', ' unknown '])).toEqual([
    'outdated',
    'unknown',
  ])
  expect(getNormalizedComparisonProjectConflictResolutionProvenanceFilters('all')).toEqual([])
  expect(getNormalizedComparisonProjectConflictResolutionProvenanceFilters(undefined)).toEqual([])
})
