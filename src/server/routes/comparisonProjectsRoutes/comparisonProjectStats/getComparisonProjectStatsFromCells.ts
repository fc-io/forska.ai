import {
  getComparisonProjectStatsCellsByColumn,
  getComparisonProjectStatsConflictResolutionAnswersByArticleId,
} from './comparisonProjectStatsNormalizedCells.ts'
import type {
  ComparisonProjectStatsComparisonGroup,
  ComparisonProjectStatsFromCellsParams,
  ComparisonProjectStatsNormalizedCell,
} from './comparisonProjectStatsTypes.ts'
import {getComparisonProjectStatsComparisonFromPairs} from './getComparisonProjectStatsComparisonFromPairs.ts'
import {getComparisonProjectStatsComparisonGroups} from './getComparisonProjectStatsComparisonGroups.ts'
import {getComparisonProjectStatsPairs} from './getComparisonProjectStatsPairs.ts'
import {getShouldComputeCohensKappa} from './getShouldComputeCohensKappa.ts'

const getComparisonProjectStatsComparison = (params: {
  cellsByColumn: Map<string, Map<string, ComparisonProjectStatsNormalizedCell>>
  conflictResolutionAnswersByArticleId: Map<string, string[]>
  group: ComparisonProjectStatsComparisonGroup
  shouldComputeCohensKappa: boolean
}) => {
  return getComparisonProjectStatsComparisonFromPairs({
    group: params.group,
    pairs: getComparisonProjectStatsPairs(
      params.group,
      params.cellsByColumn,
      params.conflictResolutionAnswersByArticleId,
    ),
    shouldComputeCohensKappa: params.shouldComputeCohensKappa,
  })
}

export const getComparisonProjectStatsFromCells = (params: ComparisonProjectStatsFromCellsParams) => {
  const groups = getComparisonProjectStatsComparisonGroups(params)
  const cellsByColumn = getComparisonProjectStatsCellsByColumn(params.cellRows)
  const conflictResolutionAnswersByArticleId = getComparisonProjectStatsConflictResolutionAnswersByArticleId(
    params.conflictResolutionRows ?? [],
  )

  return groups.map((group) => {
    return getComparisonProjectStatsComparison({
      cellsByColumn,
      conflictResolutionAnswersByArticleId,
      group,
      shouldComputeCohensKappa: getShouldComputeCohensKappa({...params, group}),
    })
  })
}
