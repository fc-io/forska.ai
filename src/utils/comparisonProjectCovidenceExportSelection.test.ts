import {expect, test} from 'bun:test'

import {
  type ComparisonProjectCovidenceExportCandidateRow,
  type ComparisonProjectCovidenceExportRequest,
  getComparisonProjectCovidenceExportSelectedRows,
  getHasComparisonProjectCovidenceExportSelection,
  getIsComparisonProjectCovidenceExportRowSelected,
  getNormalizedComparisonProjectCovidenceExportSelection,
} from './comparisonProjectCovidenceExportSelection.ts'

const humanColumnId = 'human:summary'
const gptColumnId = 'llm:source-a:model-gpt:1100:summary'
const opusColumnId = 'llm:source-a:model-opus:1100:summary'
const columnIds = [gptColumnId, opusColumnId, humanColumnId]

const getRow = (
  canonicalArticleId: string,
  cells: Record<string, string | null>,
  conflictResolutionLabel: string | null = null,
): ComparisonProjectCovidenceExportCandidateRow => {
  return {
    canonicalArticleId,
    cells,
    conflictResolution: conflictResolutionLabel === null ? null : {label: conflictResolutionLabel},
  }
}

const getSelection = (request: ComparisonProjectCovidenceExportRequest, allowConflictResolution = true) => {
  return getNormalizedComparisonProjectCovidenceExportSelection(request, {allowConflictResolution, columnIds})
}

const getSelectedArticleIds = (
  rows: readonly ComparisonProjectCovidenceExportCandidateRow[],
  request: ComparisonProjectCovidenceExportRequest,
  exportedArticleIds?: ReadonlySet<string>,
) => {
  return getComparisonProjectCovidenceExportSelectedRows(rows, getSelection(request), exportedArticleIds).map((row) => {
    return row.canonicalArticleId
  })
}

const rows = [
  getRow('article-yes-llm-no-human', {[gptColumnId]: 'yes', [opusColumnId]: 'no', [humanColumnId]: 'no'}),
  getRow('article-maybe-human', {[gptColumnId]: 'no', [opusColumnId]: 'no', [humanColumnId]: 'maybe'}),
  getRow('article-all-no', {[gptColumnId]: 'no', [opusColumnId]: 'no', [humanColumnId]: 'no'}),
  getRow('article-resolved-yes', {[gptColumnId]: 'no', [opusColumnId]: 'no', [humanColumnId]: 'no'}, 'yes'),
  getRow('article-unanswered', {}),
]

test('an article is exported when any one column has one of its selected answers', () => {
  const allColumnsYesMaybe = {
    columnSelections: columnIds.map((columnId) => {
      return {columnId, values: ['yes', 'maybe']}
    }),
    conflictResolutionValues: ['yes', 'maybe'],
  }

  expect(getSelectedArticleIds(rows, allColumnsYesMaybe)).toEqual([
    'article-yes-llm-no-human',
    'article-maybe-human',
    'article-resolved-yes',
  ])
})

test('each column only matches its own selected answers', () => {
  expect(
    getSelectedArticleIds(rows, {
      columnSelections: [
        {columnId: gptColumnId, values: ['maybe']},
        {columnId: humanColumnId, values: ['maybe']},
      ],
    }),
  ).toEqual(['article-maybe-human'])
  expect(getSelectedArticleIds(rows, {columnSelections: [{columnId: opusColumnId, values: ['yes', 'maybe']}]})).toEqual(
    [],
  )
  expect(getSelectedArticleIds(rows, {columnSelections: [{columnId: opusColumnId, values: ['no']}]})).toEqual([
    'article-yes-llm-no-human',
    'article-maybe-human',
    'article-all-no',
    'article-resolved-yes',
  ])
})

test('the conflict resolution select matches the resolution label, alone or with columns', () => {
  expect(getSelectedArticleIds(rows, {columnSelections: [], conflictResolutionValues: ['yes']})).toEqual([
    'article-resolved-yes',
  ])
  expect(
    getSelectedArticleIds(rows, {
      columnSelections: [{columnId: humanColumnId, values: ['maybe']}],
      conflictResolutionValues: ['yes'],
    }),
  ).toEqual(['article-maybe-human', 'article-resolved-yes'])
  expect(getSelectedArticleIds(rows, {columnSelections: [], conflictResolutionValues: ['no']})).toEqual([])
})

test('conflict resolution values are dropped when the project does not allow conflict resolution', () => {
  const selection = getSelection({columnSelections: [], conflictResolutionValues: ['yes']}, false)

  expect(selection).toEqual({columnSelections: [], conflictResolutionValues: []})
  expect(getComparisonProjectCovidenceExportSelectedRows(rows, selection)).toEqual([])
})

test('answers and selected values are compared trimmed and lowercased', () => {
  const casedRows = [
    getRow('article-cased-yes', {[gptColumnId]: ' Yes '}),
    getRow('article-cased-resolution', {}, ' MAYBE '),
  ]

  expect(
    getSelectedArticleIds(casedRows, {
      columnSelections: [{columnId: gptColumnId, values: ['YES ']}],
      conflictResolutionValues: [' Maybe'],
    }),
  ).toEqual(['article-cased-yes', 'article-cased-resolution'])
  expect(getSelection({columnSelections: [{columnId: gptColumnId, values: [' Yes', 'yes', '', '  ']}]})).toEqual({
    columnSelections: [{columnId: gptColumnId, values: ['yes']}],
    conflictResolutionValues: [],
  })
})

test('unanswered cells never match, whatever is selected', () => {
  const unansweredRows = [
    getRow('article-null', {[gptColumnId]: null}),
    getRow('article-empty', {[gptColumnId]: ''}),
    getRow('article-blank', {[gptColumnId]: '  \n '}),
    getRow('article-missing', {}),
  ]

  expect(
    getSelectedArticleIds(unansweredRows, {
      columnSelections: [{columnId: gptColumnId, values: ['yes', 'no', 'maybe', '', ' ']}],
    }),
  ).toEqual([])
})

test('unknown column ids are ignored and a duplicated column id merges its values', () => {
  const selection = getSelection({
    columnSelections: [
      {columnId: 'llm:retired-model:1100:summary', values: ['no']},
      {columnId: humanColumnId, values: ['maybe']},
      {columnId: humanColumnId, values: ['yes', 'maybe']},
    ],
  })

  expect(selection).toEqual({
    columnSelections: [{columnId: humanColumnId, values: ['maybe', 'yes']}],
    conflictResolutionValues: [],
  })
  expect(
    getSelectedArticleIds(rows, {columnSelections: [{columnId: 'llm:retired-model:1100:summary', values: ['no']}]}),
  ).toEqual([])
})

test('a column with nothing selected matches nothing and an empty selection exports nothing', () => {
  const emptySelection = getSelection({
    columnSelections: [
      {columnId: gptColumnId, values: []},
      {columnId: humanColumnId, values: ['']},
    ],
    conflictResolutionValues: [],
  })

  expect(emptySelection).toEqual({columnSelections: [], conflictResolutionValues: []})
  expect(getHasComparisonProjectCovidenceExportSelection(emptySelection)).toBe(false)
  expect(getComparisonProjectCovidenceExportSelectedRows(rows, emptySelection)).toEqual([])
  expect(getSelectedArticleIds(rows, {columnSelections: []})).toEqual([])
  expect(
    getHasComparisonProjectCovidenceExportSelection(
      getSelection({columnSelections: [], conflictResolutionValues: ['yes']}),
    ),
  ).toBe(true)
})

test('an article matching several columns, repeated rows or earlier batches is exported once', () => {
  const request = {
    columnSelections: columnIds.map((columnId) => {
      return {columnId, values: ['yes']}
    }),
    conflictResolutionValues: ['yes'],
  }
  const repeatedRows = [
    getRow('article-1', {[gptColumnId]: 'yes', [opusColumnId]: 'yes', [humanColumnId]: 'yes'}, 'yes'),
    getRow('article-1', {[gptColumnId]: 'yes'}),
    getRow('article-2', {[humanColumnId]: 'yes'}),
    getRow('article-3', {[opusColumnId]: 'yes'}),
  ]

  expect(getSelectedArticleIds(repeatedRows, request)).toEqual(['article-1', 'article-2', 'article-3'])
  expect(getSelectedArticleIds(repeatedRows, request, new Set(['article-2']))).toEqual(['article-1', 'article-3'])
})

test('multi-line cells match on any of their answers', () => {
  expect(
    getIsComparisonProjectCovidenceExportRowSelected(
      getRow('article-multi', {[gptColumnId]: 'no\nMaybe'}),
      getSelection({columnSelections: [{columnId: gptColumnId, values: ['maybe']}]}),
    ),
  ).toBe(true)
})
