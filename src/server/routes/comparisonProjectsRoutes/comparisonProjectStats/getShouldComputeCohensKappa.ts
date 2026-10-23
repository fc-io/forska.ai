import {getIsComparisonProjectStatsNoFallbackConflictResolutionComparison} from './comparisonProjectStatsComparisonKind.ts'
import type {
  ComparisonProjectStatsColumn,
  ComparisonProjectStatsComparisonGroup,
} from './comparisonProjectStatsTypes.ts'
import {summaryPromptId} from './summaryPromptId.ts'

export const getShouldComputeCohensKappa = (params: {
  columns: readonly ComparisonProjectStatsColumn[]
  group: ComparisonProjectStatsComparisonGroup
  isSummaryMode: boolean
}) => {
  const summaryColumnCount = params.columns.filter((column) => {
    return column.promptId === summaryPromptId
  }).length

  return (
    params.isSummaryMode
    && (summaryColumnCount === 2
      || getIsComparisonProjectStatsNoFallbackConflictResolutionComparison(params.group.kind))
  )
}
