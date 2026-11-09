import {expect, test} from 'bun:test'

import {
  getCompareProjectCovidenceExportButtonLabel,
  getCompareProjectCovidenceExportHint,
} from './compareProjectCovidenceExportLabels.ts'
import {
  getCompareProjectCovidenceExportRequestBody,
  getCompareProjectCovidenceExportSearchParams,
  getCompareProjectCovidenceExportSelectionWithColumnValues,
  getCompareProjectCovidenceExportSelectionWithConflictResolutionValues,
  getCompareProjectCovidenceExportSelectionWithInvert,
  getEmptyCompareProjectCovidenceExportSelection,
  getInitialCompareProjectCovidenceExportSelection,
} from './compareProjectCovidenceExportUrlState.ts'

const llmColumnId = 'llm:source-a:model-gpt:1100:summary'
const humanColumnId = 'human:summary'

test('Covidence export selection round-trips through the export page search params', () => {
  const selection = {
    columnValues: {[humanColumnId]: ['maybe'], [llmColumnId]: ['yes', 'maybe']},
    conflictResolutionValues: ['yes'],
    invert: false,
  }
  const searchParams = getCompareProjectCovidenceExportSearchParams(selection)

  expect(searchParams).toEqual({
    covidenceExport: {
      columns: {[humanColumnId]: ['maybe'], [llmColumnId]: ['yes', 'maybe']},
      conflictResolution: ['yes'],
    },
  })
  expect(getInitialCompareProjectCovidenceExportSelection(searchParams)).toEqual(selection)
})

test('the invert flag round-trips through the search params and is left out when off', () => {
  const selection = {columnValues: {[humanColumnId]: ['yes', 'maybe']}, conflictResolutionValues: [], invert: true}
  const searchParams = getCompareProjectCovidenceExportSearchParams(selection)

  expect(searchParams).toEqual({covidenceExport: {columns: {[humanColumnId]: ['yes', 'maybe']}, invert: true}})
  expect(getInitialCompareProjectCovidenceExportSelection(searchParams)).toEqual(selection)
  expect(getCompareProjectCovidenceExportSearchParams({...selection, invert: false})).toEqual({
    covidenceExport: {columns: {[humanColumnId]: ['yes', 'maybe']}},
  })
  expect(
    getInitialCompareProjectCovidenceExportSelection(
      getCompareProjectCovidenceExportSearchParams({...getEmptyCompareProjectCovidenceExportSelection(), invert: true}),
    ),
  ).toEqual({...getEmptyCompareProjectCovidenceExportSelection(), invert: true})
})

test('only a boolean true in the search params turns invert on', () => {
  expect(
    ['true', 1, null, false, {}].map((invert) => {
      return getInitialCompareProjectCovidenceExportSelection({covidenceExport: {invert}}).invert
    }),
  ).toEqual([false, false, false, false, false])
  expect(getInitialCompareProjectCovidenceExportSelection({covidenceExport: {invert: true}}).invert).toBe(true)
})

test('an empty Covidence export selection adds no search param', () => {
  expect(getCompareProjectCovidenceExportSearchParams(getEmptyCompareProjectCovidenceExportSelection())).toEqual({})
  expect(
    getCompareProjectCovidenceExportSearchParams({
      columnValues: {[humanColumnId]: []},
      conflictResolutionValues: [],
      invert: false,
    }),
  ).toEqual({})
})

test('Covidence export search params are normalised and malformed values are dropped', () => {
  expect(
    getInitialCompareProjectCovidenceExportSelection({
      covidenceExport: {
        columns: {[humanColumnId]: [' Maybe ', 'maybe', 3, ''], [llmColumnId]: 'yes', 'llm:empty': []},
        conflictResolution: [' Yes ', null],
      },
    }),
  ).toEqual({columnValues: {[humanColumnId]: ['maybe']}, conflictResolutionValues: ['Yes'], invert: false})
  expect(getInitialCompareProjectCovidenceExportSelection({covidenceExport: 'yes'})).toEqual(
    getEmptyCompareProjectCovidenceExportSelection(),
  )
  expect(getInitialCompareProjectCovidenceExportSelection({})).toEqual(getEmptyCompareProjectCovidenceExportSelection())
})

test('the request body follows column order, skips unknown and empty columns and gates conflict resolution', () => {
  const selection = {
    columnValues: {[humanColumnId]: ['maybe'], 'llm:retired:1100:summary': ['no'], [llmColumnId]: ['yes']},
    conflictResolutionValues: ['yes'],
    invert: false,
  }
  const columns = [{id: llmColumnId}, {id: 'llm:unselected:1100:summary'}, {id: humanColumnId}]

  expect(getCompareProjectCovidenceExportRequestBody(selection, columns, true)).toEqual({
    columnSelections: [
      {columnId: llmColumnId, values: ['yes']},
      {columnId: humanColumnId, values: ['maybe']},
    ],
    conflictResolutionValues: ['yes'],
    invertSelection: false,
  })
  expect(getCompareProjectCovidenceExportRequestBody(selection, columns, false).conflictResolutionValues).toEqual([])
})

test('the request body carries the invert flag as invertSelection', () => {
  const selection = {columnValues: {[humanColumnId]: ['yes', 'maybe']}, conflictResolutionValues: [], invert: true}

  expect(getCompareProjectCovidenceExportRequestBody(selection, [{id: humanColumnId}], true)).toEqual({
    columnSelections: [{columnId: humanColumnId, values: ['yes', 'maybe']}],
    conflictResolutionValues: [],
    invertSelection: true,
  })
  expect(
    getCompareProjectCovidenceExportRequestBody({...selection, columnValues: {}}, [{id: humanColumnId}], true),
  ).toEqual({columnSelections: [], conflictResolutionValues: [], invertSelection: true})
})

test('selection updates keep the previous object when nothing changed', () => {
  const selection = {columnValues: {[humanColumnId]: ['maybe']}, conflictResolutionValues: ['yes'], invert: false}

  expect(getCompareProjectCovidenceExportSelectionWithColumnValues(selection, humanColumnId, ['maybe'])).toBe(selection)
  expect(getCompareProjectCovidenceExportSelectionWithConflictResolutionValues(selection, ['yes'])).toBe(selection)
  expect(getCompareProjectCovidenceExportSelectionWithInvert(selection, false)).toBe(selection)
  expect(getCompareProjectCovidenceExportSelectionWithColumnValues(selection, humanColumnId, [])).toEqual({
    columnValues: {},
    conflictResolutionValues: ['yes'],
    invert: false,
  })
  expect(getCompareProjectCovidenceExportSelectionWithColumnValues(selection, llmColumnId, ['no'])).toEqual({
    columnValues: {[humanColumnId]: ['maybe'], [llmColumnId]: ['no']},
    conflictResolutionValues: ['yes'],
    invert: false,
  })
  expect(getCompareProjectCovidenceExportSelectionWithConflictResolutionValues(selection, [])).toEqual({
    columnValues: {[humanColumnId]: ['maybe']},
    conflictResolutionValues: [],
    invert: false,
  })
  expect(getCompareProjectCovidenceExportSelectionWithInvert(selection, true)).toEqual({...selection, invert: true})
  expect(
    getCompareProjectCovidenceExportSelectionWithColumnValues({...selection, invert: true}, llmColumnId, ['no']).invert,
  ).toBe(true)
})

test('the Covidence export button label shows the live article count', () => {
  expect(getCompareProjectCovidenceExportButtonLabel(null, false)).toBe('Export to Covidence')
  expect(getCompareProjectCovidenceExportButtonLabel(0, false)).toBe('Export 0 articles to Covidence')
  expect(getCompareProjectCovidenceExportButtonLabel(1, false)).toBe('Export 1 article to Covidence')
  expect(getCompareProjectCovidenceExportButtonLabel(1234, false)).toBe(
    `Export ${(1234).toLocaleString()} articles to Covidence`,
  )
  expect(getCompareProjectCovidenceExportButtonLabel(12, true)).toBe('Exporting to Covidence...')
})

test('the Covidence export hint explains an empty selection or an empty result', () => {
  expect(getCompareProjectCovidenceExportHint(false, 0)).toBe('Nothing is selected, so there is nothing to export.')
  expect(getCompareProjectCovidenceExportHint(true, 0)).toBe('No articles match this selection.')
  expect(getCompareProjectCovidenceExportHint(true, null)).toBeNull()
  expect(getCompareProjectCovidenceExportHint(true, 3)).toBeNull()
})
