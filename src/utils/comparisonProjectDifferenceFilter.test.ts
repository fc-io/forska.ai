import {expect, test} from 'bun:test'

import {
  getAvailableComparisonProjectDifferenceFilters,
  getComparisonProjectDifferenceFilterLabel,
  getComparisonProjectHasDifferenceFilterMatch,
  getNormalizedComparisonProjectDifferenceFilter,
} from './comparisonProjectDifferenceFilter.ts'

test('available difference filters hide non-applicable options', () => {
  expect(
    getAvailableComparisonProjectDifferenceFilters([
      {id: 'llm:model-1:prompt-1', kind: 'llm', promptId: 'prompt-1'},
      {id: 'human:prompt-1', kind: 'human', promptId: 'prompt-1'},
    ]),
  ).toEqual(['all', 'human-vs-llm', 'human-vs-llm-true-conflict'])

  expect(
    getAvailableComparisonProjectDifferenceFilters([
      {id: 'llm:model-1:prompt-1', kind: 'llm', promptId: 'prompt-1'},
      {id: 'llm:model-2:prompt-1', kind: 'llm', promptId: 'prompt-1'},
    ]),
  ).toEqual(['all', 'llm-vs-llm'])

  expect(
    getAvailableComparisonProjectDifferenceFilters([
      {id: 'llm:model-1:prompt-1', kind: 'llm', promptId: 'prompt-1'},
      {id: 'llm:model-2:prompt-1', kind: 'llm', promptId: 'prompt-1'},
      {id: 'human:prompt-1', kind: 'human', promptId: 'prompt-1'},
    ]),
  ).toEqual(['all', 'human-vs-llm', 'human-vs-llm-true-conflict', 'llm-vs-llm', 'any-disagreement'])
})

test('difference filter labels stay user-facing', () => {
  expect(getComparisonProjectDifferenceFilterLabel('all')).toBe('All rows')
  expect(getComparisonProjectDifferenceFilterLabel('human-vs-llm')).toBe('Human vs LLM conflict')
  expect(getComparisonProjectDifferenceFilterLabel('human-vs-llm-true-conflict')).toBe('Human vs LLM true conflict')
  expect(getComparisonProjectDifferenceFilterLabel('llm-vs-llm')).toBe('LLM vs LLM differences')
  expect(getComparisonProjectDifferenceFilterLabel('any-disagreement')).toBe('Any disagreement')
})

test('difference matching supports prompt and summary comparisons', () => {
  const promptColumns = [
    {id: 'llm:model-1:prompt-1', kind: 'llm', promptId: 'prompt-1'},
    {id: 'llm:model-2:prompt-1', kind: 'llm', promptId: 'prompt-1'},
    {id: 'human:prompt-1', kind: 'human', promptId: 'prompt-1'},
    {id: 'llm:model-1:prompt-2', kind: 'llm', promptId: 'prompt-2'},
    {id: 'llm:model-2:prompt-2', kind: 'llm', promptId: 'prompt-2'},
    {id: 'human:prompt-2', kind: 'human', promptId: 'prompt-2'},
  ] as const
  const promptCells = {
    'human:prompt-1': 'yes',
    'human:prompt-2': 'no',
    'llm:model-1:prompt-1': 'yes',
    'llm:model-1:prompt-2': 'yes',
    'llm:model-2:prompt-1': 'yes',
    'llm:model-2:prompt-2': 'no',
  }
  const summaryColumns = [
    {id: 'llm:model-1:summary', kind: 'llm', promptId: 'summary'},
    {id: 'llm:model-2:summary', kind: 'llm', promptId: 'summary'},
    {id: 'human:summary', kind: 'human', promptId: 'summary'},
  ] as const
  const summaryCells = {'human:summary': 'maybe', 'llm:model-1:summary': 'no', 'llm:model-2:summary': 'yes'}

  expect(getComparisonProjectHasDifferenceFilterMatch(promptCells, promptColumns, 'human-vs-llm')).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(promptCells, promptColumns, 'human-vs-llm-true-conflict')).toBe(
    true,
  )
  expect(getComparisonProjectHasDifferenceFilterMatch(promptCells, promptColumns, 'llm-vs-llm')).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(promptCells, promptColumns, 'any-disagreement')).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(summaryCells, summaryColumns, 'human-vs-llm')).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(summaryCells, summaryColumns, 'human-vs-llm-true-conflict')).toBe(
    true,
  )
  expect(getComparisonProjectHasDifferenceFilterMatch(summaryCells, summaryColumns, 'llm-vs-llm')).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(summaryCells, summaryColumns, 'any-disagreement')).toBe(true)
})

test('true conflict matching treats yes and maybe as include against no', () => {
  const columns = [
    {id: 'llm:model-1:summary', kind: 'llm', promptId: 'summary'},
    {id: 'human:summary', kind: 'human', promptId: 'summary'},
  ] as const

  expect(
    getComparisonProjectHasDifferenceFilterMatch(
      {'human:summary': 'maybe', 'llm:model-1:summary': 'yes'},
      columns,
      'human-vs-llm-true-conflict',
    ),
  ).toBe(false)
  expect(
    getComparisonProjectHasDifferenceFilterMatch(
      {'human:summary': 'maybe', 'llm:model-1:summary': 'no'},
      columns,
      'human-vs-llm-true-conflict',
    ),
  ).toBe(true)
})

test('non-applicable filters normalize back to all rows', () => {
  const columns = [
    {id: 'llm:model-1:summary', kind: 'llm', promptId: 'summary'},
    {id: 'human:summary', kind: 'human', promptId: 'summary'},
  ] as const

  expect(getNormalizedComparisonProjectDifferenceFilter('llm-vs-llm', columns)).toBe('all')
  expect(getComparisonProjectHasDifferenceFilterMatch({'human:summary': 'yes'}, columns, 'llm-vs-llm')).toBe(true)
})
