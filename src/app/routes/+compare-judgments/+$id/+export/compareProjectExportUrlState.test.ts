import {expect, test} from 'bun:test'

import {
  getCompareProjectExportRequestBody,
  getCompareProjectExportSearchParams,
  getInitialCompareProjectExportUrlState,
} from './compareProjectExportUrlState.ts'

test('compare export URL state starts from active compare page search params', () => {
  const state = getInitialCompareProjectExportUrlState({
    differenceFilter: 'human-vs-llm',
    limit: '100',
    page: '4',
    rowFilter: 'fully-answered',
  })

  expect(state).toEqual({currentPage: 4, differenceFilter: 'human-vs-llm', pageLimit: 100, rowFilter: 'fully-answered'})
  expect(getCompareProjectExportSearchParams(state)).toEqual({
    differenceFilter: 'human-vs-llm',
    limit: '100',
    page: '4',
    rowFilter: 'fully-answered',
  })
})

test('compare export request body sends only export filters', () => {
  const state = getInitialCompareProjectExportUrlState({
    differenceFilter: 'llm-vs-llm',
    limit: '25',
    page: '2',
    rowFilter: 'all',
  })

  expect(getCompareProjectExportRequestBody(state)).toEqual({differenceFilter: 'llm-vs-llm', rowFilter: 'all'})
})
