import {
  getComparisonProjectStatsColumnLabel,
  getComparisonProjectStatsContentLabel,
  getComparisonProjectStatsHumanComparisonColumnInfo,
  getComparisonProjectStatsLabelContext,
} from './comparisonProjectStatsLabels.ts'
import type {
  ComparisonProjectStatsColumn,
  ComparisonProjectStatsLabelContext,
  ComparisonProjectStatsResolvedTruthComparisonGroup,
} from './comparisonProjectStatsTypes.ts'
import {getShouldIncludeConflictResolutionStatsGroups} from './getShouldIncludeConflictResolutionStatsGroups.ts'
import {summaryPromptId} from './summaryPromptId.ts'

const getComparisonProjectStatsResolvedTruthColumnInfo = (
  humanColumn: ComparisonProjectStatsColumn,
  llmColumn: ComparisonProjectStatsColumn,
) => {
  return getComparisonProjectStatsHumanComparisonColumnInfo(
    getComparisonProjectStatsContentLabel(humanColumn),
    getComparisonProjectStatsContentLabel(llmColumn),
  )
}

const getComparisonProjectStatsResolvedTruthGroup = (
  humanColumn: ComparisonProjectStatsColumn,
  llmColumn: ComparisonProjectStatsColumn,
  context: ComparisonProjectStatsLabelContext,
): ComparisonProjectStatsResolvedTruthComparisonGroup => {
  return {
    columnInfo: getComparisonProjectStatsResolvedTruthColumnInfo(humanColumn, llmColumn),
    humanColumnId: humanColumn.id,
    id: `resolved-truth:${humanColumn.id}:${llmColumn.id}`,
    label: getComparisonProjectStatsColumnLabel(llmColumn, context),
    llmColumnId: llmColumn.id,
  }
}

const getComparisonProjectStatsResolvedTruthGroups = (
  humanColumns: readonly ComparisonProjectStatsColumn[],
  llmColumns: readonly ComparisonProjectStatsColumn[],
  context: ComparisonProjectStatsLabelContext,
) => {
  return humanColumns
    .filter((humanColumn) => {
      return humanColumn.promptId === summaryPromptId
    })
    .flatMap((humanColumn) => {
      return llmColumns
        .filter((llmColumn) => {
          return llmColumn.promptId === summaryPromptId
        })
        .map((llmColumn) => {
          return getComparisonProjectStatsResolvedTruthGroup(humanColumn, llmColumn, context)
        })
    })
}

export const getComparisonProjectAdditionalStatsGroups = (params: {
  allowConflictResolution?: boolean
  columns: readonly ComparisonProjectStatsColumn[]
  isSummaryMode?: boolean
}) => {
  if (!getShouldIncludeConflictResolutionStatsGroups(params)) {
    return []
  }

  const humanColumns = params.columns.filter((column) => {
    return column.kind === 'human'
  })
  const llmColumns = params.columns.filter((column) => {
    return column.kind === 'llm'
  })
  const labelContext = getComparisonProjectStatsLabelContext(params.columns)

  return getComparisonProjectStatsResolvedTruthGroups(humanColumns, llmColumns, labelContext)
}
