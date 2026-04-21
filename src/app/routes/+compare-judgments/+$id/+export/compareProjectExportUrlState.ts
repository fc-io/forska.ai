import type {ComparisonProjectDifferenceFilter} from '../../../../../utils/comparisonProjectDifferenceFilter.ts'
import type {ComparisonProjectRowFilter} from '../../../../../utils/comparisonProjectRowFilter.ts'
import {
  type CompareProjectJudgmentsUrlState,
  getCompareProjectJudgmentsSearchParams,
  getInitialCompareProjectJudgmentsUrlState,
} from '../+index/compareProjectJudgmentsUrlState.ts'

export type CompareProjectExportRequestBody = {
  differenceFilter: ComparisonProjectDifferenceFilter
  rowFilter: ComparisonProjectRowFilter
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
  return {differenceFilter: state.differenceFilter, rowFilter: state.rowFilter}
}
