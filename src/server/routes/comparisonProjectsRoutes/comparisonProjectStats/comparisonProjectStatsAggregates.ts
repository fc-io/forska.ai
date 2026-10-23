import type {
  ComparisonProjectStatsAggregate,
  ComparisonProjectStatsAggregateRow,
  ComparisonProjectStatsArticleCategory,
} from './comparisonProjectStatsTypes.ts'

export const getComparisonProjectStatsCountValue = (value: unknown) => {
  const parsedValue = typeof value === 'bigint' ? Number(value) : Number(value)

  return Number.isSafeInteger(parsedValue) && parsedValue >= 0 ? parsedValue : 0
}

export const getComparisonProjectStatsArticleCategory = (
  value: unknown,
): ComparisonProjectStatsArticleCategory | null => {
  return value === 'chinese' || value === 'non_chinese' ? value : null
}

const getComparisonProjectStatsAggregate = (
  row: ComparisonProjectStatsAggregateRow,
): ComparisonProjectStatsAggregate => {
  return {
    agreementCount: getComparisonProjectStatsCountValue(row.agreementCount),
    binaryPairCount: getComparisonProjectStatsCountValue(row.binaryPairCount),
    conflictCount: getComparisonProjectStatsCountValue(row.conflictCount),
    leftExcludeCount: getComparisonProjectStatsCountValue(row.leftExcludeCount),
    leftExcludeRightExcludeCount: getComparisonProjectStatsCountValue(row.leftExcludeRightExcludeCount),
    leftIncludeCount: getComparisonProjectStatsCountValue(row.leftIncludeCount),
    leftIncludeRightIncludeCount: getComparisonProjectStatsCountValue(row.leftIncludeRightIncludeCount),
    overlapCount: getComparisonProjectStatsCountValue(row.overlapCount),
    rightExcludeCount: getComparisonProjectStatsCountValue(row.rightExcludeCount),
    rightIncludeCount: getComparisonProjectStatsCountValue(row.rightIncludeCount),
    trueConflictCount: getComparisonProjectStatsCountValue(row.trueConflictCount),
  }
}

export const emptyComparisonProjectStatsAggregate = {
  agreementCount: 0,
  binaryPairCount: 0,
  conflictCount: 0,
  leftExcludeCount: 0,
  leftExcludeRightExcludeCount: 0,
  leftIncludeCount: 0,
  leftIncludeRightIncludeCount: 0,
  overlapCount: 0,
  rightExcludeCount: 0,
  rightIncludeCount: 0,
  trueConflictCount: 0,
} satisfies ComparisonProjectStatsAggregate

export const getComparisonProjectStatsAggregateRowsForArticleCategory = <T extends {articleCategory?: unknown}>(
  rows: readonly T[],
  articleCategory: ComparisonProjectStatsArticleCategory | null,
) => {
  return rows.filter((row) => {
    return getComparisonProjectStatsArticleCategory(row.articleCategory) === articleCategory
  })
}

export const getComparisonProjectStatsAggregatesByComparisonId = (
  rows: readonly ComparisonProjectStatsAggregateRow[],
) => {
  return rows.reduce<Map<string, ComparisonProjectStatsAggregate>>((aggregateMap, row) => {
    aggregateMap.set(row.comparisonId, getComparisonProjectStatsAggregate(row))

    return aggregateMap
  }, new Map<string, ComparisonProjectStatsAggregate>())
}
