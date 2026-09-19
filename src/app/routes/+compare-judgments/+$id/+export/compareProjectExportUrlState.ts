import type {ComparisonProjectArticleCategory} from '../../../../../utils/comparisonProjectArticleCategoryFilter.ts'
import type {ComparisonProjectConflictResolutionFilter} from '../../../../../utils/comparisonProjectConflictResolutionFilter.ts'
import type {ComparisonProjectDifferenceFilter} from '../../../../../utils/comparisonProjectDifferenceFilter.ts'
import type {ComparisonProjectRowFilter} from '../../../../../utils/comparisonProjectRowFilter.ts'
import {
  type CompareProjectJudgmentsUrlState,
  getCompareProjectJudgmentsSearchParams,
  getInitialCompareProjectJudgmentsUrlState,
} from '../+index/compareProjectJudgmentsUrlState.ts'

export type CompareProjectExportRequestBody = {
  articleCategoryFilter: ComparisonProjectArticleCategory[]
  conflictResolutionFilter: ComparisonProjectConflictResolutionFilter[]
  differenceFilter: ComparisonProjectDifferenceFilter[]
  rowFilter: ComparisonProjectRowFilter[]
}

export const getInitialCompareProjectExportUrlState = (
  search: Record<string, unknown>,
): CompareProjectJudgmentsUrlState => {
  return getInitialCompareProjectJudgmentsUrlState(search)
}

export const getCompareProjectExportSearchParams = (state: CompareProjectJudgmentsUrlState): Record<string, string> => {
  return getCompareProjectJudgmentsSearchParams(state)
}

export const getCompareProjectExportRequestBody = (
  state: CompareProjectJudgmentsUrlState,
): CompareProjectExportRequestBody => {
  return {
    articleCategoryFilter: state.articleCategoryFilters,
    conflictResolutionFilter: state.conflictResolutionFilters,
    differenceFilter: state.differenceFilters,
    rowFilter: state.rowFilters,
  }
}
