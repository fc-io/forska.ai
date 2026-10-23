import {getNormalizedComparisonProjectDifferenceFilters} from '../../../utils/comparisonProjectDifferenceFilter.ts'
import {
  type ComparisonProjectJudgmentFilters,
  getComparisonProjectDifferenceFilterAvailability,
} from './comparisonProjectJudgmentFilters.ts'
import {getComparisonProjectServingJudgmentCount} from './comparisonProjectJudgmentRows.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'

export const getComparisonProjectJudgmentsCount = async (
  scope: ComparisonProjectScope,
  limit: number,
  filters: ComparisonProjectJudgmentFilters,
) => {
  if (scope.archived || scope.prompts.length === 0 || scope.columns.length === 0 || scope.activeGeneration === null) {
    return {
      activeGeneration: scope.activeGeneration,
      isServingReady: scope.isServingReady,
      limit,
      servingStatus: scope.servingStatus,
      servingUpdatedAt: scope.servingUpdatedAt,
      totalCount: 0,
      totalPages: 0,
    }
  }

  const normalizedDifferenceFilters = getNormalizedComparisonProjectDifferenceFilters(
    filters.differenceFilters,
    scope.columns,
    getComparisonProjectDifferenceFilterAvailability(scope),
  )
  const countResult = await getComparisonProjectServingJudgmentCount({
    comparisonProjectId: scope.id,
    articleCategoryFilter: filters.articleCategoryFilters,
    conflictResolutionFilter: filters.conflictResolutionFilters,
    conflictResolutionProvenanceFilter: filters.conflictResolutionProvenanceFilters,
    currentJudgmentContextId: scope.judgmentContextId,
    differenceFilter: normalizedDifferenceFilters,
    limit,
    queryRunner: appDatabaseService,
    rowFilter: filters.rowFilters,
    searchText: filters.searchText,
  })

  return {
    activeGeneration: scope.activeGeneration,
    isServingReady: scope.isServingReady,
    limit,
    servingStatus: scope.servingStatus,
    servingUpdatedAt: scope.servingUpdatedAt,
    totalCount: countResult.totalCount,
    totalPages: countResult.totalPages,
  }
}
