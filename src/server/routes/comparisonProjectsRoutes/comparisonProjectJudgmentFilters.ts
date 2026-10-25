import {t} from 'elysia'

import {
  type ComparisonProjectArticleCategoryFilter,
  getNormalizedComparisonProjectArticleCategoryFilters,
} from '../../../utils/comparisonProjectArticleCategoryFilter.ts'
import {
  type ComparisonProjectConflictResolutionFilter,
  getNormalizedComparisonProjectConflictResolutionFilters,
  getNormalizedComparisonProjectConflictResolutionProvenanceFilters,
} from '../../../utils/comparisonProjectConflictResolutionFilter.ts'
import {
  type ComparisonProjectDifferenceFilter,
  type ComparisonProjectDifferenceFilterAvailability,
  getComparisonProjectDifferenceFilterSelection,
} from '../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectRowFilter,
  getNormalizedComparisonProjectRowFilters,
} from '../../../utils/comparisonProjectRowFilter.ts'
import {getNormalizedComparisonProjectSearchText} from '../../../utils/comparisonProjectSearchText.ts'
import {getComparisonProjectConflictResolutionOptionByValue} from './comparisonProjectConflictResolutionOptions.ts'
import type {ComparisonProjectConflictResolutionProvenanceFilter} from './comparisonProjectConflictResolutionProvenance.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getIsSummaryMode} from './getIsSummaryMode.ts'

export type ComparisonProjectJudgmentFilters = {
  articleCategoryFilters: readonly ComparisonProjectArticleCategoryFilter[]
  conflictResolutionFilters: readonly ComparisonProjectConflictResolutionFilter[]
  conflictResolutionProvenanceFilters: readonly ComparisonProjectConflictResolutionProvenanceFilter[]
  differenceFilters: readonly ComparisonProjectDifferenceFilter[]
  rowFilters: readonly ComparisonProjectRowFilter[]
  searchText: string
}

type ComparisonProjectJudgmentFilterBody = {
  articleCategoryFilter?: string | string[]
  conflictResolutionFilter?: string | string[]
  conflictResolutionProvenanceFilter?: string | string[]
  differenceFilter?: string | string[]
  rowFilter?: string | string[]
  search?: string
  showOnlyModelDifferences?: boolean
}

export const comparisonProjectFilterSelectionBodySchema = t.Union([t.String(), t.Array(t.String())])

const getRequestedComparisonProjectDifferenceFilters = (params: {
  differenceFilter?: string | string[]
  showOnlyModelDifferences?: boolean
}): ComparisonProjectDifferenceFilter[] => {
  const requestedDifferenceFilters = getComparisonProjectDifferenceFilterSelection(params.differenceFilter)

  return requestedDifferenceFilters.length > 0
    ? requestedDifferenceFilters
    : params.showOnlyModelDifferences
      ? ['llm-vs-llm']
      : []
}

const getScopedComparisonProjectConflictResolutionFilters = (
  scope: ComparisonProjectScope,
  value: string | string[] | null | undefined,
): ComparisonProjectConflictResolutionFilter[] => {
  if (!scope.allowConflictResolution || !getIsSummaryMode(scope)) {
    return []
  }

  const optionByValue = getComparisonProjectConflictResolutionOptionByValue(scope)

  return getNormalizedComparisonProjectConflictResolutionFilters(value).filter((conflictResolutionFilter) => {
    return conflictResolutionFilter === 'not-set' || optionByValue.has(conflictResolutionFilter)
  })
}

export const getRequestedComparisonProjectJudgmentFilters = (
  scope: ComparisonProjectScope,
  body: ComparisonProjectJudgmentFilterBody,
): ComparisonProjectJudgmentFilters => {
  return {
    articleCategoryFilters: getNormalizedComparisonProjectArticleCategoryFilters(body.articleCategoryFilter),
    conflictResolutionFilters: getScopedComparisonProjectConflictResolutionFilters(
      scope,
      body.conflictResolutionFilter,
    ),
    conflictResolutionProvenanceFilters: scope.allowConflictResolution
      ? getNormalizedComparisonProjectConflictResolutionProvenanceFilters(body.conflictResolutionProvenanceFilter)
      : [],
    differenceFilters: getRequestedComparisonProjectDifferenceFilters(body),
    rowFilters: getNormalizedComparisonProjectRowFilters(body.rowFilter),
    searchText: getNormalizedComparisonProjectSearchText(body.search),
  }
}

export const getComparisonProjectDifferenceFilterAvailability = (
  scope: Pick<ComparisonProjectScope, 'allowConflictResolution' | 'compareWithHumans' | 'humanJudgmentMode'>,
): ComparisonProjectDifferenceFilterAvailability => {
  return {hasConflictResolution: scope.allowConflictResolution && getIsSummaryMode(scope)}
}
