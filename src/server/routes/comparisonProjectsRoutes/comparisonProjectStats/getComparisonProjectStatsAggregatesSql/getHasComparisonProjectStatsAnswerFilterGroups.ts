import type {ComparisonProjectStatsAggregateGroup} from '../comparisonProjectStatsTypes.ts'

export const getHasComparisonProjectStatsAnswerFilterGroups = (
  groups: readonly ComparisonProjectStatsAggregateGroup[],
) => {
  return groups.some((group) => {
    return Boolean(group.filterColumnId && (group.filterAnswerValue ?? group.answerFilterValue))
  })
}
