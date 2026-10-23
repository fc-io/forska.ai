import {getComparisonProjectStatsLabelContext} from './comparisonProjectStatsLabels.ts'
import type {ComparisonProjectStatsColumn, ComparisonProjectStatsLabelContext} from './comparisonProjectStatsTypes.ts'
import {getComparisonProjectStatsGroup} from './getComparisonProjectStatsGroup.ts'
import {getShouldIncludeConflictResolutionStatsGroups} from './getShouldIncludeConflictResolutionStatsGroups.ts'
import {summaryPromptId} from './summaryPromptId.ts'

const getFallbackPrimaryLlmColumnIds = (llmColumns: readonly ComparisonProjectStatsColumn[]) => {
  return new Set(
    Array.from(
      llmColumns
        .reduce<Map<string, ComparisonProjectStatsColumn>>((columnMap, column) => {
          return columnMap.has(column.promptId) ? columnMap : columnMap.set(column.promptId, column)
        }, new Map<string, ComparisonProjectStatsColumn>())
        .values(),
    ).map((column) => {
      return column.id
    }),
  )
}

const getExplicitPrimaryLlmColumnIds = (
  llmColumns: readonly ComparisonProjectStatsColumn[],
  params: {primaryModelId?: string | null; primarySourceProjectId?: string | null},
) => {
  if (params.primarySourceProjectId) {
    return new Set(
      llmColumns
        .filter((column) => {
          return column.sourceProjectId === params.primarySourceProjectId
        })
        .map((column) => {
          return column.id
        }),
    )
  }

  return new Set(
    llmColumns
      .filter((column) => {
        return Boolean(params.primaryModelId) && column.modelId === params.primaryModelId
      })
      .map((column) => {
        return column.id
      }),
  )
}

const getPrimaryLlmColumnIds = (
  llmColumns: readonly ComparisonProjectStatsColumn[],
  params: {primaryModelId?: string | null; primarySourceProjectId?: string | null},
) => {
  const explicitPrimaryColumnIds = getExplicitPrimaryLlmColumnIds(llmColumns, params)

  return explicitPrimaryColumnIds.size > 0 ? explicitPrimaryColumnIds : getFallbackPrimaryLlmColumnIds(llmColumns)
}

const getHumanVsLlmComparisonProjectStatsGroups = (
  humanColumns: readonly ComparisonProjectStatsColumn[],
  llmColumns: readonly ComparisonProjectStatsColumn[],
  primaryLlmColumnIds: ReadonlySet<string>,
  includeConflictResolutionGroups: boolean,
  context: ComparisonProjectStatsLabelContext,
) => {
  return humanColumns.flatMap((humanColumn) => {
    return llmColumns
      .filter((llmColumn) => {
        return llmColumn.promptId === humanColumn.promptId
      })
      .map((llmColumn) => {
        const kind = primaryLlmColumnIds.has(llmColumn.id) ? 'primary-vs-human' : 'human-vs-llm'
        const comparisonGroup = getComparisonProjectStatsGroup(kind, humanColumn, llmColumn, context)
        const conflictResolutionGroup = getComparisonProjectStatsGroup(
          'llm-vs-conflict-resolution',
          humanColumn,
          llmColumn,
          context,
        )

        return includeConflictResolutionGroups ? [comparisonGroup, conflictResolutionGroup] : [comparisonGroup]
      })
      .flat()
  })
}

const getLlmVsLlmComparisonProjectStatsGroups = (
  llmColumns: readonly ComparisonProjectStatsColumn[],
  context: ComparisonProjectStatsLabelContext,
) => {
  return llmColumns.flatMap((leftColumn, leftIndex) => {
    return llmColumns
      .slice(leftIndex + 1)
      .filter((rightColumn) => {
        return rightColumn.promptId === leftColumn.promptId
      })
      .map((rightColumn) => {
        return getComparisonProjectStatsGroup('llm-vs-llm', leftColumn, rightColumn, context)
      })
  })
}

const getHumanVsConflictResolutionComparisonProjectStatsGroups = (
  humanColumns: readonly ComparisonProjectStatsColumn[],
  context: ComparisonProjectStatsLabelContext,
) => {
  return humanColumns
    .filter((humanColumn) => {
      return humanColumn.promptId === summaryPromptId
    })
    .map((humanColumn) => {
      return getComparisonProjectStatsGroup('human-vs-conflict-resolution', humanColumn, humanColumn, context)
    })
}

const getLlmVsConflictResolutionNoFallbackComparisonProjectStatsGroups = (
  llmColumns: readonly ComparisonProjectStatsColumn[],
  context: ComparisonProjectStatsLabelContext,
) => {
  return llmColumns
    .filter((llmColumn) => {
      return llmColumn.promptId === summaryPromptId
    })
    .map((llmColumn) => {
      return getComparisonProjectStatsGroup('llm-vs-conflict-resolution-no-fallback', llmColumn, llmColumn, context)
    })
}

export const getComparisonProjectStatsComparisonGroups = (params: {
  allowConflictResolution?: boolean
  columns: readonly ComparisonProjectStatsColumn[]
  isSummaryMode?: boolean
  primaryModelId?: string | null
  primarySourceProjectId?: string | null
}) => {
  const humanColumns = params.columns.filter((column) => {
    return column.kind === 'human'
  })
  const llmColumns = params.columns.filter((column) => {
    return column.kind === 'llm'
  })
  const primaryLlmColumnIds = getPrimaryLlmColumnIds(llmColumns, params)
  const includeConflictResolutionGroups = getShouldIncludeConflictResolutionStatsGroups(params)
  const labelContext = getComparisonProjectStatsLabelContext(params.columns)

  return [
    ...getHumanVsLlmComparisonProjectStatsGroups(
      humanColumns,
      llmColumns,
      primaryLlmColumnIds,
      includeConflictResolutionGroups,
      labelContext,
    ),
    ...(includeConflictResolutionGroups
      ? getLlmVsConflictResolutionNoFallbackComparisonProjectStatsGroups(llmColumns, labelContext)
      : []),
    ...(includeConflictResolutionGroups
      ? getHumanVsConflictResolutionComparisonProjectStatsGroups(humanColumns, labelContext)
      : []),
    ...getLlmVsLlmComparisonProjectStatsGroups(llmColumns, labelContext),
  ]
}
