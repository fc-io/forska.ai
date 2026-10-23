import {getSqlLiteral} from '../../../../services/appQueryHelpers.ts'
import type {ComparisonProjectStatsAggregateGroup} from '../comparisonProjectStatsTypes.ts'
import {getHasComparisonProjectStatsAnswerFilterGroups} from './getHasComparisonProjectStatsAnswerFilterGroups.ts'

const getComparisonProjectStatsAggregateFilterAnswerValue = (group: ComparisonProjectStatsAggregateGroup) => {
  return group.filterAnswerValue ?? group.answerFilterValue
}

export const getComparisonProjectStatsGroupValuesSql = (groups: readonly ComparisonProjectStatsAggregateGroup[]) => {
  const hasAnswerFilterGroups = getHasComparisonProjectStatsAnswerFilterGroups(groups)

  return groups
    .map((group) => {
      const baseValues = [
        getSqlLiteral(group.id),
        getSqlLiteral(group.kind),
        getSqlLiteral(group.leftColumnId),
        getSqlLiteral(group.rightColumnId),
      ]
      const filterValues = hasAnswerFilterGroups
        ? [
            getSqlLiteral(group.filterColumnId ?? null),
            getSqlLiteral(getComparisonProjectStatsAggregateFilterAnswerValue(group) ?? null),
          ]
        : []

      return `(${[...baseValues, ...filterValues].join(', ')})`
    })
    .join(',\n      ')
}
