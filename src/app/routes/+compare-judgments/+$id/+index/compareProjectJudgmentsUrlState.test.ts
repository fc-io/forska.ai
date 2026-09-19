import {expect, test} from 'bun:test'

import {
  getCanFetchCompareProjectJudgmentsPage,
  getCompareProjectJudgmentsConfirmedDifferenceFilters,
  getCompareProjectJudgmentsSearchParams,
  getInitialCompareProjectJudgmentsUrlState,
} from './compareProjectJudgmentsUrlState.ts'

test('compare judgments URL state preserves canonical filter params', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({
    articleCategoryFilter: 'chinese',
    conflictResolutionFilter: 'maybe',
    differenceFilter: 'human-vs-llm-true-conflict',
    limit: '100',
    page: '3',
    rowFilter: 'fully-answered',
  })

  expect(state).toEqual({
    articleCategoryFilters: ['chinese'],
    conflictResolutionFilters: ['maybe'],
    differenceFilters: ['human-vs-llm-true-conflict'],
    pageLimit: 100,
    rowFilters: ['fully-answered'],
  })
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({
    articleCategoryFilter: 'chinese',
    conflictResolutionFilter: 'maybe',
    differenceFilter: 'human-vs-llm-true-conflict',
    limit: '100',
    rowFilter: 'fully-answered',
  })
})

test('compare judgments URL state reads and writes comma-separated multi selections in canonical order', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({
    articleCategoryFilter: 'non_chinese,chinese',
    conflictResolutionFilter: 'yes,not-set,yes',
    differenceFilter: 'resolution-vs-human,resolution-vs-llm-true-conflict,bogus',
    rowFilter: 'llm-answered-maybe,fully-answered,llm-answered-maybe,bogus',
  })

  expect(state.rowFilters).toEqual(['fully-answered', 'llm-answered-maybe'])
  expect(state.differenceFilters).toEqual(['resolution-vs-llm-true-conflict', 'resolution-vs-human'])
  expect(state.conflictResolutionFilters).toEqual(['yes', 'not-set'])
  expect(state.articleCategoryFilters).toEqual(['chinese', 'non_chinese'])
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({
    articleCategoryFilter: 'chinese,non_chinese',
    conflictResolutionFilter: 'yes,not-set',
    differenceFilter: 'resolution-vs-llm-true-conflict,resolution-vs-human',
    rowFilter: 'fully-answered,llm-answered-maybe',
  })
})

test('compare judgments URL state treats all and invalid values as no filter', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({
    articleCategoryFilter: 'not-a-category',
    conflictResolutionFilter: 'all',
    differenceFilter: 'all',
    rowFilter: 'all',
  })

  expect(state).toEqual({
    articleCategoryFilters: [],
    conflictResolutionFilters: [],
    differenceFilters: [],
    pageLimit: 50,
    rowFilters: [],
  })
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({})
})

test('compare judgments URL state preserves conflict-resolution filters', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({conflictResolutionFilter: 'not-set'})

  expect(state.conflictResolutionFilters).toEqual(['not-set'])
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({conflictResolutionFilter: 'not-set'})
})

test('compare judgments URL state normalizes legacy fully answered row filter', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({showOnlyFullyAnsweredPrompts: '1'})

  expect(state.rowFilters).toEqual(['fully-answered'])
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({rowFilter: 'fully-answered'})
})

test('compare judgments URL state normalizes legacy all rows filter when fully answered is inactive', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({showAllRows: '1'})

  expect(state.rowFilters).toEqual([])
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({})
})

test('compare judgments URL state prefers fully answered when both legacy row filters are active', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({showAllRows: true, showOnlyFullyAnsweredPrompts: '1'})

  expect(state.rowFilters).toEqual(['fully-answered'])
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({rowFilter: 'fully-answered'})
})

test('compare judgments URL state replaces legacy row and difference filters with canonical params', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({
    showOnlyFullyAnsweredPrompts: '1',
    showOnlyModelDifferences: '1',
  })

  expect(state.rowFilters).toEqual(['fully-answered'])
  expect(state.differenceFilters).toEqual(['llm-vs-llm'])
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

  expect(state.rowFilters).toEqual(['multiple-answers'])
  expect(state.differenceFilters).toEqual([])
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({rowFilter: 'multiple-answers'})
})

test('compare judgments URL state preserves selected difference filters until metadata confirms them', () => {
  const initialState = getInitialCompareProjectJudgmentsUrlState({
    differenceFilter: 'human-vs-llm,human-vs-llm-overlap',
  })
  const loadingMetadataState = {
    availableDifferenceFilters: ['all'] as const,
    differenceFilters: initialState.differenceFilters,
    hasLoadedMetadata: false,
  }
  const loadedMetadataState = {
    ...loadingMetadataState,
    availableDifferenceFilters: ['all', 'human-vs-llm-overlap', 'human-vs-llm'] as const,
    hasLoadedMetadata: true,
  }

  expect(getCompareProjectJudgmentsConfirmedDifferenceFilters(loadingMetadataState)).toEqual([
    'human-vs-llm-overlap',
    'human-vs-llm',
  ])
  expect(getCanFetchCompareProjectJudgmentsPage({...loadingMetadataState, searchInitialized: true})).toBe(false)
  expect(getCompareProjectJudgmentsConfirmedDifferenceFilters(loadedMetadataState)).toEqual([
    'human-vs-llm-overlap',
    'human-vs-llm',
  ])
  expect(getCanFetchCompareProjectJudgmentsPage({...loadedMetadataState, searchInitialized: true})).toBe(true)
})

test('compare judgments URL state preserves selected difference filters after metadata rejects them', () => {
  const metadataState = {
    availableDifferenceFilters: ['all', 'llm-vs-llm'] as const,
    differenceFilters: ['human-vs-llm'] as const,
    hasLoadedMetadata: true,
  }

  expect(getCompareProjectJudgmentsConfirmedDifferenceFilters(metadataState)).toEqual(['human-vs-llm'])
  expect(getCanFetchCompareProjectJudgmentsPage({...metadataState, searchInitialized: true})).toBe(true)
})
