import {
  getCohensKappaFromAggregate,
  getSensitivityFromAggregate,
  getSpecificityFromAggregate,
} from './comparisonProjectStatsAggregateMetrics.ts'
import {
  emptyComparisonProjectStatsAggregate,
  getComparisonProjectStatsAggregateRowsForArticleCategory,
  getComparisonProjectStatsAggregatesByComparisonId,
} from './comparisonProjectStatsAggregates.ts'
import type {
  ComparisonProjectStatsAggregateRow,
  ComparisonProjectStatsArticleCategory,
  ComparisonProjectStatsColumn,
  ComparisonProjectStatsComparisonGroup,
} from './comparisonProjectStatsTypes.ts'
import {getShouldComputeCohensKappa} from './getShouldComputeCohensKappa.ts'

export const getComparisonProjectStatsFromAggregates = (params: {
  aggregateRows: readonly ComparisonProjectStatsAggregateRow[]
  articleCategory?: ComparisonProjectStatsArticleCategory | null
  columns: readonly ComparisonProjectStatsColumn[]
  groups: readonly ComparisonProjectStatsComparisonGroup[]
  isSummaryMode: boolean
}) => {
  const aggregateRows = getComparisonProjectStatsAggregateRowsForArticleCategory(
    params.aggregateRows,
    params.articleCategory ?? null,
  )
  const aggregatesByComparisonId = getComparisonProjectStatsAggregatesByComparisonId(aggregateRows)

  return params.groups.map((group) => {
    const aggregate = aggregatesByComparisonId.get(group.id) ?? emptyComparisonProjectStatsAggregate
    const shouldComputeCohensKappa = getShouldComputeCohensKappa({
      columns: params.columns,
      group,
      isSummaryMode: params.isSummaryMode,
    })

    return {
      ...group,
      cohensKappa: shouldComputeCohensKappa ? getCohensKappaFromAggregate(aggregate) : null,
      conflictCount: aggregate.conflictCount,
      overlapCount: aggregate.overlapCount,
      sensitivity: getSensitivityFromAggregate(group.kind, aggregate),
      specificity: getSpecificityFromAggregate(group.kind, aggregate),
      trueConflictCount: aggregate.trueConflictCount,
    }
  })
}
