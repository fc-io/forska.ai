import {expect, test} from 'bun:test'

import {
  getAvailableComparisonProjectDifferenceFilters,
  getComparisonProjectDifferenceFilterLabel,
  getComparisonProjectHasDifferenceFilterMatch,
  getNormalizedComparisonProjectDifferenceFilter,
  getSelectableComparisonProjectDifferenceFilters,
} from './comparisonProjectDifferenceFilter.ts'

test('available difference filters hide non-applicable options', () => {
  expect(
    getAvailableComparisonProjectDifferenceFilters([
      {id: 'llm:model-1:prompt-1', kind: 'llm', promptId: 'prompt-1'},
      {id: 'human:prompt-1', kind: 'human', promptId: 'prompt-1'},
    ]),
  ).toEqual(['all', 'human-vs-llm-overlap', 'human-vs-llm', 'human-vs-llm-true-conflict'])

  expect(
    getAvailableComparisonProjectDifferenceFilters([
      {id: 'llm:model-1:prompt-1', kind: 'llm', promptId: 'prompt-1'},
      {id: 'llm:model-2:prompt-1', kind: 'llm', promptId: 'prompt-1'},
    ]),
  ).toEqual(['all', 'llm-vs-llm', 'llm-vs-llm-true-difference'])

  expect(
    getAvailableComparisonProjectDifferenceFilters([
      {id: 'llm:model-1:prompt-1', kind: 'llm', promptId: 'prompt-1'},
      {id: 'llm:model-2:prompt-1', kind: 'llm', promptId: 'prompt-1'},
      {id: 'human:prompt-1', kind: 'human', promptId: 'prompt-1'},
    ]),
  ).toEqual([
    'all',
    'human-vs-llm-overlap',
    'human-vs-llm',
    'human-vs-llm-true-conflict',
    'llm-vs-llm',
    'llm-vs-llm-true-difference',
    'any-disagreement',
  ])
})

test('conflict-resolution difference filters require resolution support', () => {
  const columns = [
    {id: 'llm:model-1:summary', kind: 'llm', promptId: 'summary'},
    {id: 'human:summary', kind: 'human', promptId: 'summary'},
  ] as const

  expect(getAvailableComparisonProjectDifferenceFilters(columns, {hasConflictResolution: false})).toEqual([
    'all',
    'human-vs-llm-overlap',
    'human-vs-llm',
    'human-vs-llm-true-conflict',
  ])
  expect(getAvailableComparisonProjectDifferenceFilters(columns, {hasConflictResolution: true})).toEqual([
    'all',
    'human-vs-llm-overlap',
    'human-vs-llm',
    'human-vs-llm-true-conflict',
    'resolution-vs-llm',
    'resolution-vs-llm-true-conflict',
    'resolution-vs-human',
    'resolution-vs-human-true-conflict',
  ])
  expect(
    getAvailableComparisonProjectDifferenceFilters([{id: 'llm:model-1:summary', kind: 'llm', promptId: 'summary'}], {
      hasConflictResolution: true,
    }),
  ).toEqual(['all', 'resolution-vs-llm', 'resolution-vs-llm-true-conflict'])
  expect(getNormalizedComparisonProjectDifferenceFilter('resolution-vs-llm', columns)).toBe('all')
  expect(
    getNormalizedComparisonProjectDifferenceFilter('resolution-vs-llm', columns, {hasConflictResolution: true}),
  ).toBe('resolution-vs-llm')
})

test('difference filter labels stay user-facing', () => {
  expect(getComparisonProjectDifferenceFilterLabel('all')).toBe('All rows')
  expect(getComparisonProjectDifferenceFilterLabel('human-vs-llm-overlap')).toBe('Human and LLM judged')
  expect(getComparisonProjectDifferenceFilterLabel('human-vs-llm')).toBe('Human vs LLM conflict')
  expect(getComparisonProjectDifferenceFilterLabel('human-vs-llm-true-conflict')).toBe('Human vs LLM true conflict')
  expect(getComparisonProjectDifferenceFilterLabel('llm-vs-llm')).toBe('LLM vs LLM differences')
  expect(getComparisonProjectDifferenceFilterLabel('llm-vs-llm-true-difference')).toBe('LLM vs LLM true differences')
  expect(getComparisonProjectDifferenceFilterLabel('any-disagreement')).toBe('Any disagreement')
  expect(getComparisonProjectDifferenceFilterLabel('resolution-vs-llm')).toBe('Conflict resolution vs LLM conflict')
  expect(getComparisonProjectDifferenceFilterLabel('resolution-vs-llm-true-conflict')).toBe(
    'Conflict resolution vs LLM true conflict',
  )
  expect(getComparisonProjectDifferenceFilterLabel('resolution-vs-human')).toBe('Conflict resolution vs human conflict')
  expect(getComparisonProjectDifferenceFilterLabel('resolution-vs-human-true-conflict')).toBe(
    'Conflict resolution vs human true conflict',
  )
})

test('conflict-resolution difference matching compares the resolution against each side', () => {
  const columns = [
    {id: 'llm:model-1:summary', kind: 'llm', promptId: 'summary'},
    {id: 'llm:model-2:summary', kind: 'llm', promptId: 'summary'},
    {id: 'human:summary', kind: 'human', promptId: 'summary'},
  ] as const
  const cells = {'human:summary': 'no', 'llm:model-1:summary': 'yes', 'llm:model-2:summary': 'maybe'}

  expect(getComparisonProjectHasDifferenceFilterMatch(cells, columns, 'resolution-vs-llm', 'Yes')).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(cells, columns, 'resolution-vs-llm-true-conflict', 'Yes')).toBe(
    false,
  )
  expect(getComparisonProjectHasDifferenceFilterMatch(cells, columns, 'resolution-vs-llm-true-conflict', 'No')).toBe(
    true,
  )
  expect(getComparisonProjectHasDifferenceFilterMatch(cells, columns, 'resolution-vs-human', 'No')).toBe(false)
  expect(getComparisonProjectHasDifferenceFilterMatch(cells, columns, 'resolution-vs-human', 'Maybe')).toBe(true)
  expect(
    getComparisonProjectHasDifferenceFilterMatch(cells, columns, 'resolution-vs-human-true-conflict', 'Maybe'),
  ).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(cells, columns, 'resolution-vs-llm', null)).toBe(false)
  expect(getComparisonProjectHasDifferenceFilterMatch(cells, columns, 'resolution-vs-llm', '  ')).toBe(false)
  expect(getComparisonProjectHasDifferenceFilterMatch(cells, columns, 'resolution-vs-llm')).toBe(true)
})

test('conflict-resolution difference matching ignores rows without a conflict', () => {
  const columns = [
    {id: 'llm:model-1:summary', kind: 'llm', promptId: 'summary'},
    {id: 'human:summary', kind: 'human', promptId: 'summary'},
  ] as const
  const cells = {'human:summary': 'yes', 'llm:model-1:summary': 'yes'}

  expect(getComparisonProjectHasDifferenceFilterMatch(cells, columns, 'resolution-vs-llm', 'no')).toBe(false)
  expect(getComparisonProjectHasDifferenceFilterMatch(cells, columns, 'resolution-vs-human-true-conflict', 'no')).toBe(
    false,
  )
})

test('selectable difference filters keep the current selection renderable', () => {
  expect(getSelectableComparisonProjectDifferenceFilters(['all'] as const, 'human-vs-llm-overlap')).toEqual([
    'all',
    'human-vs-llm-overlap',
  ])
  expect(
    getSelectableComparisonProjectDifferenceFilters(
      ['all', 'llm-vs-llm', 'llm-vs-llm-true-difference'] as const,
      'llm-vs-llm',
    ),
  ).toEqual(['all', 'llm-vs-llm', 'llm-vs-llm-true-difference'])
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
  expect(getComparisonProjectHasDifferenceFilterMatch(promptCells, promptColumns, 'human-vs-llm-overlap')).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(promptCells, promptColumns, 'human-vs-llm-true-conflict')).toBe(
    true,
  )
  expect(getComparisonProjectHasDifferenceFilterMatch(promptCells, promptColumns, 'llm-vs-llm')).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(promptCells, promptColumns, 'llm-vs-llm-true-difference')).toBe(
    true,
  )
  expect(getComparisonProjectHasDifferenceFilterMatch(promptCells, promptColumns, 'any-disagreement')).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(summaryCells, summaryColumns, 'human-vs-llm')).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(summaryCells, summaryColumns, 'human-vs-llm-overlap')).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(summaryCells, summaryColumns, 'human-vs-llm-true-conflict')).toBe(
    true,
  )
  expect(getComparisonProjectHasDifferenceFilterMatch(summaryCells, summaryColumns, 'llm-vs-llm')).toBe(true)
  expect(getComparisonProjectHasDifferenceFilterMatch(summaryCells, summaryColumns, 'llm-vs-llm-true-difference')).toBe(
    true,
  )
  expect(getComparisonProjectHasDifferenceFilterMatch(summaryCells, summaryColumns, 'any-disagreement')).toBe(true)
})

test('human vs llm overlap matching does not require disagreement', () => {
  const columns = [
    {id: 'llm:model-1:summary', kind: 'llm', promptId: 'summary'},
    {id: 'human:summary', kind: 'human', promptId: 'summary'},
  ] as const

  expect(
    getComparisonProjectHasDifferenceFilterMatch(
      {'human:summary': 'yes', 'llm:model-1:summary': 'yes'},
      columns,
      'human-vs-llm-overlap',
    ),
  ).toBe(true)
  expect(
    getComparisonProjectHasDifferenceFilterMatch(
      {'human:summary': 'yes', 'llm:model-1:summary': 'yes'},
      columns,
      'human-vs-llm',
    ),
  ).toBe(false)
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

test('llm vs llm true difference treats yes and maybe as include against no', () => {
  const columns = [
    {id: 'llm:model-1:summary', kind: 'llm', promptId: 'summary'},
    {id: 'llm:model-2:summary', kind: 'llm', promptId: 'summary'},
  ] as const

  expect(
    getComparisonProjectHasDifferenceFilterMatch(
      {'llm:model-1:summary': 'maybe', 'llm:model-2:summary': 'yes'},
      columns,
      'llm-vs-llm-true-difference',
    ),
  ).toBe(false)
  expect(
    getComparisonProjectHasDifferenceFilterMatch(
      {'llm:model-1:summary': 'maybe', 'llm:model-2:summary': 'no'},
      columns,
      'llm-vs-llm-true-difference',
    ),
  ).toBe(true)
})

test('non-applicable filters normalize back to all rows', () => {
  const columns = [
    {id: 'llm:model-1:summary', kind: 'llm', promptId: 'summary'},
    {id: 'human:summary', kind: 'human', promptId: 'summary'},
  ] as const

  expect(getNormalizedComparisonProjectDifferenceFilter('llm-vs-llm', columns)).toBe('all')
  expect(getNormalizedComparisonProjectDifferenceFilter('llm-vs-llm-true-difference', columns)).toBe('all')
  expect(getComparisonProjectHasDifferenceFilterMatch({'human:summary': 'yes'}, columns, 'llm-vs-llm')).toBe(true)
  expect(
    getComparisonProjectHasDifferenceFilterMatch({'human:summary': 'yes'}, columns, 'llm-vs-llm-true-difference'),
  ).toBe(true)
})
