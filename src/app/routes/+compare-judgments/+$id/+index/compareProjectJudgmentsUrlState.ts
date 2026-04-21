import type {ComparisonProjectDifferenceFilter} from '../../../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  comparisonProjectRowFilters,
  defaultComparisonProjectRowFilter,
} from '../../../../../utils/comparisonProjectRowFilter.ts'

export const compareProjectJudgmentsPageLimitOptions = [25, 50, 100]

export type CompareProjectJudgmentsUrlState = {
  currentPage: number
  pageLimit: number
  rowFilter: ComparisonProjectRowFilter
  differenceFilter: ComparisonProjectDifferenceFilter
}

export const getDefaultCompareProjectJudgmentsUrlState = (): CompareProjectJudgmentsUrlState => {
  return {currentPage: 1, pageLimit: 50, rowFilter: defaultComparisonProjectRowFilter, differenceFilter: 'all'}
}

const getPositiveIntegerSearchParamValue = (value: unknown, fallback: number) => {
  const parsedValue = typeof value === 'number' ? value : Number.parseInt(typeof value === 'string' ? value : '', 10)

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback
}

const getIsActiveLegacySearchParamValue = (value: unknown): boolean => {
  const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : value

  return Array.isArray(normalizedValue)
    ? normalizedValue.some(getIsActiveLegacySearchParamValue)
    : normalizedValue === true
        || normalizedValue === 1
        || normalizedValue === '1'
        || normalizedValue === 'true'
        || normalizedValue === 'on'
}

const getIsComparisonProjectRowFilter = (value: unknown): value is ComparisonProjectRowFilter => {
  return comparisonProjectRowFilters.includes(value as ComparisonProjectRowFilter)
}

const getLegacyRowFilterSearchParamValue = (search: Record<string, unknown>): ComparisonProjectRowFilter => {
  return getIsActiveLegacySearchParamValue(search.showOnlyFullyAnsweredPrompts)
    ? 'fully-answered'
    : getIsActiveLegacySearchParamValue(search.showAllRows)
      ? 'all'
      : defaultComparisonProjectRowFilter
}

const getRowFilterSearchParamValue = (search: Record<string, unknown>): ComparisonProjectRowFilter => {
  return getIsComparisonProjectRowFilter(search.rowFilter)
    ? search.rowFilter
    : getLegacyRowFilterSearchParamValue(search)
}

const getIsComparisonProjectDifferenceFilter = (value: unknown): value is ComparisonProjectDifferenceFilter => {
  return value === 'human-vs-llm' || value === 'llm-vs-llm' || value === 'any-disagreement' || value === 'all'
}

const getDifferenceFilterSearchParamValue = (search: Record<string, unknown>): ComparisonProjectDifferenceFilter => {
  return getIsComparisonProjectDifferenceFilter(search.differenceFilter)
    ? search.differenceFilter
    : getIsActiveLegacySearchParamValue(search.showOnlyModelDifferences)
      ? 'llm-vs-llm'
      : 'all'
}

export const getInitialCompareProjectJudgmentsUrlState = (
  search: Record<string, unknown>,
): CompareProjectJudgmentsUrlState => {
  const defaultState = getDefaultCompareProjectJudgmentsUrlState()
  const parsedPageLimit = getPositiveIntegerSearchParamValue(search.limit, defaultState.pageLimit)

  return {
    currentPage: getPositiveIntegerSearchParamValue(search.page, defaultState.currentPage),
    pageLimit: compareProjectJudgmentsPageLimitOptions.includes(parsedPageLimit)
      ? parsedPageLimit
      : defaultState.pageLimit,
    rowFilter: getRowFilterSearchParamValue(search),
    differenceFilter: getDifferenceFilterSearchParamValue(search),
  }
}

export const getCompareProjectJudgmentsSearchParams = (
  state: CompareProjectJudgmentsUrlState,
): Record<string, string> => {
  const defaultState = getDefaultCompareProjectJudgmentsUrlState()
  const searchParams: Record<string, string> = {}

  if (state.currentPage !== defaultState.currentPage) {
    searchParams.page = String(state.currentPage)
  }

  if (state.pageLimit !== defaultState.pageLimit) {
    searchParams.limit = String(state.pageLimit)
  }

  if (state.rowFilter !== defaultState.rowFilter) {
    searchParams.rowFilter = state.rowFilter
  }

  if (state.differenceFilter !== defaultState.differenceFilter) {
    searchParams.differenceFilter = state.differenceFilter
  }

  return searchParams
}
