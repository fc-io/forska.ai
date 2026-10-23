import type {
  ComparisonProjectStatsAggregateGroup,
  ComparisonProjectStatsComparisonGroup,
  ComparisonProjectStatsResolvedTruthComparisonGroup,
} from './comparisonProjectStatsTypes.ts'

export const getComparisonProjectStatsColumnIds = (groups: readonly ComparisonProjectStatsComparisonGroup[]) => {
  return Array.from(
    new Set(
      groups.flatMap((group) => {
        return [group.leftColumnId, group.rightColumnId]
      }),
    ),
  )
}

export const getComparisonProjectStatsAggregateColumnIds = (
  groups: readonly ComparisonProjectStatsAggregateGroup[],
) => {
  return Array.from(
    new Set(
      groups.flatMap((group) => {
        return [group.leftColumnId, group.rightColumnId, group.filterColumnId].filter(
          (columnId): columnId is string => {
            return typeof columnId === 'string'
          },
        )
      }),
    ),
  )
}

export const getComparisonProjectStatsResolvedTruthColumnIds = (
  groups: readonly ComparisonProjectStatsResolvedTruthComparisonGroup[],
) => {
  return Array.from(
    new Set(
      groups.flatMap((group) => {
        return [group.humanColumnId, group.llmColumnId]
      }),
    ),
  )
}
