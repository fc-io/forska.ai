import type {ComparisonProjectStatsColumn, ComparisonProjectStatsLabelContext} from './comparisonProjectStatsTypes.ts'
import {summaryPromptId} from './summaryPromptId.ts'

const getColumnLabelPart = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''

  return trimmedValue.length > 0 ? trimmedValue : null
}

const getComparisonProjectStatsColumnModelLabel = (column: ComparisonProjectStatsColumn) => {
  return getColumnLabelPart(column.modelLabel)
}

const getComparisonProjectStatsColumnSourceProjectName = (column: ComparisonProjectStatsColumn) => {
  return getColumnLabelPart(column.sourceProjectName)
}

const getComparisonProjectStatsColumnSourceProjectKey = (column: ComparisonProjectStatsColumn) => {
  return getColumnLabelPart(column.sourceProjectId) ?? getComparisonProjectStatsColumnSourceProjectName(column)
}

const getComparisonProjectStatsAmbiguousLlmModelLabels = (columns: readonly ComparisonProjectStatsColumn[]) => {
  const sourceProjectKeysByModelLabel = columns
    .filter((column) => {
      return column.kind === 'llm'
    })
    .reduce<Map<string, Set<string>>>((sourceProjectKeyMap, column) => {
      const modelLabel = getComparisonProjectStatsColumnModelLabel(column)
      const sourceProjectKey = getComparisonProjectStatsColumnSourceProjectKey(column)

      if (!modelLabel || !sourceProjectKey) {
        return sourceProjectKeyMap
      }

      const sourceProjectKeys = sourceProjectKeyMap.get(modelLabel) ?? new Set<string>()

      sourceProjectKeys.add(sourceProjectKey)
      sourceProjectKeyMap.set(modelLabel, sourceProjectKeys)
      return sourceProjectKeyMap
    }, new Map<string, Set<string>>())

  return new Set(
    Array.from(sourceProjectKeysByModelLabel.entries())
      .filter(([, sourceProjectKeys]) => {
        return sourceProjectKeys.size > 1
      })
      .map(([modelLabel]) => {
        return modelLabel
      }),
  )
}

export const getComparisonProjectStatsLabelContext = (columns: readonly ComparisonProjectStatsColumn[]) => {
  return {ambiguousLlmModelLabels: getComparisonProjectStatsAmbiguousLlmModelLabels(columns)}
}

const getComparisonProjectStatsColumnRaterLabel = (
  column: ComparisonProjectStatsColumn,
  context: ComparisonProjectStatsLabelContext,
) => {
  const modelLabel = getComparisonProjectStatsColumnModelLabel(column)
  const sourceProjectName = getComparisonProjectStatsColumnSourceProjectName(column)

  return column.kind === 'human'
    ? 'Human'
    : modelLabel && sourceProjectName && context.ambiguousLlmModelLabels.has(modelLabel)
      ? `${modelLabel} (${sourceProjectName})`
      : (modelLabel ?? sourceProjectName ?? 'LLM')
}

export const getComparisonProjectStatsColumnLabel = (
  column: ComparisonProjectStatsColumn,
  context: ComparisonProjectStatsLabelContext,
) => {
  const raterLabel = getComparisonProjectStatsColumnRaterLabel(column, context)
  const promptLabel = column.promptId === summaryPromptId ? null : getColumnLabelPart(column.promptLabel)

  return promptLabel ? `${raterLabel} - ${promptLabel}` : raterLabel
}

export const getComparisonProjectStatsContentLabel = (column: ComparisonProjectStatsColumn) => {
  return getColumnLabelPart(column.contentLabel)
}

export const getComparisonProjectStatsHumanComparisonColumnInfo = (
  humanColumnInfo: string | null,
  llmColumnInfo: string | null,
) => {
  if (humanColumnInfo && llmColumnInfo && humanColumnInfo !== llmColumnInfo) {
    return `${llmColumnInfo} vs ${humanColumnInfo}`
  }

  return llmColumnInfo ?? humanColumnInfo
}
