import {getSystemPromptVariant, type SystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import {getEffectiveFullTextStrategyId} from '../../../fullText/fullTextStrategy.ts'
import {deriveStrictSummaryAnswer, getNormalizedSummaryAnswer} from '../../../utils/judgmentAnswers.ts'
import {getComparisonProjectContentKey} from '../comparisonProjectJudgmentRows/getComparisonProjectContentKey.ts'
import {summaryPromptId} from '../comparisonProjectRouteConstants.ts'
import type {ComparisonProjectLlmRow} from '../comparisonProjectRouteTypes.ts'
import type {ComparisonProjectPromptConfig, ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'
import {isDefined} from '../comparisonProjectValueHelpers.ts'
import {getIsSummaryMode} from '../getIsSummaryMode.ts'

type ComparisonProjectSummaryPromptGroup = {
  modelId: string | null
  prompts: ComparisonProjectPromptConfig[]
  sourceProjectId: string | null
  systemPromptVariant: SystemPromptVariant | null
  useMetadata: boolean | null
  fullTextStrategyId: string | null
}

const getSummaryCriteria = (prompts: ComparisonProjectPromptConfig[]) => {
  return prompts.map((prompt) => {
    return {promptId: prompt.id, criteriaDisposition: prompt.criteriaDisposition}
  })
}

const getComparisonProjectSummaryPromptGroups = (
  scope: ComparisonProjectScope,
): ComparisonProjectSummaryPromptGroup[] => {
  if (!getIsSummaryMode(scope) || scope.useImportRoutesForScope) {
    return [
      {
        sourceProjectId: null,
        modelId: null,
        prompts: scope.prompts,
        systemPromptVariant: null,
        useMetadata: null,
        fullTextStrategyId: null,
      },
    ]
  }

  const promptRowsBySourceProjectId = scope.sourceProjectSummaryPrompts.reduce<
    Map<string, ComparisonProjectPromptConfig[]>
  >((rowMap, prompt) => {
    const currentPrompts = rowMap.get(prompt.sourceProjectId) ?? []
    rowMap.set(prompt.sourceProjectId, [...currentPrompts, prompt])
    return rowMap
  }, new Map<string, ComparisonProjectPromptConfig[]>())
  const sourceProjectGroups = scope.sourceProjects.reduce<ComparisonProjectSummaryPromptGroup[]>(
    (groups, sourceProject) => {
      const prompts = promptRowsBySourceProjectId.get(sourceProject.id) ?? []

      return prompts.length > 0
        ? [
            ...groups,
            {
              sourceProjectId: sourceProject.id,
              modelId: sourceProject.modelId,
              prompts,
              systemPromptVariant: sourceProject.systemPromptVariant,
              useMetadata: sourceProject.useMetadata,
              fullTextStrategyId: sourceProject.fullTextStrategyId,
            },
          ]
        : groups
    },
    [],
  )

  return sourceProjectGroups.length > 0
    ? sourceProjectGroups
    : [
        {
          sourceProjectId: null,
          modelId: null,
          prompts: scope.prompts,
          systemPromptVariant: null,
          useMetadata: null,
          fullTextStrategyId: null,
        },
      ]
}

const getComparisonProjectLlmRowsForSummaryGroup = (
  rows: ComparisonProjectLlmRow[],
  summaryPromptGroup: ComparisonProjectSummaryPromptGroup,
) => {
  const promptIds = new Set(
    summaryPromptGroup.prompts.map((prompt) => {
      return prompt.id
    }),
  )

  return rows.filter((row) => {
    return (
      promptIds.has(row.promptId)
      && (summaryPromptGroup.modelId === null || row.modelId === summaryPromptGroup.modelId)
      && (summaryPromptGroup.systemPromptVariant === null
        || getSystemPromptVariant(row.systemPromptVariant) === summaryPromptGroup.systemPromptVariant)
      && (summaryPromptGroup.useMetadata === null || (row.useMetadata === true) === summaryPromptGroup.useMetadata)
      && (summaryPromptGroup.fullTextStrategyId === null
        || getEffectiveFullTextStrategyId(row.fullTextStrategyId) === summaryPromptGroup.fullTextStrategyId)
    )
  })
}

const getComparisonProjectLlmSummaryRow = (
  rows: ComparisonProjectLlmRow[],
  summaryPromptGroup: ComparisonProjectSummaryPromptGroup,
) => {
  const groupRows = getComparisonProjectLlmRowsForSummaryGroup(rows, summaryPromptGroup)
  const [firstRow] = groupRows

  if (!firstRow) {
    return null
  }

  const normalizedAnswers = Array.from(getLatestComparisonProjectLlmRowsByPromptId(groupRows).values()).reduce<
    Record<string, 'yes' | 'no' | 'maybe' | null>
  >((answerMap, row) => {
    return {...answerMap, [row.promptId]: getNormalizedSummaryAnswer(row)}
  }, {})
  const summaryAnswer = deriveStrictSummaryAnswer(getSummaryCriteria(summaryPromptGroup.prompts), normalizedAnswers)

  return summaryAnswer
    ? {
        ...firstRow,
        promptId: summaryPromptId,
        sourceProjectId: summaryPromptGroup.sourceProjectId,
        answeredOriginal: summaryAnswer,
        answeredOriginalAsArray: null,
      }
    : null
}

const getLatestComparisonProjectLlmRowsByPromptId = (rows: ComparisonProjectLlmRow[]) => {
  return rows.reduce<Map<string, ComparisonProjectLlmRow>>((rowMap, row) => {
    const existingRow = rowMap.get(row.promptId)

    return !existingRow || row.createdAt.getTime() >= existingRow.createdAt.getTime()
      ? rowMap.set(row.promptId, row)
      : rowMap
  }, new Map<string, ComparisonProjectLlmRow>())
}

export const getComparisonProjectLlmSummaryRows = (scope: ComparisonProjectScope, rows: ComparisonProjectLlmRow[]) => {
  if (!getIsSummaryMode(scope)) {
    return rows
  }

  const summaryPromptGroups = getComparisonProjectSummaryPromptGroups(scope)

  const rowGroups = rows.reduce<Map<string, ComparisonProjectLlmRow[]>>((rowMap, row) => {
    const key = `${row.articleId}:${row.modelId}:${getComparisonProjectContentKey(row)}`
    const currentRows = rowMap.get(key) ?? []
    rowMap.set(key, [...currentRows, row])
    return rowMap
  }, new Map<string, ComparisonProjectLlmRow[]>())

  return Array.from(rowGroups.values())
    .flatMap((groupRows) => {
      return summaryPromptGroups.map((summaryPromptGroup) => {
        return getComparisonProjectLlmSummaryRow(groupRows, summaryPromptGroup)
      })
    })
    .filter(isDefined)
}
