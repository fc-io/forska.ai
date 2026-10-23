import {
  getComparisonProjectStatsColumnLabel,
  getComparisonProjectStatsLabelContext,
} from './comparisonProjectStatsLabels.ts'
import type {
  ComparisonProjectStatsAnswerFilterKind,
  ComparisonProjectStatsAnswerFilterValue,
  ComparisonProjectStatsColumn,
  ComparisonProjectStatsComparisonGroup,
  ComparisonProjectStatsConflictResolutionAnswerComparisonGroup,
  ComparisonProjectStatsLabelContext,
} from './comparisonProjectStatsTypes.ts'
import {getComparisonProjectStatsGroup} from './getComparisonProjectStatsGroup.ts'
import {getShouldIncludeConflictResolutionStatsGroups} from './getShouldIncludeConflictResolutionStatsGroups.ts'
import {summaryPromptId} from './summaryPromptId.ts'

const comparisonProjectStatsAnswerFilterValues = ['yes', 'no', 'maybe'] as const

const getComparisonProjectStatsAnswerFilterLabel = (
  column: ComparisonProjectStatsColumn,
  answerFilterValue: ComparisonProjectStatsAnswerFilterValue,
  context: ComparisonProjectStatsLabelContext,
) => {
  return `${getComparisonProjectStatsColumnLabel(column, context)} has answered ${answerFilterValue}`
}

const getComparisonProjectStatsConflictResolutionAnswerGroup = (params: {
  answerFilterKind: ComparisonProjectStatsAnswerFilterKind
  answerFilterValue: ComparisonProjectStatsAnswerFilterValue
  comparisonGroup: ComparisonProjectStatsComparisonGroup
  context: ComparisonProjectStatsLabelContext
  filterColumn: ComparisonProjectStatsColumn
}): ComparisonProjectStatsConflictResolutionAnswerComparisonGroup => {
  return {
    ...params.comparisonGroup,
    answerFilterKind: params.answerFilterKind,
    answerFilterLabel: getComparisonProjectStatsAnswerFilterLabel(
      params.filterColumn,
      params.answerFilterValue,
      params.context,
    ),
    answerFilterValue: params.answerFilterValue,
    filterColumnId: params.filterColumn.id,
    id: `conflict-resolution-answer:${params.comparisonGroup.id}:${params.filterColumn.id}:${params.answerFilterValue}`,
  }
}

const getComparisonProjectStatsConflictResolutionAnswerGroupsForColumn = (params: {
  context: ComparisonProjectStatsLabelContext
  humanColumns: readonly ComparisonProjectStatsColumn[]
  llmColumn: ComparisonProjectStatsColumn
}) => {
  const comparisonGroup = getComparisonProjectStatsGroup(
    'llm-vs-conflict-resolution-no-fallback',
    params.llmColumn,
    params.llmColumn,
    params.context,
  )
  const llmAnswerGroups = comparisonProjectStatsAnswerFilterValues.map((answerFilterValue) => {
    return getComparisonProjectStatsConflictResolutionAnswerGroup({
      answerFilterKind: 'llm',
      answerFilterValue,
      comparisonGroup,
      context: params.context,
      filterColumn: params.llmColumn,
    })
  })
  const humanAnswerGroups = params.humanColumns.flatMap((humanColumn) => {
    return comparisonProjectStatsAnswerFilterValues.map((answerFilterValue) => {
      return getComparisonProjectStatsConflictResolutionAnswerGroup({
        answerFilterKind: 'human',
        answerFilterValue,
        comparisonGroup,
        context: params.context,
        filterColumn: humanColumn,
      })
    })
  })

  return [...llmAnswerGroups, ...humanAnswerGroups]
}

const getComparisonProjectStatsConflictResolutionAnswerGroups = (
  humanColumns: readonly ComparisonProjectStatsColumn[],
  llmColumns: readonly ComparisonProjectStatsColumn[],
  context: ComparisonProjectStatsLabelContext,
) => {
  const summaryHumanColumns = humanColumns.filter((humanColumn) => {
    return humanColumn.promptId === summaryPromptId
  })
  const summaryLlmColumns = llmColumns.filter((llmColumn) => {
    return llmColumn.promptId === summaryPromptId
  })

  return summaryLlmColumns.flatMap((llmColumn) => {
    return getComparisonProjectStatsConflictResolutionAnswerGroupsForColumn({
      context,
      humanColumns: summaryHumanColumns,
      llmColumn,
    })
  })
}

export const getComparisonProjectConflictResolutionAnswerStatsGroups = (params: {
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

  return getComparisonProjectStatsConflictResolutionAnswerGroups(humanColumns, llmColumns, labelContext)
}
