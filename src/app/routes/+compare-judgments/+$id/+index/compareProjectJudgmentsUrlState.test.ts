import {expect, test} from 'bun:test'

import {
  getCompareProjectJudgmentsSearchParams,
  getInitialCompareProjectJudgmentsUrlState,
} from './compareProjectJudgmentsUrlState.ts'

test('compare judgments URL state preserves canonical filter params', () => {
  const state = getInitialCompareProjectJudgmentsUrlState({
    differenceFilter: 'human-vs-llm',
    limit: '100',
    page: '3',
    rowFilter: 'fully-answered',
  })

  expect(state).toEqual({currentPage: 3, differenceFilter: 'human-vs-llm', pageLimit: 100, rowFilter: 'fully-answered'})
  expect(getCompareProjectJudgmentsSearchParams(state)).toEqual({
    differenceFilter: 'human-vs-llm',
    limit: '100',
    page: '3',
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
