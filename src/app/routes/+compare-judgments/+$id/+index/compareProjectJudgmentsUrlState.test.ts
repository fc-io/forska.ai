import {expect, test} from 'bun:test'

import {
  getCanFetchCompareProjectJudgmentsPage,
  getCompareProjectJudgmentsConfirmedDifferenceFilter,
  getCompareProjectJudgmentsSearchParams,
  getInitialCompareProjectJudgmentsUrlState,
} from './compareProjectJudgmentsUrlState.ts'

test('compare judgments URL state preserves canonical filter params', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({
    differenceFilter: 'human-vs-llm-true-conflict',
    limit: '100',
    page: '3',
    rowFilter: 'fully-answered',
  })

  expect(state).toEqual({differenceFilter: 'human-vs-llm-true-conflict', pageLimit: 100, rowFilter: 'fully-answered'})
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({
    differenceFilter: 'human-vs-llm-true-conflict',
    limit: '100',
    rowFilter: 'fully-answered',
  })
})

test('compare judgments URL state normalizes legacy fully answered row filter', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({showOnlyFullyAnsweredPrompts: '1'})

  expect(state.rowFilter).toBe('fully-answered')
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({rowFilter: 'fully-answered'})
})

test('compare judgments URL state normalizes legacy all rows filter when fully answered is inactive', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({showAllRows: '1'})

  expect(state.rowFilter).toBe('all')
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({rowFilter: 'all'})
})

test('compare judgments URL state prefers fully answered when both legacy row filters are active', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({showAllRows: true, showOnlyFullyAnsweredPrompts: '1'})

  expect(state.rowFilter).toBe('fully-answered')
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({rowFilter: 'fully-answered'})
})

test('compare judgments URL state replaces legacy row and difference filters with canonical params', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({
    showOnlyFullyAnsweredPrompts: '1',
    showOnlyModelDifferences: '1',
  })

  expect(state.rowFilter).toBe('fully-answered')
  expect(state.differenceFilter).toBe('llm-vs-llm')
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({
    differenceFilter: 'llm-vs-llm',
    rowFilter: 'fully-answered',
  })
})

test('compare judgments URL state lets canonical params override legacy params', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({
    differenceFilter: 'all',
    rowFilter: 'multiple-answers',
    showOnlyFullyAnsweredPrompts: '1',
    showOnlyModelDifferences: '1',
  })

  expect(state.rowFilter).toBe('multiple-answers')
  expect(state.differenceFilter).toBe('all')
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({})
})

test('compare judgments URL state preserves selected difference filter until metadata confirms it', () => {
  const initialState = getInitialCompareProjectJudgmentsUrlState({differenceFilter: 'human-vs-llm'})
  const loadingMetadataState = {
    availableDifferenceFilters: ['all'] as const,
    differenceFilter: initialState.differenceFilter,
    hasLoadedMetadata: false,
  }
  const loadedMetadataState = {
    ...loadingMetadataState,
    availableDifferenceFilters: ['all', 'human-vs-llm'] as const,
    hasLoadedMetadata: true,
  }

  expect(getCompareProjectJudgmentsConfirmedDifferenceFilter(loadingMetadataState)).toBe('human-vs-llm')
  expect(getCanFetchCompareProjectJudgmentsPage({...loadingMetadataState, searchInitialized: true})).toBe(false)
  expect(getCompareProjectJudgmentsConfirmedDifferenceFilter(loadedMetadataState)).toBe('human-vs-llm')
  expect(getCanFetchCompareProjectJudgmentsPage({...loadedMetadataState, searchInitialized: true})).toBe(true)
})

test('compare judgments URL state resets selected difference filter after metadata rejects it', () => {
  const metadataState = {
    availableDifferenceFilters: ['all', 'llm-vs-llm'] as const,
    differenceFilter: 'human-vs-llm' as const,
    hasLoadedMetadata: true,
  }

  expect(getCompareProjectJudgmentsConfirmedDifferenceFilter(metadataState)).toBe('all')
  expect(getCanFetchCompareProjectJudgmentsPage({...metadataState, searchInitialized: true})).toBe(false)
})
