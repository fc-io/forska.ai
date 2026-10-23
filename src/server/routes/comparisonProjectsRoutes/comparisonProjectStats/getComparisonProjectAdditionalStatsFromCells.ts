import {
  getComparisonProjectStatsCellsByColumn,
  getComparisonProjectStatsConflictResolutionAnswersByArticleId,
} from './comparisonProjectStatsNormalizedCells.ts'
import type {
  ComparisonProjectAdditionalStats,
  ComparisonProjectStatsAnswerFilterValue,
  ComparisonProjectStatsConflictResolutionAnswerComparison,
  ComparisonProjectStatsConflictResolutionAnswerComparisonGroup,
  ComparisonProjectStatsFromCellsParams,
  ComparisonProjectStatsNormalizedCell,
} from './comparisonProjectStatsTypes.ts'
import {getComparisonProjectStatsResolvedTruthComparison} from './getComparisonProjectAdditionalStatsFromCells/getComparisonProjectStatsResolvedTruthComparison.ts'
import {getComparisonProjectAdditionalStatsGroups} from './getComparisonProjectAdditionalStatsGroups.ts'
import {getComparisonProjectConflictResolutionAnswerStatsGroups} from './getComparisonProjectConflictResolutionAnswerStatsGroups.ts'
import {getComparisonProjectStatsComparisonFromPairs} from './getComparisonProjectStatsComparisonFromPairs.ts'
import {getComparisonProjectStatsPairs} from './getComparisonProjectStatsPairs.ts'

const getComparisonProjectStatsHasFilterAnswer = (params: {
  articleId: string
  cellsByColumn: Map<string, Map<string, ComparisonProjectStatsNormalizedCell>>
  filterAnswerValue: ComparisonProjectStatsAnswerFilterValue
  filterColumnId: string
}) => {
  return Boolean(
    params.cellsByColumn
      .get(params.filterColumnId)
      ?.get(params.articleId)
      ?.normalizedAnswers.includes(params.filterAnswerValue),
  )
}

const getComparisonProjectStatsConflictResolutionAnswerComparison = (params: {
  cellsByColumn: Map<string, Map<string, ComparisonProjectStatsNormalizedCell>>
  conflictResolutionAnswersByArticleId: Map<string, string[]>
  group: ComparisonProjectStatsConflictResolutionAnswerComparisonGroup
}): ComparisonProjectStatsConflictResolutionAnswerComparison => {
  const pairs = getComparisonProjectStatsPairs(
    params.group,
    params.cellsByColumn,
    params.conflictResolutionAnswersByArticleId,
  ).filter((pair) => {
    return getComparisonProjectStatsHasFilterAnswer({
      articleId: pair.articleId,
      cellsByColumn: params.cellsByColumn,
      filterAnswerValue: params.group.answerFilterValue,
      filterColumnId: params.group.filterColumnId,
    })
  })

  return {
    ...params.group,
    ...getComparisonProjectStatsComparisonFromPairs({group: params.group, pairs, shouldComputeCohensKappa: true}),
  }
}

export const getComparisonProjectAdditionalStatsFromCells = (
  params: ComparisonProjectStatsFromCellsParams,
): ComparisonProjectAdditionalStats => {
  const groups = getComparisonProjectAdditionalStatsGroups(params)
  const conflictResolutionAnswerGroups = getComparisonProjectConflictResolutionAnswerStatsGroups(params)
  const cellsByColumn = getComparisonProjectStatsCellsByColumn(params.cellRows)
  const conflictResolutionAnswersByArticleId = getComparisonProjectStatsConflictResolutionAnswersByArticleId(
    params.conflictResolutionRows ?? [],
  )

  return {
    conflictResolutionAnswerComparisons: conflictResolutionAnswerGroups.map((group) => {
      return getComparisonProjectStatsConflictResolutionAnswerComparison({
        cellsByColumn,
        conflictResolutionAnswersByArticleId,
        group,
      })
    }),
    resolvedTruthComparisons: groups.map((group) => {
      return getComparisonProjectStatsResolvedTruthComparison({
        cellsByColumn,
        conflictResolutionAnswersByArticleId,
        group,
      })
    }),
  }
}
