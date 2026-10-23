import {
  getComparisonProjectStatsAggregateRowsForArticleCategory,
  getComparisonProjectStatsCountValue,
} from './comparisonProjectStatsAggregates.ts'
import type {
  ComparisonProjectAdditionalStats,
  ComparisonProjectStatsArticleCategory,
  ComparisonProjectStatsResolvedTruthAggregateRow,
  ComparisonProjectStatsResolvedTruthComparisonGroup,
  ComparisonProjectStatsResolvedTruthCounts,
} from './comparisonProjectStatsTypes.ts'
import {emptyComparisonProjectStatsResolvedTruthCounts} from './emptyComparisonProjectStatsResolvedTruthCounts.ts'
import {getComparisonProjectStatsResolvedTruthComparisonFromCounts} from './getComparisonProjectStatsResolvedTruthComparisonFromCounts.ts'

const getComparisonProjectStatsResolvedTruthAggregate = (
  row: ComparisonProjectStatsResolvedTruthAggregateRow,
): ComparisonProjectStatsResolvedTruthCounts => {
  return {
    bothCorrectCount: getComparisonProjectStatsCountValue(row.bothCorrectCount),
    bothWrongCount: getComparisonProjectStatsCountValue(row.bothWrongCount),
    humanCorrectVsTruthCount: getComparisonProjectStatsCountValue(row.humanCorrectVsTruthCount),
    humanErrorsVsTruthCount: getComparisonProjectStatsCountValue(row.humanErrorsVsTruthCount),
    humanFalseNegativeCount: getComparisonProjectStatsCountValue(row.humanFalseNegativeCount),
    humanFalsePositiveCount: getComparisonProjectStatsCountValue(row.humanFalsePositiveCount),
    humanOnlyCorrectCount: getComparisonProjectStatsCountValue(row.humanOnlyCorrectCount),
    humanTrueNegativeCount: getComparisonProjectStatsCountValue(row.humanTrueNegativeCount),
    humanTruePositiveCount: getComparisonProjectStatsCountValue(row.humanTruePositiveCount),
    llmCorrectVsTruthCount: getComparisonProjectStatsCountValue(row.llmCorrectVsTruthCount),
    llmErrorsVsTruthCount: getComparisonProjectStatsCountValue(row.llmErrorsVsTruthCount),
    llmFalseNegativeCount: getComparisonProjectStatsCountValue(row.llmFalseNegativeCount),
    llmFalsePositiveCount: getComparisonProjectStatsCountValue(row.llmFalsePositiveCount),
    llmOnlyCorrectCount: getComparisonProjectStatsCountValue(row.llmOnlyCorrectCount),
    llmTrueNegativeCount: getComparisonProjectStatsCountValue(row.llmTrueNegativeCount),
    llmTruePositiveCount: getComparisonProjectStatsCountValue(row.llmTruePositiveCount),
    resolvedCount: getComparisonProjectStatsCountValue(row.resolvedCount),
  }
}

const getComparisonProjectStatsResolvedTruthAggregatesByComparisonId = (
  rows: readonly ComparisonProjectStatsResolvedTruthAggregateRow[],
) => {
  return rows.reduce<Map<string, ComparisonProjectStatsResolvedTruthCounts>>((aggregateMap, row) => {
    aggregateMap.set(row.comparisonId, getComparisonProjectStatsResolvedTruthAggregate(row))

    return aggregateMap
  }, new Map<string, ComparisonProjectStatsResolvedTruthCounts>())
}

export const getComparisonProjectAdditionalStatsFromAggregates = (params: {
  aggregateRows: readonly ComparisonProjectStatsResolvedTruthAggregateRow[]
  articleCategory?: ComparisonProjectStatsArticleCategory | null
  groups: readonly ComparisonProjectStatsResolvedTruthComparisonGroup[]
}): ComparisonProjectAdditionalStats => {
  const aggregateRows = getComparisonProjectStatsAggregateRowsForArticleCategory(
    params.aggregateRows,
    params.articleCategory ?? null,
  )
  const aggregatesByComparisonId = getComparisonProjectStatsResolvedTruthAggregatesByComparisonId(aggregateRows)

  return {
    conflictResolutionAnswerComparisons: [],
    resolvedTruthComparisons: params.groups.map((group) => {
      return getComparisonProjectStatsResolvedTruthComparisonFromCounts(
        group,
        aggregatesByComparisonId.get(group.id) ?? emptyComparisonProjectStatsResolvedTruthCounts,
      )
    }),
  }
}
