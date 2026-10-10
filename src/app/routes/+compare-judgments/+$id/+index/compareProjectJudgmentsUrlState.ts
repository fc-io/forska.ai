import {
  type ComparisonProjectArticleCategory,
  getNormalizedComparisonProjectArticleCategoryFilters,
} from '../../../../../utils/comparisonProjectArticleCategoryFilter.ts'
import {
  type ComparisonProjectConflictResolutionFilter,
  type ComparisonProjectConflictResolutionProvenanceFilter,
  getNormalizedComparisonProjectConflictResolutionFilters,
  getNormalizedComparisonProjectConflictResolutionProvenanceFilters,
} from '../../../../../utils/comparisonProjectConflictResolutionFilter.ts'
import {
  type ComparisonProjectDifferenceFilter,
  getComparisonProjectDifferenceFilterSelection,
} from '../../../../../utils/comparisonProjectDifferenceFilter.ts'
import {getComparisonProjectFilterSelectionSearchParam} from '../../../../../utils/comparisonProjectFilterSelection.ts'
import {
  type ComparisonProjectRowFilter,
  getNormalizedComparisonProjectRowFilters,
} from '../../../../../utils/comparisonProjectRowFilter.ts'
import {getNormalizedComparisonProjectSearchText} from '../../../../../utils/comparisonProjectSearchText.ts'

export const compareProjectJudgmentsPageLimitOptions = [25, 50, 100]

export type CompareProjectJudgmentsUrlState = {
  articleCategoryFilters: ComparisonProjectArticleCategory[]
  conflictResolutionFilters: ComparisonProjectConflictResolutionFilter[]
  conflictResolutionProvenanceFilters: ComparisonProjectConflictResolutionProvenanceFilter[]
  pageLimit: number
  rowFilters: ComparisonProjectRowFilter[]
  differenceFilters: ComparisonProjectDifferenceFilter[]
  searchText: string
}

type CompareProjectJudgmentsDifferenceFilterMetadataState = {
  availableDifferenceFilters: readonly ComparisonProjectDifferenceFilter[]
  differenceFilters: readonly ComparisonProjectDifferenceFilter[]
  hasLoadedMetadata: boolean
}

type CompareProjectJudgmentsPageQueryState = CompareProjectJudgmentsDifferenceFilterMetadataState & {
  searchInitialized: boolean
}

export const getDefaultCompareProjectJudgmentsUrlState = (): CompareProjectJudgmentsUrlState => {
  return {
    articleCategoryFilters: [],
    conflictResolutionFilters: [],
    conflictResolutionProvenanceFilters: [],
    pageLimit: 50,
    rowFilters: [],
    differenceFilters: [],
    searchText: '',
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

const getHasSearchParamValue = (value: unknown) => {
  return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim() !== ''
}

const getLegacyRowFilterSearchParamValues = (search: Record<string, unknown>): ComparisonProjectRowFilter[] => {
  return getIsActiveLegacySearchParamValue(search.showOnlyFullyAnsweredPrompts) ? ['fully-answered'] : []
}

const getRowFilterSearchParamValues = (search: Record<string, unknown>): ComparisonProjectRowFilter[] => {
  return getHasSearchParamValue(search.rowFilter)
    ? getNormalizedComparisonProjectRowFilters(search.rowFilter)
    : getLegacyRowFilterSearchParamValues(search)
}

const getDifferenceFilterSearchParamValues = (search: Record<string, unknown>): ComparisonProjectDifferenceFilter[] => {
  return getHasSearchParamValue(search.differenceFilter)
    ? getComparisonProjectDifferenceFilterSelection(search.differenceFilter)
    : getIsActiveLegacySearchParamValue(search.showOnlyModelDifferences)
      ? ['llm-vs-llm']
      : []
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
    rowFilters: getRowFilterSearchParamValues(search),
    differenceFilters: getDifferenceFilterSearchParamValues(search),
    articleCategoryFilters: getNormalizedComparisonProjectArticleCategoryFilters(search.articleCategoryFilter),
    conflictResolutionFilters: getNormalizedComparisonProjectConflictResolutionFilters(search.conflictResolutionFilter),
    conflictResolutionProvenanceFilters: getNormalizedComparisonProjectConflictResolutionProvenanceFilters(
      search.conflictResolutionProvenanceFilter,
    ),
    searchText: getNormalizedComparisonProjectSearchText(search.search),
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

  if (state.rowFilters.length > 0) {
    searchParams.rowFilter = getComparisonProjectFilterSelectionSearchParam(state.rowFilters)
  }

  if (state.differenceFilters.length > 0) {
    searchParams.differenceFilter = getComparisonProjectFilterSelectionSearchParam(state.differenceFilters)
  }

  if (state.articleCategoryFilters.length > 0) {
    searchParams.articleCategoryFilter = getComparisonProjectFilterSelectionSearchParam(state.articleCategoryFilters)
  }

  if (state.conflictResolutionFilters.length > 0) {
    searchParams.conflictResolutionFilter = getComparisonProjectFilterSelectionSearchParam(
      state.conflictResolutionFilters,
    )
  }

  if (state.conflictResolutionProvenanceFilters.length > 0) {
    searchParams.conflictResolutionProvenanceFilter = getComparisonProjectFilterSelectionSearchParam(
      state.conflictResolutionProvenanceFilters,
    )
  }

  if (state.searchText !== '') {
    searchParams.search = state.searchText
  }

  return searchParams
}

export const getCompareProjectJudgmentsConfirmedDifferenceFilters = (
  state: CompareProjectJudgmentsDifferenceFilterMetadataState,
): readonly ComparisonProjectDifferenceFilter[] => {
  return state.differenceFilters
}

export const getCanFetchCompareProjectJudgmentsPage = (state: CompareProjectJudgmentsPageQueryState) => {
  return state.searchInitialized && state.hasLoadedMetadata
}
