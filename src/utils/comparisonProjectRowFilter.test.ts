import {expect, test} from 'bun:test'

import {
  getComparisonProjectPassesRowFilter,
  getComparisonProjectRowFilterLabel,
  getNormalizedComparisonProjectRowFilter,
  getSelectableComparisonProjectRowFilters,
} from './comparisonProjectRowFilter.ts'

test('rowFilter normalization defaults missing and invalid values to all rows', () => {
  expect(getNormalizedComparisonProjectRowFilter(undefined)).toBe('all')
  expect(getNormalizedComparisonProjectRowFilter('not-a-filter')).toBe('all')
  expect(getNormalizedComparisonProjectRowFilter('llm-answered-yes')).toBe('llm-answered-yes')
  expect(getNormalizedComparisonProjectRowFilter('human-answered-maybe')).toBe('human-answered-maybe')
  expect(getNormalizedComparisonProjectRowFilter('fully-answered')).toBe('fully-answered')
  expect(getNormalizedComparisonProjectRowFilter('all')).toBe('all')
})

test('rowFilter labels cover prompt and summary mode language', () => {
  expect(getComparisonProjectRowFilterLabel('multiple-answers', false)).toBe('Rows with more than 1 answered prompt')
  expect(getComparisonProjectRowFilterLabel('multiple-answers', true)).toBe('Rows with more than 1 answer')
  expect(getComparisonProjectRowFilterLabel('fully-answered', false)).toBe('Rows where all shown columns are answered')
  expect(getComparisonProjectRowFilterLabel('llm-answered-yes', false)).toBe('LLM has answered yes')
  expect(getComparisonProjectRowFilterLabel('llm-answered-no', false)).toBe('LLM has answered no')
  expect(getComparisonProjectRowFilterLabel('llm-answered-maybe', false)).toBe('LLM has answered maybe')
  expect(getComparisonProjectRowFilterLabel('human-answered-yes', false)).toBe('Human has answered yes')
  expect(getComparisonProjectRowFilterLabel('human-answered-no', false)).toBe('Human has answered no')
  expect(getComparisonProjectRowFilterLabel('human-answered-maybe', false)).toBe('Human has answered maybe')
  expect(getComparisonProjectRowFilterLabel('all', false)).toBe('All rows')
})

test('rowFilter labels use model name for one unambiguous LLM source', () => {
  const columns = [
    {kind: 'llm', modelLabel: 'GPT-5.5 (thinking: xhigh)', sourceProjectId: 'source-project-1'},
    {kind: 'human'},
  ] as const

  expect(getComparisonProjectRowFilterLabel('llm-answered-yes', true, {columns})).toBe(
    'GPT-5.5 (thinking: xhigh) has answered yes',
  )
  expect(getComparisonProjectRowFilterLabel('human-answered-no', true, {columns})).toBe('Human has answered no')
})

test('selectable rowFilters hide unavailable answer sources', () => {
  const llmOnlyColumns = [{kind: 'llm', modelLabel: 'Model 1'}] as const

  expect(getSelectableComparisonProjectRowFilters(llmOnlyColumns, 'all')).not.toContain('human-answered-yes')
  expect(getSelectableComparisonProjectRowFilters(llmOnlyColumns, 'human-answered-yes')).toContain('human-answered-yes')
})

test('rowFilter evaluation keeps prompt and summary sparse row semantics separate', () => {
  const baseEvaluation = {
    answeredColumnCount: 1,
    answeredPromptCount: 1,
    cells: {},
    columns: [],
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

test('rowFilter evaluation matches selected answer values by source kind', () => {
  const answerEvaluation = {
    answeredColumnCount: 3,
    answeredPromptCount: 2,
    cells: {
      'human:prompt-1': 'maybe',
      'human:prompt-2': 'No',
      'llm:model-1:prompt-1': 'yes\nmaybe',
      'llm:model-1:prompt-2': 'no',
    },
    columns: [
      {id: 'llm:model-1:prompt-1', kind: 'llm'},
      {id: 'llm:model-1:prompt-2', kind: 'llm'},
      {id: 'human:prompt-1', kind: 'human'},
      {id: 'human:prompt-2', kind: 'human'},
    ] as const,
    hasAllHumanColumns: true,
    hasAllLlmColumns: true,
    isSummaryMode: false,
  }

  expect(getComparisonProjectPassesRowFilter({...answerEvaluation, rowFilter: 'llm-answered-yes'})).toBe(true)
  expect(getComparisonProjectPassesRowFilter({...answerEvaluation, rowFilter: 'llm-answered-no'})).toBe(true)
  expect(getComparisonProjectPassesRowFilter({...answerEvaluation, rowFilter: 'llm-answered-maybe'})).toBe(true)
  expect(getComparisonProjectPassesRowFilter({...answerEvaluation, rowFilter: 'human-answered-yes'})).toBe(false)
  expect(getComparisonProjectPassesRowFilter({...answerEvaluation, rowFilter: 'human-answered-no'})).toBe(true)
  expect(getComparisonProjectPassesRowFilter({...answerEvaluation, rowFilter: 'human-answered-maybe'})).toBe(true)
})
