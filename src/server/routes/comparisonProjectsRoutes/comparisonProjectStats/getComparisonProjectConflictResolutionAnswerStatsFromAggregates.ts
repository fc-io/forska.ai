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
  ComparisonProjectStatsConflictResolutionAnswerComparison,
  ComparisonProjectStatsConflictResolutionAnswerComparisonGroup,
} from './comparisonProjectStatsTypes.ts'

export const getComparisonProjectConflictResolutionAnswerStatsFromAggregates = (params: {
  aggregateRows: readonly ComparisonProjectStatsAggregateRow[]
  articleCategory?: ComparisonProjectStatsArticleCategory | null
  groups: readonly ComparisonProjectStatsConflictResolutionAnswerComparisonGroup[]
}): ComparisonProjectStatsConflictResolutionAnswerComparison[] => {
  const aggregateRows = getComparisonProjectStatsAggregateRowsForArticleCategory(
    params.aggregateRows,
    params.articleCategory ?? null,
  )
  const aggregatesByComparisonId = getComparisonProjectStatsAggregatesByComparisonId(aggregateRows)

  return params.groups.map((group) => {
    const aggregate = aggregatesByComparisonId.get(group.id) ?? emptyComparisonProjectStatsAggregate

    return {
      ...group,
      cohensKappa: getCohensKappaFromAggregate(aggregate),
      conflictCount: aggregate.conflictCount,
      overlapCount: aggregate.overlapCount,
      sensitivity: getSensitivityFromAggregate(group.kind, aggregate),
      specificity: getSpecificityFromAggregate(group.kind, aggregate),
      trueConflictCount: aggregate.trueConflictCount,
    }
  })
}
