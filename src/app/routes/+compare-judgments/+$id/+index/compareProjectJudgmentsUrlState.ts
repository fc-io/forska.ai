import {
  type ComparisonProjectArticleCategoryFilter,
  defaultComparisonProjectArticleCategoryFilter,
  getNormalizedComparisonProjectArticleCategoryFilter,
} from '../../../../../utils/comparisonProjectArticleCategoryFilter.ts'
import {
  type ComparisonProjectConflictResolutionFilter,
  defaultComparisonProjectConflictResolutionFilter,
  getNormalizedComparisonProjectConflictResolutionFilter,
} from '../../../../../utils/comparisonProjectConflictResolutionFilter.ts'
import {
  type ComparisonProjectDifferenceFilter,
  comparisonProjectDifferenceFilters,
} from '../../../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  comparisonProjectRowFilters,
  defaultComparisonProjectRowFilter,
} from '../../../../../utils/comparisonProjectRowFilter.ts'

export const compareProjectJudgmentsPageLimitOptions = [25, 50, 100]

export type CompareProjectJudgmentsUrlState = {
  articleCategoryFilter: ComparisonProjectArticleCategoryFilter
  conflictResolutionFilter: ComparisonProjectConflictResolutionFilter
  pageLimit: number
  rowFilter: ComparisonProjectRowFilter
  differenceFilter: ComparisonProjectDifferenceFilter
}

type CompareProjectJudgmentsDifferenceFilterMetadataState = {
  availableDifferenceFilters: readonly ComparisonProjectDifferenceFilter[]
  differenceFilter: ComparisonProjectDifferenceFilter
  hasLoadedMetadata: boolean
}

type CompareProjectJudgmentsPageQueryState = CompareProjectJudgmentsDifferenceFilterMetadataState & {
  searchInitialized: boolean
}

export const getDefaultCompareProjectJudgmentsUrlState = (): CompareProjectJudgmentsUrlState => {
  return {
    articleCategoryFilter: defaultComparisonProjectArticleCategoryFilter,
    conflictResolutionFilter: defaultComparisonProjectConflictResolutionFilter,
    pageLimit: 50,
    rowFilter: defaultComparisonProjectRowFilter,
    differenceFilter: 'all',
  }
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
  return comparisonProjectDifferenceFilters.includes(value as ComparisonProjectDifferenceFilter)
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
    pageLimit: compareProjectJudgmentsPageLimitOptions.includes(parsedPageLimit)
      ? parsedPageLimit
      : defaultState.pageLimit,
    rowFilter: getRowFilterSearchParamValue(search),
    differenceFilter: getDifferenceFilterSearchParamValue(search),
    articleCategoryFilter: getNormalizedComparisonProjectArticleCategoryFilter(search.articleCategoryFilter),
    conflictResolutionFilter: getNormalizedComparisonProjectConflictResolutionFilter(search.conflictResolutionFilter),
  }
}

export const getCompareProjectJudgmentsSearchParams = (
  state: CompareProjectJudgmentsUrlState,
): Record<string, string> => {
  const defaultState = getDefaultCompareProjectJudgmentsUrlState()
  const searchParams: Record<string, string> = {}

  if (state.pageLimit !== defaultState.pageLimit) {
    searchParams.limit = String(state.pageLimit)
  }

  if (state.rowFilter !== defaultState.rowFilter) {
    searchParams.rowFilter = state.rowFilter
  }

  if (state.differenceFilter !== defaultState.differenceFilter) {
    searchParams.differenceFilter = state.differenceFilter
  }

  if (state.articleCategoryFilter !== defaultState.articleCategoryFilter) {
    searchParams.articleCategoryFilter = state.articleCategoryFilter
  }

  if (state.conflictResolutionFilter !== defaultState.conflictResolutionFilter) {
    searchParams.conflictResolutionFilter = state.conflictResolutionFilter
  }

  return searchParams
}

export const getCompareProjectJudgmentsConfirmedDifferenceFilter = (
  state: CompareProjectJudgmentsDifferenceFilterMetadataState,
): ComparisonProjectDifferenceFilter => {
  return state.differenceFilter
}

export const getCanFetchCompareProjectJudgmentsPage = (state: CompareProjectJudgmentsPageQueryState) => {
  return state.searchInitialized && state.hasLoadedMetadata
}
