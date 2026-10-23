import {
  getComparisonProjectArticleCategoryFiltersLabel,
  getNormalizedComparisonProjectArticleCategoryFilters,
} from '../../../../../utils/comparisonProjectArticleCategoryFilter.ts'
import {getComparisonProjectDifferenceFiltersLabel} from '../../../../../utils/comparisonProjectDifferenceFilter.ts'
import {getComparisonProjectRowFiltersLabel} from '../../../../../utils/comparisonProjectRowFilter.ts'
import {getComparisonProjectConflictResolutionOptionByValue} from '../../comparisonProjectConflictResolutionOptions.ts'
import type {ComparisonProjectConflictResolutionProvenanceFilter} from '../../comparisonProjectConflictResolutionProvenance.ts'
import type {ComparisonProjectJudgmentFilters} from '../../comparisonProjectJudgmentFilters.ts'
import type {ComparisonProjectConflictResolutionFilter} from '../../comparisonProjectJudgmentRows.ts'
import type {ComparisonProjectScope} from '../../comparisonProjectScopeTypes.ts'
import {getIsSummaryMode} from '../../getIsSummaryMode.ts'

const getComparisonProjectConflictResolutionFilterValueLabel = (
  scope: ComparisonProjectScope,
  conflictResolutionFilter: ComparisonProjectConflictResolutionFilter,
) => {
  return conflictResolutionFilter === 'not-set'
    ? 'Not set'
    : (getComparisonProjectConflictResolutionOptionByValue(scope).get(conflictResolutionFilter)?.label
        ?? conflictResolutionFilter)
}

const getComparisonProjectConflictResolutionFiltersLabel = (
  scope: ComparisonProjectScope,
  conflictResolutionFilters: readonly ComparisonProjectConflictResolutionFilter[],
) => {
  return conflictResolutionFilters.length === 0
    ? 'Conflict resolution: All'
    : `Conflict resolution: ${conflictResolutionFilters
        .map((conflictResolutionFilter) => {
          return getComparisonProjectConflictResolutionFilterValueLabel(scope, conflictResolutionFilter)
        })
        .join(' + ')}`
}

const comparisonProjectConflictResolutionProvenanceFilterLabels = {
  current: 'Resolved under the current prompts',
  outdated: 'Resolved under older prompts',
  unknown: 'Prompts unknown',
} satisfies Record<ComparisonProjectConflictResolutionProvenanceFilter, string>

const getComparisonProjectConflictResolutionProvenanceFiltersLabel = (
  filters: readonly ComparisonProjectConflictResolutionProvenanceFilter[],
) => {
  return filters.length === 0
    ? null
    : `Resolution prompts: ${filters
        .map((filter) => {
          return comparisonProjectConflictResolutionProvenanceFilterLabels[filter]
        })
        .join(', ')}`
}

export const getComparisonProjectPdfHeaderFilters = (params: {
  filters: ComparisonProjectJudgmentFilters
  scope: ComparisonProjectScope
}) => {
  const rowFilterLabel = getComparisonProjectRowFiltersLabel(params.filters.rowFilters, getIsSummaryMode(params.scope))
  const differenceFilterLabel = getComparisonProjectDifferenceFiltersLabel(params.filters.differenceFilters)
  const conflictResolutionLabel = getComparisonProjectConflictResolutionFiltersLabel(
    params.scope,
    params.filters.conflictResolutionFilters,
  )
  const conflictResolutionProvenanceLabel = getComparisonProjectConflictResolutionProvenanceFiltersLabel(
    params.filters.conflictResolutionProvenanceFilters,
  )
  const articleCategoryLabel = getComparisonProjectArticleCategoryFiltersLabel(
    getNormalizedComparisonProjectArticleCategoryFilters(params.filters.articleCategoryFilters),
  )
  const searchLabel = params.filters.searchText === '' ? null : `Search: "${params.filters.searchText}"`

  return [
    rowFilterLabel,
    differenceFilterLabel,
    conflictResolutionLabel,
    conflictResolutionProvenanceLabel,
    articleCategoryLabel,
    searchLabel,
  ]
    .filter((label) => {
      return label !== null
    })
    .join(' | ')
}
