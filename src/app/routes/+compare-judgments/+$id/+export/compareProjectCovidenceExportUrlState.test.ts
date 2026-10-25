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
  getEmptyCompareProjectCovidenceExportSelection,
  getInitialCompareProjectCovidenceExportSelection,
} from './compareProjectCovidenceExportUrlState.ts'

const llmColumnId = 'llm:source-a:model-gpt:1100:summary'
const humanColumnId = 'human:summary'

test('Covidence export selection round-trips through the export page search params', () => {
  const selection = {
    columnValues: {[humanColumnId]: ['maybe'], [llmColumnId]: ['yes', 'maybe']},
    conflictResolutionValues: ['yes'],
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

test('an empty Covidence export selection adds no search param', () => {
  expect(getCompareProjectCovidenceExportSearchParams(getEmptyCompareProjectCovidenceExportSelection())).toEqual({})
  expect(
    getCompareProjectCovidenceExportSearchParams({columnValues: {[humanColumnId]: []}, conflictResolutionValues: []}),
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
  ).toEqual({columnValues: {[humanColumnId]: ['maybe']}, conflictResolutionValues: ['Yes']})
  expect(getInitialCompareProjectCovidenceExportSelection({covidenceExport: 'yes'})).toEqual(
    getEmptyCompareProjectCovidenceExportSelection(),
  )
  expect(getInitialCompareProjectCovidenceExportSelection({})).toEqual(getEmptyCompareProjectCovidenceExportSelection())
})

test('the request body follows column order, skips unknown and empty columns and gates conflict resolution', () => {
  const selection = {
    columnValues: {[humanColumnId]: ['maybe'], 'llm:retired:1100:summary': ['no'], [llmColumnId]: ['yes']},
    conflictResolutionValues: ['yes'],
  }
  const columns = [{id: llmColumnId}, {id: 'llm:unselected:1100:summary'}, {id: humanColumnId}]

  expect(getCompareProjectCovidenceExportRequestBody(selection, columns, true)).toEqual({
    columnSelections: [
      {columnId: llmColumnId, values: ['yes']},
      {columnId: humanColumnId, values: ['maybe']},
    ],
    conflictResolutionValues: ['yes'],
  })
  expect(getCompareProjectCovidenceExportRequestBody(selection, columns, false).conflictResolutionValues).toEqual([])
})

test('selection updates keep the previous object when nothing changed', () => {
  const selection = {columnValues: {[humanColumnId]: ['maybe']}, conflictResolutionValues: ['yes']}

  expect(getCompareProjectCovidenceExportSelectionWithColumnValues(selection, humanColumnId, ['maybe'])).toBe(selection)
  expect(getCompareProjectCovidenceExportSelectionWithConflictResolutionValues(selection, ['yes'])).toBe(selection)
  expect(getCompareProjectCovidenceExportSelectionWithColumnValues(selection, humanColumnId, [])).toEqual({
    columnValues: {},
    conflictResolutionValues: ['yes'],
  })
  expect(getCompareProjectCovidenceExportSelectionWithColumnValues(selection, llmColumnId, ['no'])).toEqual({
    columnValues: {[humanColumnId]: ['maybe'], [llmColumnId]: ['no']},
    conflictResolutionValues: ['yes'],
  })
  expect(getCompareProjectCovidenceExportSelectionWithConflictResolutionValues(selection, [])).toEqual({
    columnValues: {[humanColumnId]: ['maybe']},
    conflictResolutionValues: [],
  })
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
