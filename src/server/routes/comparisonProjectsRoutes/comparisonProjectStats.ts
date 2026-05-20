import type {ComparisonProjectDifferenceColumn} from '../../../utils/comparisonProjectDifferenceFilter.ts'
import {getJsonValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'

export type ComparisonProjectStatsColumn = ComparisonProjectDifferenceColumn & {
  contentLabel?: string | null
  modelId?: string | null
  modelLabel?: string | null
  promptLabel?: string | null
  sourceProjectId?: string | null
  sourceProjectName?: string | null
}

export type ComparisonProjectStatsComparisonKind =
  | 'primary-vs-human'
  | 'human-vs-llm'
  | 'llm-vs-llm'
  | 'llm-vs-conflict-resolution'
  | 'human-vs-conflict-resolution'

export type ComparisonProjectStatsComparisonGroup = {
  columnInfo: string | null
  id: string
  kind: ComparisonProjectStatsComparisonKind
  label: string
  leftColumnId: string
  rightColumnId: string
}

export type ComparisonProjectStatsComparison = ComparisonProjectStatsComparisonGroup & {
  cohensKappa: number | null
  conflictCount: number
  overlapCount: number
  sensitivity: number | null
  specificity: number | null
  trueConflictCount: number
}

export type ComparisonProjectStatsTruthWinner = 'Human' | 'LLM' | 'Tie'

export type ComparisonProjectStatsTruthConfusionMetrics = {
  accuracy: number | null
  balancedAccuracy: number | null
  f1: number | null
  falseNegativeCount: number
  falsePositiveCount: number
  negativePredictiveValue: number | null
  precision: number | null
  sensitivity: number | null
  specificity: number | null
  trueCorrectCount: number
  trueErrorCount: number
  trueNegativeCount: number
  truePositiveCount: number
  truthPrevalence: number | null
}

export type ComparisonProjectStatsResolvedTruthComparison = {
  bothCorrectCount: number
  bothWrongCount: number
  columnInfo: string | null
  humanColumnId: string
  humanCorrectVsTruthCount: number
  humanErrorsVsTruthCount: number
  humanMetrics: ComparisonProjectStatsTruthConfusionMetrics
  humanOnlyCorrectCount: number
  id: string
  label: string
  llmAdvantage: number
  llmColumnId: string
  llmCorrectVsTruthCount: number
  llmErrorsVsTruthCount: number
  llmMetrics: ComparisonProjectStatsTruthConfusionMetrics
  llmOnlyCorrectCount: number
  mcnemarChiSquare: number | null
  resolvedCount: number
  winner: ComparisonProjectStatsTruthWinner
}

export type ComparisonProjectAdditionalStats = {
  resolvedTruthComparisons: ComparisonProjectStatsResolvedTruthComparison[]
}

export type ComparisonProjectStatsCellRow = {articleId: string; columnId: string; normalizedAnswers: unknown}

export type ComparisonProjectStatsConflictResolutionRow = {answerValue: unknown; articleId: string}

export type ComparisonProjectStatsAggregateRow = {
  agreementCount: unknown
  binaryPairCount: unknown
  comparisonId: string
  conflictCount: unknown
  leftExcludeCount: unknown
  leftExcludeRightExcludeCount: unknown
  leftIncludeCount: unknown
  leftIncludeRightIncludeCount: unknown
  overlapCount: unknown
  rightExcludeCount: unknown
  rightIncludeCount: unknown
  trueConflictCount: unknown
}

export type ComparisonProjectStatsResolvedTruthAggregateRow = {
  bothCorrectCount: unknown
  bothWrongCount: unknown
  comparisonId: string
  humanCorrectVsTruthCount: unknown
  humanErrorsVsTruthCount: unknown
  humanFalseNegativeCount: unknown
  humanFalsePositiveCount: unknown
  humanOnlyCorrectCount: unknown
  humanTrueNegativeCount: unknown
  humanTruePositiveCount: unknown
  llmCorrectVsTruthCount: unknown
  llmErrorsVsTruthCount: unknown
  llmFalseNegativeCount: unknown
  llmFalsePositiveCount: unknown
  llmOnlyCorrectCount: unknown
  llmTrueNegativeCount: unknown
  llmTruePositiveCount: unknown
  resolvedCount: unknown
}

type ComparisonProjectStatsQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

type ComparisonProjectStatsParams = {
  allowConflictResolution?: boolean
  columns: readonly ComparisonProjectStatsColumn[]
  comparisonProjectId: string
  isSummaryMode: boolean
  primaryModelId?: string | null
  primarySourceProjectId?: string | null
  queryRunner: ComparisonProjectStatsQueryRunner
}

type ComparisonProjectStatsFromCellsParams = {
  allowConflictResolution?: boolean
  cellRows: readonly ComparisonProjectStatsCellRow[]
  columns: readonly ComparisonProjectStatsColumn[]
  conflictResolutionRows?: readonly ComparisonProjectStatsConflictResolutionRow[]
  isSummaryMode: boolean
  primaryModelId?: string | null
  primarySourceProjectId?: string | null
}

type BinaryDecision = 'exclude' | 'include'
type BinaryDecisionPair = {leftDecision: BinaryDecision; rightDecision: BinaryDecision}
type ComparisonProjectStatsNormalizedCell = {articleId: string; columnId: string; normalizedAnswers: string[]}
type ComparisonProjectStatsPair = {leftAnswers: string[]; rightAnswers: string[]}
type ComparisonProjectStatsLabelContext = {ambiguousLlmModelLabels: ReadonlySet<string>}
type ComparisonProjectStatsResolvedTruthComparisonGroup = {
  columnInfo: string | null
  humanColumnId: string
  id: string
  label: string
  llmColumnId: string
}
type ComparisonProjectStatsTruthDecision = {
  humanDecision: BinaryDecision
  llmDecision: BinaryDecision
  truthDecision: BinaryDecision
}

type ComparisonProjectStatsAggregate = {
  agreementCount: number
  binaryPairCount: number
  conflictCount: number
  leftExcludeCount: number
  leftExcludeRightExcludeCount: number
  leftIncludeCount: number
  leftIncludeRightIncludeCount: number
  overlapCount: number
  rightExcludeCount: number
  rightIncludeCount: number
  trueConflictCount: number
}

type ComparisonProjectStatsResolvedTruthCounts = {
  bothCorrectCount: number
  bothWrongCount: number
  humanCorrectVsTruthCount: number
  humanErrorsVsTruthCount: number
  humanFalseNegativeCount: number
  humanFalsePositiveCount: number
  humanOnlyCorrectCount: number
  humanTrueNegativeCount: number
  humanTruePositiveCount: number
  llmCorrectVsTruthCount: number
  llmErrorsVsTruthCount: number
  llmFalseNegativeCount: number
  llmFalsePositiveCount: number
  llmOnlyCorrectCount: number
  llmTrueNegativeCount: number
  llmTruePositiveCount: number
  resolvedCount: number
}

const summaryPromptId = 'summary'
const comparisonProjectConflictResolutionTable = 'app.comparison_project_conflict_resolution'

const getInClause = (values: readonly string[]) => {
  return getQuotedStringList([...values]).join(', ')
}

const getComparisonProjectStatsGenerationValue = (value: unknown) => {
  const parsedValue = typeof value === 'bigint' ? Number(value) : Number(value)

  return Number.isSafeInteger(parsedValue) && parsedValue > 0 ? parsedValue : null
}

const getComparisonProjectStatsCountValue = (value: unknown) => {
  const parsedValue = typeof value === 'bigint' ? Number(value) : Number(value)

  return Number.isSafeInteger(parsedValue) && parsedValue >= 0 ? parsedValue : 0
}

const getTrimmedLowercaseValue = (value: string) => {
  return value.trim().toLowerCase()
}

const getUniqueNormalizedAnswers = (answers: readonly string[]) => {
  return Array.from(
    new Set(
      answers.map(getTrimmedLowercaseValue).filter((answer) => {
        return answer !== ''
      }),
    ),
  )
}

const getNormalizedAnswerValues = (value: unknown) => {
  const jsonValue = getJsonValue(value)

  return Array.isArray(jsonValue)
    ? getUniqueNormalizedAnswers(
        jsonValue.filter((entry): entry is string => {
          return typeof entry === 'string'
        }),
      )
    : []
}

const getComparisonProjectStatsNormalizedCells = (rows: readonly ComparisonProjectStatsCellRow[]) => {
  return rows
    .map<ComparisonProjectStatsNormalizedCell>((row) => {
      return {...row, normalizedAnswers: getNormalizedAnswerValues(row.normalizedAnswers)}
    })
    .filter((row) => {
      return row.normalizedAnswers.length > 0
    })
}

const getComparisonProjectStatsCellsByColumn = (rows: readonly ComparisonProjectStatsCellRow[]) => {
  return getComparisonProjectStatsNormalizedCells(rows).reduce<
    Map<string, Map<string, ComparisonProjectStatsNormalizedCell>>
  >((columnMap, row) => {
    const articleMap = columnMap.get(row.columnId) ?? new Map<string, ComparisonProjectStatsNormalizedCell>()

    articleMap.set(row.articleId, row)
    columnMap.set(row.columnId, articleMap)
    return columnMap
  }, new Map<string, Map<string, ComparisonProjectStatsNormalizedCell>>())
}

const getComparisonProjectStatsConflictResolutionAnswersByArticleId = (
  rows: readonly ComparisonProjectStatsConflictResolutionRow[],
) => {
  return rows.reduce<Map<string, string[]>>((answerMap, row) => {
    const normalizedAnswers =
      typeof row.answerValue === 'string'
        ? getUniqueNormalizedAnswers([row.answerValue])
        : getNormalizedAnswerValues(row.answerValue)

    if (normalizedAnswers.length > 0) {
      answerMap.set(row.articleId, normalizedAnswers)
    }

    return answerMap
  }, new Map<string, string[]>())
}

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

const getComparisonProjectStatsLabelContext = (columns: readonly ComparisonProjectStatsColumn[]) => {
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

const getComparisonProjectStatsColumnLabel = (
  column: ComparisonProjectStatsColumn,
  context: ComparisonProjectStatsLabelContext,
) => {
  const raterLabel = getComparisonProjectStatsColumnRaterLabel(column, context)
  const promptLabel = column.promptId === summaryPromptId ? null : getColumnLabelPart(column.promptLabel)

  return promptLabel ? `${raterLabel} - ${promptLabel}` : raterLabel
}

const getIsComparisonProjectStatsHumanComparison = (kind: ComparisonProjectStatsComparisonKind) => {
  return (
    kind === 'primary-vs-human'
    || kind === 'human-vs-llm'
    || kind === 'llm-vs-conflict-resolution'
    || kind === 'human-vs-conflict-resolution'
  )
}

const getComparisonProjectStatsGroupLabel = (
  kind: ComparisonProjectStatsComparisonKind,
  leftColumn: ComparisonProjectStatsColumn,
  rightColumn: ComparisonProjectStatsColumn,
  context: ComparisonProjectStatsLabelContext,
) => {
  const leftColumnLabel = getComparisonProjectStatsColumnLabel(leftColumn, context)
  const rightColumnLabel = getComparisonProjectStatsColumnLabel(rightColumn, context)

  if (kind === 'llm-vs-conflict-resolution') {
    return `${rightColumnLabel} vs After conflict resolution (post-resolution fallback)`
  }

  if (kind === 'human-vs-conflict-resolution') {
    return `${leftColumnLabel} vs After conflict resolution (resolved only)`
  }

  return getIsComparisonProjectStatsHumanComparison(kind)
    ? `${rightColumnLabel} vs ${leftColumnLabel}`
    : `${leftColumnLabel} vs ${rightColumnLabel}`
}

const getComparisonProjectStatsContentLabel = (column: ComparisonProjectStatsColumn) => {
  return getColumnLabelPart(column.contentLabel)
}

const getComparisonProjectStatsLlmVsLlmColumnInfo = (leftColumnInfo: string | null, rightColumnInfo: string | null) => {
  if (leftColumnInfo && rightColumnInfo && leftColumnInfo !== rightColumnInfo) {
    return `${leftColumnInfo} vs ${rightColumnInfo}`
  }

  return leftColumnInfo ?? rightColumnInfo
}

const getComparisonProjectStatsHumanComparisonColumnInfo = (
  humanColumnInfo: string | null,
  llmColumnInfo: string | null,
) => {
  if (humanColumnInfo && llmColumnInfo && humanColumnInfo !== llmColumnInfo) {
    return `${llmColumnInfo} vs ${humanColumnInfo}`
  }

  return llmColumnInfo ?? humanColumnInfo
}

const getComparisonProjectStatsGroupColumnInfo = (
  kind: ComparisonProjectStatsComparisonKind,
  leftColumn: ComparisonProjectStatsColumn,
  rightColumn: ComparisonProjectStatsColumn,
) => {
  const leftColumnInfo = getComparisonProjectStatsContentLabel(leftColumn)
  const rightColumnInfo = getComparisonProjectStatsContentLabel(rightColumn)

  return getIsComparisonProjectStatsHumanComparison(kind)
    ? getComparisonProjectStatsHumanComparisonColumnInfo(leftColumnInfo, rightColumnInfo)
    : getComparisonProjectStatsLlmVsLlmColumnInfo(leftColumnInfo, rightColumnInfo)
}

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

const getComparisonProjectStatsGroup = (
  kind: ComparisonProjectStatsComparisonKind,
  leftColumn: ComparisonProjectStatsColumn,
  rightColumn: ComparisonProjectStatsColumn,
  context: ComparisonProjectStatsLabelContext,
): ComparisonProjectStatsComparisonGroup => {
  return {
    columnInfo: getComparisonProjectStatsGroupColumnInfo(kind, leftColumn, rightColumn),
    id: `${kind}:${leftColumn.id}:${rightColumn.id}`,
    kind,
    label: getComparisonProjectStatsGroupLabel(kind, leftColumn, rightColumn, context),
    leftColumnId: leftColumn.id,
    rightColumnId: rightColumn.id,
  }
}

const getShouldIncludeConflictResolutionStatsGroups = (params: {
  allowConflictResolution?: boolean
  isSummaryMode?: boolean
}) => {
  return Boolean(params.allowConflictResolution && params.isSummaryMode)
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
      ? getHumanVsConflictResolutionComparisonProjectStatsGroups(humanColumns, labelContext)
      : []),
    ...getLlmVsLlmComparisonProjectStatsGroups(llmColumns, labelContext),
  ]
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

const getComparisonProjectStatsColumnIds = (groups: readonly ComparisonProjectStatsComparisonGroup[]) => {
  return Array.from(
    new Set(
      groups.flatMap((group) => {
        return [group.leftColumnId, group.rightColumnId]
      }),
    ),
  )
}

const getComparisonProjectStatsGroupValuesSql = (groups: readonly ComparisonProjectStatsComparisonGroup[]) => {
  return groups
    .map((group) => {
      return `(${getSqlLiteral(group.id)}, ${getSqlLiteral(group.kind)}, ${getSqlLiteral(group.leftColumnId)}, ${getSqlLiteral(group.rightColumnId)})`
    })
    .join(',\n      ')
}

const getComparisonProjectStatsResolvedTruthColumnIds = (
  groups: readonly ComparisonProjectStatsResolvedTruthComparisonGroup[],
) => {
  return Array.from(
    new Set(
      groups.flatMap((group) => {
        return [group.humanColumnId, group.llmColumnId]
      }),
    ),
  )
}

const getComparisonProjectStatsResolvedTruthGroupValuesSql = (
  groups: readonly ComparisonProjectStatsResolvedTruthComparisonGroup[],
) => {
  return groups
    .map((group) => {
      return `(${getSqlLiteral(group.id)}, ${getSqlLiteral(group.humanColumnId)}, ${getSqlLiteral(group.llmColumnId)})`
    })
    .join(',\n      ')
}

const getAnswerUnionSize = (leftAnswers: readonly string[], rightAnswers: readonly string[]) => {
  return new Set([...leftAnswers, ...rightAnswers]).size
}

const getBinaryDecision = (answer: string): BinaryDecision | null => {
  return answer === 'yes' || answer === 'maybe' ? 'include' : answer === 'no' ? 'exclude' : null
}

const getBinaryDecisionSet = (answers: readonly string[]) => {
  return new Set(
    answers.map(getBinaryDecision).filter((decision): decision is BinaryDecision => {
      return decision !== null
    }),
  )
}

const getBinaryDecisionValue = (answers: readonly string[]) => {
  const decisions = Array.from(getBinaryDecisionSet(answers))

  return decisions.length === 1 ? (decisions[0] ?? null) : null
}

const getHasOneValidBinaryDecision = (answers: readonly string[]) => {
  return (
    answers.length > 0
    && answers.every((answer) => {
      return getBinaryDecision(answer) !== null
    })
    && getBinaryDecisionValue(answers) !== null
  )
}

const getHasConflict = (pair: ComparisonProjectStatsPair) => {
  return getAnswerUnionSize(pair.leftAnswers, pair.rightAnswers) > 1
}

const getHasTrueConflict = (pair: ComparisonProjectStatsPair) => {
  const leftDecisions = getBinaryDecisionSet(pair.leftAnswers)
  const rightDecisions = getBinaryDecisionSet(pair.rightAnswers)

  return leftDecisions.size > 0 && rightDecisions.size > 0 && new Set([...leftDecisions, ...rightDecisions]).size > 1
}

const getComparisonProjectStatsLeftAnswers = (
  group: ComparisonProjectStatsComparisonGroup,
  articleId: string,
  leftCell: ComparisonProjectStatsNormalizedCell,
  conflictResolutionAnswersByArticleId: Map<string, string[]>,
) => {
  return group.kind === 'llm-vs-conflict-resolution'
    ? (conflictResolutionAnswersByArticleId.get(articleId) ?? leftCell.normalizedAnswers)
    : leftCell.normalizedAnswers
}

const getComparisonProjectStatsResolvedHumanPair = (
  articleId: string,
  humanCell: ComparisonProjectStatsNormalizedCell,
  conflictResolutionAnswersByArticleId: Map<string, string[]>,
) => {
  const conflictResolutionAnswers = conflictResolutionAnswersByArticleId.get(articleId) ?? []
  const humanAnswers = humanCell.normalizedAnswers

  return getHasOneValidBinaryDecision(conflictResolutionAnswers) && getHasOneValidBinaryDecision(humanAnswers)
    ? {leftAnswers: conflictResolutionAnswers, rightAnswers: humanAnswers}
    : null
}

const getComparisonProjectStatsPair = (params: {
  articleId: string
  conflictResolutionAnswersByArticleId: Map<string, string[]>
  group: ComparisonProjectStatsComparisonGroup
  leftCell: ComparisonProjectStatsNormalizedCell
  rightCell: ComparisonProjectStatsNormalizedCell | undefined
}) => {
  if (!params.rightCell) {
    return null
  }

  return params.group.kind === 'human-vs-conflict-resolution'
    ? getComparisonProjectStatsResolvedHumanPair(
        params.articleId,
        params.rightCell,
        params.conflictResolutionAnswersByArticleId,
      )
    : {
        leftAnswers: getComparisonProjectStatsLeftAnswers(
          params.group,
          params.articleId,
          params.leftCell,
          params.conflictResolutionAnswersByArticleId,
        ),
        rightAnswers: params.rightCell.normalizedAnswers,
      }
}

const getComparisonProjectStatsPairs = (
  group: ComparisonProjectStatsComparisonGroup,
  cellsByColumn: Map<string, Map<string, ComparisonProjectStatsNormalizedCell>>,
  conflictResolutionAnswersByArticleId: Map<string, string[]>,
) => {
  const leftCellsByArticle =
    cellsByColumn.get(group.leftColumnId) ?? new Map<string, ComparisonProjectStatsNormalizedCell>()
  const rightCellsByArticle =
    cellsByColumn.get(group.rightColumnId) ?? new Map<string, ComparisonProjectStatsNormalizedCell>()

  return Array.from(leftCellsByArticle.entries())
    .map<ComparisonProjectStatsPair | null>(([articleId, leftCell]) => {
      const rightCell = rightCellsByArticle.get(articleId)

      return getComparisonProjectStatsPair({
        articleId,
        conflictResolutionAnswersByArticleId,
        group,
        leftCell,
        rightCell,
      })
    })
    .filter((pair): pair is ComparisonProjectStatsPair => {
      return pair !== null
    })
}

const getDecisionCount = (pairs: readonly BinaryDecisionPair[], side: keyof BinaryDecisionPair) => {
  return pairs.reduce(
    (counts, pair) => {
      const decision = pair[side]

      return decision === 'include'
        ? {...counts, include: counts.include + 1}
        : decision === 'exclude'
          ? {...counts, exclude: counts.exclude + 1}
          : counts
    },
    {exclude: 0, include: 0},
  )
}

const getRate = (numerator: number, denominator: number) => {
  return denominator === 0 ? null : numerator / denominator
}

const getValidBinaryDecisionValue = (answers: readonly string[]) => {
  return getHasOneValidBinaryDecision(answers) ? getBinaryDecisionValue(answers) : null
}

const getComparisonProjectStatsTruthConfusionMetrics = (params: {
  falseNegativeCount: number
  falsePositiveCount: number
  trueNegativeCount: number
  truePositiveCount: number
}): ComparisonProjectStatsTruthConfusionMetrics => {
  const trueCorrectCount = params.truePositiveCount + params.trueNegativeCount
  const trueErrorCount = params.falsePositiveCount + params.falseNegativeCount
  const resolvedCount = trueCorrectCount + trueErrorCount
  const sensitivity = getRate(params.truePositiveCount, params.truePositiveCount + params.falseNegativeCount)
  const specificity = getRate(params.trueNegativeCount, params.trueNegativeCount + params.falsePositiveCount)
  const balancedAccuracy = sensitivity === null || specificity === null ? null : (sensitivity + specificity) / 2

  return {
    accuracy: getRate(trueCorrectCount, resolvedCount),
    balancedAccuracy,
    f1: getRate(
      2 * params.truePositiveCount,
      2 * params.truePositiveCount + params.falsePositiveCount + params.falseNegativeCount,
    ),
    falseNegativeCount: params.falseNegativeCount,
    falsePositiveCount: params.falsePositiveCount,
    negativePredictiveValue: getRate(params.trueNegativeCount, params.trueNegativeCount + params.falseNegativeCount),
    precision: getRate(params.truePositiveCount, params.truePositiveCount + params.falsePositiveCount),
    sensitivity,
    specificity,
    trueCorrectCount,
    trueErrorCount,
    trueNegativeCount: params.trueNegativeCount,
    truePositiveCount: params.truePositiveCount,
    truthPrevalence: getRate(params.truePositiveCount + params.falseNegativeCount, resolvedCount),
  }
}

const getComparisonProjectStatsTruthWinner = (
  humanCorrectVsTruthCount: number,
  llmCorrectVsTruthCount: number,
): ComparisonProjectStatsTruthWinner => {
  return llmCorrectVsTruthCount > humanCorrectVsTruthCount
    ? 'LLM'
    : humanCorrectVsTruthCount > llmCorrectVsTruthCount
      ? 'Human'
      : 'Tie'
}

const getMcnemarChiSquare = (llmOnlyCorrectCount: number, humanOnlyCorrectCount: number) => {
  const denominator = llmOnlyCorrectCount + humanOnlyCorrectCount

  return denominator === 0 ? null : (Math.abs(llmOnlyCorrectCount - humanOnlyCorrectCount) - 1) ** 2 / denominator
}

const emptyComparisonProjectStatsResolvedTruthCounts = {
  bothCorrectCount: 0,
  bothWrongCount: 0,
  humanCorrectVsTruthCount: 0,
  humanErrorsVsTruthCount: 0,
  humanFalseNegativeCount: 0,
  humanFalsePositiveCount: 0,
  humanOnlyCorrectCount: 0,
  humanTrueNegativeCount: 0,
  humanTruePositiveCount: 0,
  llmCorrectVsTruthCount: 0,
  llmErrorsVsTruthCount: 0,
  llmFalseNegativeCount: 0,
  llmFalsePositiveCount: 0,
  llmOnlyCorrectCount: 0,
  llmTrueNegativeCount: 0,
  llmTruePositiveCount: 0,
  resolvedCount: 0,
} satisfies ComparisonProjectStatsResolvedTruthCounts

const getComparisonProjectStatsResolvedTruthCounts = (
  decisions: readonly ComparisonProjectStatsTruthDecision[],
): ComparisonProjectStatsResolvedTruthCounts => {
  return decisions.reduce<ComparisonProjectStatsResolvedTruthCounts>((counts, decision) => {
    const humanCorrect = decision.humanDecision === decision.truthDecision
    const llmCorrect = decision.llmDecision === decision.truthDecision

    return {
      bothCorrectCount: counts.bothCorrectCount + (humanCorrect && llmCorrect ? 1 : 0),
      bothWrongCount: counts.bothWrongCount + (!humanCorrect && !llmCorrect ? 1 : 0),
      humanCorrectVsTruthCount: counts.humanCorrectVsTruthCount + (humanCorrect ? 1 : 0),
      humanErrorsVsTruthCount: counts.humanErrorsVsTruthCount + (humanCorrect ? 0 : 1),
      humanFalseNegativeCount:
        counts.humanFalseNegativeCount
        + (decision.truthDecision === 'include' && decision.humanDecision === 'exclude' ? 1 : 0),
      humanFalsePositiveCount:
        counts.humanFalsePositiveCount
        + (decision.truthDecision === 'exclude' && decision.humanDecision === 'include' ? 1 : 0),
      humanOnlyCorrectCount: counts.humanOnlyCorrectCount + (humanCorrect && !llmCorrect ? 1 : 0),
      humanTrueNegativeCount:
        counts.humanTrueNegativeCount
        + (decision.truthDecision === 'exclude' && decision.humanDecision === 'exclude' ? 1 : 0),
      humanTruePositiveCount:
        counts.humanTruePositiveCount
        + (decision.truthDecision === 'include' && decision.humanDecision === 'include' ? 1 : 0),
      llmCorrectVsTruthCount: counts.llmCorrectVsTruthCount + (llmCorrect ? 1 : 0),
      llmErrorsVsTruthCount: counts.llmErrorsVsTruthCount + (llmCorrect ? 0 : 1),
      llmFalseNegativeCount:
        counts.llmFalseNegativeCount
        + (decision.truthDecision === 'include' && decision.llmDecision === 'exclude' ? 1 : 0),
      llmFalsePositiveCount:
        counts.llmFalsePositiveCount
        + (decision.truthDecision === 'exclude' && decision.llmDecision === 'include' ? 1 : 0),
      llmOnlyCorrectCount: counts.llmOnlyCorrectCount + (llmCorrect && !humanCorrect ? 1 : 0),
      llmTrueNegativeCount:
        counts.llmTrueNegativeCount
        + (decision.truthDecision === 'exclude' && decision.llmDecision === 'exclude' ? 1 : 0),
      llmTruePositiveCount:
        counts.llmTruePositiveCount
        + (decision.truthDecision === 'include' && decision.llmDecision === 'include' ? 1 : 0),
      resolvedCount: counts.resolvedCount + 1,
    }
  }, emptyComparisonProjectStatsResolvedTruthCounts)
}

const getComparisonProjectStatsResolvedTruthComparisonFromCounts = (
  group: ComparisonProjectStatsResolvedTruthComparisonGroup,
  counts: ComparisonProjectStatsResolvedTruthCounts,
): ComparisonProjectStatsResolvedTruthComparison => {
  return {
    ...group,
    bothCorrectCount: counts.bothCorrectCount,
    bothWrongCount: counts.bothWrongCount,
    humanCorrectVsTruthCount: counts.humanCorrectVsTruthCount,
    humanErrorsVsTruthCount: counts.humanErrorsVsTruthCount,
    humanMetrics: getComparisonProjectStatsTruthConfusionMetrics({
      falseNegativeCount: counts.humanFalseNegativeCount,
      falsePositiveCount: counts.humanFalsePositiveCount,
      trueNegativeCount: counts.humanTrueNegativeCount,
      truePositiveCount: counts.humanTruePositiveCount,
    }),
    humanOnlyCorrectCount: counts.humanOnlyCorrectCount,
    llmAdvantage: counts.llmOnlyCorrectCount - counts.humanOnlyCorrectCount,
    llmCorrectVsTruthCount: counts.llmCorrectVsTruthCount,
    llmErrorsVsTruthCount: counts.llmErrorsVsTruthCount,
    llmMetrics: getComparisonProjectStatsTruthConfusionMetrics({
      falseNegativeCount: counts.llmFalseNegativeCount,
      falsePositiveCount: counts.llmFalsePositiveCount,
      trueNegativeCount: counts.llmTrueNegativeCount,
      truePositiveCount: counts.llmTruePositiveCount,
    }),
    llmOnlyCorrectCount: counts.llmOnlyCorrectCount,
    mcnemarChiSquare: getMcnemarChiSquare(counts.llmOnlyCorrectCount, counts.humanOnlyCorrectCount),
    resolvedCount: counts.resolvedCount,
    winner: getComparisonProjectStatsTruthWinner(counts.humanCorrectVsTruthCount, counts.llmCorrectVsTruthCount),
  }
}

const getComparisonProjectStatsResolvedTruthDecision = (params: {
  conflictResolutionAnswersByArticleId: Map<string, string[]>
  humanCell: ComparisonProjectStatsNormalizedCell
  llmCell: ComparisonProjectStatsNormalizedCell
}) => {
  const truthDecision = getValidBinaryDecisionValue(
    params.conflictResolutionAnswersByArticleId.get(params.humanCell.articleId) ?? [],
  )
  const humanDecision = getValidBinaryDecisionValue(params.humanCell.normalizedAnswers)
  const llmDecision = getValidBinaryDecisionValue(params.llmCell.normalizedAnswers)

  return truthDecision && humanDecision && llmDecision ? {humanDecision, llmDecision, truthDecision} : null
}

const getComparisonProjectStatsResolvedTruthDecisions = (
  group: ComparisonProjectStatsResolvedTruthComparisonGroup,
  cellsByColumn: Map<string, Map<string, ComparisonProjectStatsNormalizedCell>>,
  conflictResolutionAnswersByArticleId: Map<string, string[]>,
) => {
  const humanCellsByArticle =
    cellsByColumn.get(group.humanColumnId) ?? new Map<string, ComparisonProjectStatsNormalizedCell>()
  const llmCellsByArticle =
    cellsByColumn.get(group.llmColumnId) ?? new Map<string, ComparisonProjectStatsNormalizedCell>()

  return Array.from(humanCellsByArticle.values())
    .map<ComparisonProjectStatsTruthDecision | null>((humanCell) => {
      const llmCell = llmCellsByArticle.get(humanCell.articleId)

      return llmCell
        ? getComparisonProjectStatsResolvedTruthDecision({conflictResolutionAnswersByArticleId, humanCell, llmCell})
        : null
    })
    .filter((decision): decision is ComparisonProjectStatsTruthDecision => {
      return decision !== null
    })
}

const getComparisonProjectStatsResolvedTruthComparison = (params: {
  cellsByColumn: Map<string, Map<string, ComparisonProjectStatsNormalizedCell>>
  conflictResolutionAnswersByArticleId: Map<string, string[]>
  group: ComparisonProjectStatsResolvedTruthComparisonGroup
}) => {
  const decisions = getComparisonProjectStatsResolvedTruthDecisions(
    params.group,
    params.cellsByColumn,
    params.conflictResolutionAnswersByArticleId,
  )

  return getComparisonProjectStatsResolvedTruthComparisonFromCounts(
    params.group,
    getComparisonProjectStatsResolvedTruthCounts(decisions),
  )
}

const getBinaryDecisionPairs = (pairs: readonly ComparisonProjectStatsPair[]) => {
  return pairs
    .map<BinaryDecisionPair | null>((pair) => {
      const leftDecision = getBinaryDecisionValue(pair.leftAnswers)
      const rightDecision = getBinaryDecisionValue(pair.rightAnswers)

      return leftDecision && rightDecision ? {leftDecision, rightDecision} : null
    })
    .filter((pair): pair is BinaryDecisionPair => {
      return pair !== null
    })
}

const getCohensKappa = (pairs: readonly ComparisonProjectStatsPair[]) => {
  const binaryPairs = getBinaryDecisionPairs(pairs)
  const pairCount = binaryPairs.length

  if (pairCount === 0) {
    return null
  }

  const agreementCount = binaryPairs.filter((pair) => {
    return pair.leftDecision === pair.rightDecision
  }).length
  const leftCounts = getDecisionCount(binaryPairs, 'leftDecision')
  const rightCounts = getDecisionCount(binaryPairs, 'rightDecision')
  const observedAgreement = agreementCount / pairCount
  const expectedAgreement =
    (leftCounts.include / pairCount) * (rightCounts.include / pairCount)
    + (leftCounts.exclude / pairCount) * (rightCounts.exclude / pairCount)
  const denominator = 1 - expectedAgreement

  return denominator === 0
    ? observedAgreement === 1
      ? 1
      : null
    : (observedAgreement - expectedAgreement) / denominator
}

const getBinaryDecisionOutcomeRate = (
  pairs: readonly ComparisonProjectStatsPair[],
  referenceDecision: BinaryDecision,
) => {
  const referencePairs = getBinaryDecisionPairs(pairs).filter((pair) => {
    return pair.leftDecision === referenceDecision
  })
  const matchingPredictionCount = referencePairs.filter((pair) => {
    return pair.rightDecision === referenceDecision
  }).length

  return getRate(matchingPredictionCount, referencePairs.length)
}

const getSensitivity = (kind: ComparisonProjectStatsComparisonKind, pairs: readonly ComparisonProjectStatsPair[]) => {
  return getIsComparisonProjectStatsHumanComparison(kind) ? getBinaryDecisionOutcomeRate(pairs, 'include') : null
}

const getSpecificity = (kind: ComparisonProjectStatsComparisonKind, pairs: readonly ComparisonProjectStatsPair[]) => {
  return getIsComparisonProjectStatsHumanComparison(kind) ? getBinaryDecisionOutcomeRate(pairs, 'exclude') : null
}

const getCohensKappaFromAggregate = (aggregate: ComparisonProjectStatsAggregate) => {
  const pairCount = aggregate.binaryPairCount

  if (pairCount === 0) {
    return null
  }

  const observedAgreement = aggregate.agreementCount / pairCount
  const expectedAgreement =
    (aggregate.leftIncludeCount / pairCount) * (aggregate.rightIncludeCount / pairCount)
    + (aggregate.leftExcludeCount / pairCount) * (aggregate.rightExcludeCount / pairCount)
  const denominator = 1 - expectedAgreement

  return denominator === 0
    ? observedAgreement === 1
      ? 1
      : null
    : (observedAgreement - expectedAgreement) / denominator
}

const getSensitivityFromAggregate = (
  kind: ComparisonProjectStatsComparisonKind,
  aggregate: ComparisonProjectStatsAggregate,
) => {
  return getIsComparisonProjectStatsHumanComparison(kind)
    ? getRate(aggregate.leftIncludeRightIncludeCount, aggregate.leftIncludeCount)
    : null
}

const getSpecificityFromAggregate = (
  kind: ComparisonProjectStatsComparisonKind,
  aggregate: ComparisonProjectStatsAggregate,
) => {
  return getIsComparisonProjectStatsHumanComparison(kind)
    ? getRate(aggregate.leftExcludeRightExcludeCount, aggregate.leftExcludeCount)
    : null
}

const getShouldComputeCohensKappa = (params: {
  columns: readonly ComparisonProjectStatsColumn[]
  isSummaryMode: boolean
}) => {
  const summaryColumnCount = params.columns.filter((column) => {
    return column.promptId === summaryPromptId
  }).length

  return params.isSummaryMode && summaryColumnCount === 2
}

const getComparisonProjectStatsComparison = (params: {
  cellsByColumn: Map<string, Map<string, ComparisonProjectStatsNormalizedCell>>
  conflictResolutionAnswersByArticleId: Map<string, string[]>
  group: ComparisonProjectStatsComparisonGroup
  shouldComputeCohensKappa: boolean
}) => {
  const pairs = getComparisonProjectStatsPairs(
    params.group,
    params.cellsByColumn,
    params.conflictResolutionAnswersByArticleId,
  )
  const conflictCount = pairs.filter(getHasConflict).length
  const trueConflictCount = pairs.filter(getHasTrueConflict).length

  return {
    ...params.group,
    cohensKappa: params.shouldComputeCohensKappa ? getCohensKappa(pairs) : null,
    conflictCount,
    overlapCount: pairs.length,
    sensitivity: getSensitivity(params.group.kind, pairs),
    specificity: getSpecificity(params.group.kind, pairs),
    trueConflictCount,
  }
}

export const getComparisonProjectStatsFromCells = (params: ComparisonProjectStatsFromCellsParams) => {
  const groups = getComparisonProjectStatsComparisonGroups(params)
  const cellsByColumn = getComparisonProjectStatsCellsByColumn(params.cellRows)
  const conflictResolutionAnswersByArticleId = getComparisonProjectStatsConflictResolutionAnswersByArticleId(
    params.conflictResolutionRows ?? [],
  )
  const shouldComputeCohensKappa = getShouldComputeCohensKappa(params)

  return groups.map((group) => {
    return getComparisonProjectStatsComparison({
      cellsByColumn,
      conflictResolutionAnswersByArticleId,
      group,
      shouldComputeCohensKappa,
    })
  })
}

export const getComparisonProjectAdditionalStatsFromCells = (
  params: ComparisonProjectStatsFromCellsParams,
): ComparisonProjectAdditionalStats => {
  const groups = getComparisonProjectAdditionalStatsGroups(params)
  const cellsByColumn = getComparisonProjectStatsCellsByColumn(params.cellRows)
  const conflictResolutionAnswersByArticleId = getComparisonProjectStatsConflictResolutionAnswersByArticleId(
    params.conflictResolutionRows ?? [],
  )

  return {
    resolvedTruthComparisons: groups.map((group) => {
      return getComparisonProjectStatsResolvedTruthComparison({
        cellsByColumn,
        conflictResolutionAnswersByArticleId,
        group,
      })
    }),
  }
}

const getComparisonProjectStatsAggregate = (
  row: ComparisonProjectStatsAggregateRow,
): ComparisonProjectStatsAggregate => {
  return {
    agreementCount: getComparisonProjectStatsCountValue(row.agreementCount),
    binaryPairCount: getComparisonProjectStatsCountValue(row.binaryPairCount),
    conflictCount: getComparisonProjectStatsCountValue(row.conflictCount),
    leftExcludeCount: getComparisonProjectStatsCountValue(row.leftExcludeCount),
    leftExcludeRightExcludeCount: getComparisonProjectStatsCountValue(row.leftExcludeRightExcludeCount),
    leftIncludeCount: getComparisonProjectStatsCountValue(row.leftIncludeCount),
    leftIncludeRightIncludeCount: getComparisonProjectStatsCountValue(row.leftIncludeRightIncludeCount),
    overlapCount: getComparisonProjectStatsCountValue(row.overlapCount),
    rightExcludeCount: getComparisonProjectStatsCountValue(row.rightExcludeCount),
    rightIncludeCount: getComparisonProjectStatsCountValue(row.rightIncludeCount),
    trueConflictCount: getComparisonProjectStatsCountValue(row.trueConflictCount),
  }
}

const emptyComparisonProjectStatsAggregate = {
  agreementCount: 0,
  binaryPairCount: 0,
  conflictCount: 0,
  leftExcludeCount: 0,
  leftExcludeRightExcludeCount: 0,
  leftIncludeCount: 0,
  leftIncludeRightIncludeCount: 0,
  overlapCount: 0,
  rightExcludeCount: 0,
  rightIncludeCount: 0,
  trueConflictCount: 0,
} satisfies ComparisonProjectStatsAggregate

const getComparisonProjectStatsResolvedTruthAggregate = (
  row: ComparisonProjectStatsResolvedTruthAggregateRow,
): ComparisonProjectStatsResolvedTruthCounts => {
  return {
    bothCorrectCount: getComparisonProjectStatsCountValue(row.bothCorrectCount),
    bothWrongCount: getComparisonProjectStatsCountValue(row.bothWrongCount),
    humanCorrectVsTruthCount: getComparisonProjectStatsCountValue(row.humanCorrectVsTruthCount),
    humanErrorsVsTruthCount: getComparisonProjectStatsCountValue(row.humanErrorsVsTruthCount),
    humanFalseNegativeCount: getComparisonProjectStatsCountValue(row.humanFalseNegativeCount),
    humanFalsePositiveCount: getComparisonProjectStatsCountValue(row.humanFalsePositiveCount),
    humanOnlyCorrectCount: getComparisonProjectStatsCountValue(row.humanOnlyCorrectCount),
    humanTrueNegativeCount: getComparisonProjectStatsCountValue(row.humanTrueNegativeCount),
    humanTruePositiveCount: getComparisonProjectStatsCountValue(row.humanTruePositiveCount),
    llmCorrectVsTruthCount: getComparisonProjectStatsCountValue(row.llmCorrectVsTruthCount),
    llmErrorsVsTruthCount: getComparisonProjectStatsCountValue(row.llmErrorsVsTruthCount),
    llmFalseNegativeCount: getComparisonProjectStatsCountValue(row.llmFalseNegativeCount),
    llmFalsePositiveCount: getComparisonProjectStatsCountValue(row.llmFalsePositiveCount),
    llmOnlyCorrectCount: getComparisonProjectStatsCountValue(row.llmOnlyCorrectCount),
    llmTrueNegativeCount: getComparisonProjectStatsCountValue(row.llmTrueNegativeCount),
    llmTruePositiveCount: getComparisonProjectStatsCountValue(row.llmTruePositiveCount),
    resolvedCount: getComparisonProjectStatsCountValue(row.resolvedCount),
  }
}

const getComparisonProjectStatsAggregatesByComparisonId = (rows: readonly ComparisonProjectStatsAggregateRow[]) => {
  return rows.reduce<Map<string, ComparisonProjectStatsAggregate>>((aggregateMap, row) => {
    aggregateMap.set(row.comparisonId, getComparisonProjectStatsAggregate(row))

    return aggregateMap
  }, new Map<string, ComparisonProjectStatsAggregate>())
}

const getComparisonProjectStatsResolvedTruthAggregatesByComparisonId = (
  rows: readonly ComparisonProjectStatsResolvedTruthAggregateRow[],
) => {
  return rows.reduce<Map<string, ComparisonProjectStatsResolvedTruthCounts>>((aggregateMap, row) => {
    aggregateMap.set(row.comparisonId, getComparisonProjectStatsResolvedTruthAggregate(row))

    return aggregateMap
  }, new Map<string, ComparisonProjectStatsResolvedTruthCounts>())
}

const getComparisonProjectStatsFromAggregates = (params: {
  aggregateRows: readonly ComparisonProjectStatsAggregateRow[]
  groups: readonly ComparisonProjectStatsComparisonGroup[]
  shouldComputeCohensKappa: boolean
}) => {
  const aggregatesByComparisonId = getComparisonProjectStatsAggregatesByComparisonId(params.aggregateRows)

  return params.groups.map((group) => {
    const aggregate = aggregatesByComparisonId.get(group.id) ?? emptyComparisonProjectStatsAggregate

    return {
      ...group,
      cohensKappa: params.shouldComputeCohensKappa ? getCohensKappaFromAggregate(aggregate) : null,
      conflictCount: aggregate.conflictCount,
      overlapCount: aggregate.overlapCount,
      sensitivity: getSensitivityFromAggregate(group.kind, aggregate),
      specificity: getSpecificityFromAggregate(group.kind, aggregate),
      trueConflictCount: aggregate.trueConflictCount,
    }
  })
}

const getComparisonProjectAdditionalStatsFromAggregates = (params: {
  aggregateRows: readonly ComparisonProjectStatsResolvedTruthAggregateRow[]
  groups: readonly ComparisonProjectStatsResolvedTruthComparisonGroup[]
}): ComparisonProjectAdditionalStats => {
  const aggregatesByComparisonId = getComparisonProjectStatsResolvedTruthAggregatesByComparisonId(params.aggregateRows)

  return {
    resolvedTruthComparisons: params.groups.map((group) => {
      return getComparisonProjectStatsResolvedTruthComparisonFromCounts(
        group,
        aggregatesByComparisonId.get(group.id) ?? emptyComparisonProjectStatsResolvedTruthCounts,
      )
    }),
  }
}

export const getComparisonProjectStatsActiveGenerationSql = (comparisonProjectId: string) => {
  return `
    SELECT CAST(active_generation AS INTEGER) AS generation
    FROM app.comparison_project_serving_generation
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      AND active_generation > 0
    LIMIT 1
  `
}

export const getComparisonProjectStatsAggregatesSql = (params: {
  columnIds: readonly string[]
  comparisonProjectId: string
  generation: number
  groups: readonly ComparisonProjectStatsComparisonGroup[]
}) => {
  return `
    WITH comparison_group(comparison_id, comparison_kind, left_column_id, right_column_id) AS (
      VALUES
      ${getComparisonProjectStatsGroupValuesSql(params.groups)}
    ),
    scoped_cell AS (
      SELECT
        cell.article_id,
        cell.column_id,
        cell.normalized_answers
      FROM mart.comparison_cell_serving cell
      WHERE cell.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND cell.generation = ${getSqlLiteral(params.generation)}
        AND cell.column_id IN (${getInClause(params.columnIds)})
        AND cell.normalized_answers IS NOT NULL
        AND ARRAY_LENGTH(cell.normalized_answers) > 0
    ),
    normalized_cell_answer AS (
      SELECT
        scoped_cell.article_id,
        scoped_cell.column_id,
        LOWER(TRIM(answer.answer_value)) AS answer_value,
        CASE
          WHEN LOWER(TRIM(answer.answer_value)) IN ('yes', 'maybe') THEN 'include'
          WHEN LOWER(TRIM(answer.answer_value)) = 'no' THEN 'exclude'
          ELSE NULL
        END AS binary_decision
      FROM scoped_cell,
        UNNEST(scoped_cell.normalized_answers) AS answer(answer_value)
      WHERE NULLIF(TRIM(answer.answer_value), '') IS NOT NULL
    ),
    normalized_cell AS (
      SELECT article_id, column_id
      FROM normalized_cell_answer
      GROUP BY article_id, column_id
    ),
    normalized_conflict_resolution_answer AS (
      SELECT
        article_id,
        LOWER(TRIM(answer_value)) AS answer_value,
        CASE
          WHEN LOWER(TRIM(answer_value)) IN ('yes', 'maybe') THEN 'include'
          WHEN LOWER(TRIM(answer_value)) = 'no' THEN 'exclude'
          ELSE NULL
        END AS binary_decision
      FROM ${comparisonProjectConflictResolutionTable}
      WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND answer_value IS NOT NULL
        AND NULLIF(TRIM(answer_value), '') IS NOT NULL
    ),
    comparison_pair AS (
      SELECT
        comparison_group.comparison_id,
        comparison_group.comparison_kind,
        comparison_group.left_column_id,
        comparison_group.right_column_id,
        left_cell.article_id
      FROM comparison_group
      INNER JOIN normalized_cell left_cell ON left_cell.column_id = comparison_group.left_column_id
      INNER JOIN normalized_cell right_cell
        ON right_cell.column_id = comparison_group.right_column_id
        AND right_cell.article_id = left_cell.article_id
    ),
    pair_answer_value AS (
      SELECT
        comparison_pair.comparison_id,
        comparison_pair.comparison_kind,
        comparison_pair.article_id,
        'left' AS answer_side,
        CASE
          WHEN comparison_pair.comparison_kind = 'human-vs-conflict-resolution' THEN conflict_resolution.answer_value
          WHEN comparison_pair.comparison_kind = 'llm-vs-conflict-resolution' THEN COALESCE(conflict_resolution.answer_value, normalized_cell_answer.answer_value)
          ELSE normalized_cell_answer.answer_value
        END AS answer_value,
        CASE
          WHEN comparison_pair.comparison_kind = 'human-vs-conflict-resolution' THEN conflict_resolution.binary_decision
          WHEN comparison_pair.comparison_kind = 'llm-vs-conflict-resolution' THEN
            CASE
              WHEN conflict_resolution.answer_value IS NOT NULL THEN conflict_resolution.binary_decision
              ELSE normalized_cell_answer.binary_decision
            END
          ELSE normalized_cell_answer.binary_decision
        END AS binary_decision
      FROM comparison_pair
      INNER JOIN normalized_cell_answer
        ON normalized_cell_answer.article_id = comparison_pair.article_id
        AND normalized_cell_answer.column_id = comparison_pair.left_column_id
      LEFT JOIN normalized_conflict_resolution_answer conflict_resolution
        ON conflict_resolution.article_id = comparison_pair.article_id
        AND comparison_pair.comparison_kind IN ('llm-vs-conflict-resolution', 'human-vs-conflict-resolution')
      UNION ALL
      SELECT
        comparison_pair.comparison_id,
        comparison_pair.comparison_kind,
        comparison_pair.article_id,
        'right' AS answer_side,
        normalized_cell_answer.answer_value,
        normalized_cell_answer.binary_decision
      FROM comparison_pair
      INNER JOIN normalized_cell_answer
        ON normalized_cell_answer.article_id = comparison_pair.article_id
        AND normalized_cell_answer.column_id = comparison_pair.right_column_id
    ),
    pair_stats AS (
      SELECT
        comparison_id,
        comparison_kind,
        article_id,
        COUNT(DISTINCT answer_value) AS answer_value_count,
        COUNT(DISTINCT answer_value) FILTER (
          WHERE answer_side = 'left' AND answer_value IS NOT NULL
        ) AS left_answer_value_count,
        COUNT(DISTINCT answer_value) FILTER (
          WHERE answer_side = 'right' AND answer_value IS NOT NULL
        ) AS right_answer_value_count,
        COUNT(DISTINCT answer_value) FILTER (
          WHERE answer_side = 'left' AND answer_value IS NOT NULL AND binary_decision IS NULL
        ) AS left_non_binary_answer_value_count,
        COUNT(DISTINCT answer_value) FILTER (
          WHERE answer_side = 'right' AND answer_value IS NOT NULL AND binary_decision IS NULL
        ) AS right_non_binary_answer_value_count,
        COUNT(DISTINCT binary_decision) FILTER (
          WHERE answer_side = 'left' AND binary_decision IS NOT NULL
        ) AS left_binary_decision_count,
        COUNT(DISTINCT binary_decision) FILTER (
          WHERE answer_side = 'right' AND binary_decision IS NOT NULL
        ) AS right_binary_decision_count,
        COUNT(DISTINCT binary_decision) FILTER (
          WHERE binary_decision IS NOT NULL
        ) AS all_binary_decision_count,
        MIN(binary_decision) FILTER (
          WHERE answer_side = 'left' AND binary_decision IS NOT NULL
        ) AS left_binary_decision,
        MIN(binary_decision) FILTER (
          WHERE answer_side = 'right' AND binary_decision IS NOT NULL
        ) AS right_binary_decision
      FROM pair_answer_value
      GROUP BY comparison_id, comparison_kind, article_id
    ),
    eligible_pair_stats AS (
      SELECT
        *,
        (
          comparison_kind <> 'human-vs-conflict-resolution'
          OR (
            left_answer_value_count > 0
            AND right_answer_value_count > 0
            AND left_binary_decision_count = 1
            AND right_binary_decision_count = 1
            AND left_non_binary_answer_value_count = 0
            AND right_non_binary_answer_value_count = 0
          )
        ) AS is_included_pair,
        (
          left_binary_decision_count = 1
          AND right_binary_decision_count = 1
          AND (
            comparison_kind <> 'human-vs-conflict-resolution'
            OR (
              left_non_binary_answer_value_count = 0
              AND right_non_binary_answer_value_count = 0
            )
          )
        ) AS is_binary_pair
      FROM pair_stats
    )
    SELECT
      comparison_id AS comparisonId,
      CAST(COUNT(*) FILTER (WHERE is_included_pair) AS INTEGER) AS overlapCount,
      CAST(SUM(CASE WHEN is_included_pair AND answer_value_count > 1 THEN 1 ELSE 0 END) AS INTEGER) AS conflictCount,
      CAST(SUM(CASE
        WHEN is_included_pair AND left_binary_decision_count > 0 AND right_binary_decision_count > 0 AND all_binary_decision_count > 1 THEN 1
        ELSE 0
      END) AS INTEGER) AS trueConflictCount,
      CAST(SUM(CASE WHEN is_binary_pair THEN 1 ELSE 0 END) AS INTEGER) AS binaryPairCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND left_binary_decision = right_binary_decision THEN 1
        ELSE 0
      END) AS INTEGER) AS agreementCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND left_binary_decision = 'include' THEN 1
        ELSE 0
      END) AS INTEGER) AS leftIncludeCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND left_binary_decision = 'include' AND right_binary_decision = 'include' THEN 1
        ELSE 0
      END) AS INTEGER) AS leftIncludeRightIncludeCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND left_binary_decision = 'exclude' THEN 1
        ELSE 0
      END) AS INTEGER) AS leftExcludeCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND left_binary_decision = 'exclude' AND right_binary_decision = 'exclude' THEN 1
        ELSE 0
      END) AS INTEGER) AS leftExcludeRightExcludeCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND right_binary_decision = 'include' THEN 1
        ELSE 0
      END) AS INTEGER) AS rightIncludeCount,
      CAST(SUM(CASE
        WHEN is_binary_pair AND right_binary_decision = 'exclude' THEN 1
        ELSE 0
      END) AS INTEGER) AS rightExcludeCount
    FROM eligible_pair_stats
    GROUP BY comparison_id
    ORDER BY comparison_id ASC
  `
}

export const getComparisonProjectStatsResolvedTruthAggregatesSql = (params: {
  columnIds: readonly string[]
  comparisonProjectId: string
  generation: number
  groups: readonly ComparisonProjectStatsResolvedTruthComparisonGroup[]
}) => {
  return `
    WITH resolved_truth_group(comparison_id, human_column_id, llm_column_id) AS (
      VALUES
      ${getComparisonProjectStatsResolvedTruthGroupValuesSql(params.groups)}
    ),
    scoped_cell AS (
      SELECT
        cell.article_id,
        cell.column_id,
        cell.normalized_answers
      FROM mart.comparison_cell_serving cell
      WHERE cell.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND cell.generation = ${getSqlLiteral(params.generation)}
        AND cell.column_id IN (${getInClause(params.columnIds)})
        AND cell.normalized_answers IS NOT NULL
        AND ARRAY_LENGTH(cell.normalized_answers) > 0
    ),
    normalized_cell_answer AS (
      SELECT
        scoped_cell.article_id,
        scoped_cell.column_id,
        LOWER(TRIM(answer.answer_value)) AS answer_value,
        CASE
          WHEN LOWER(TRIM(answer.answer_value)) IN ('yes', 'maybe') THEN 'include'
          WHEN LOWER(TRIM(answer.answer_value)) = 'no' THEN 'exclude'
          ELSE NULL
        END AS binary_decision
      FROM scoped_cell,
        UNNEST(scoped_cell.normalized_answers) AS answer(answer_value)
      WHERE NULLIF(TRIM(answer.answer_value), '') IS NOT NULL
    ),
    normalized_cell_decision AS (
      SELECT
        article_id,
        column_id,
        COUNT(DISTINCT binary_decision) FILTER (
          WHERE binary_decision IS NOT NULL
        ) AS binary_decision_count,
        COUNT(DISTINCT answer_value) FILTER (
          WHERE answer_value IS NOT NULL AND binary_decision IS NULL
        ) AS non_binary_answer_value_count,
        MIN(binary_decision) FILTER (
          WHERE binary_decision IS NOT NULL
        ) AS binary_decision
      FROM normalized_cell_answer
      GROUP BY article_id, column_id
    ),
    eligible_cell_decision AS (
      SELECT article_id, column_id, binary_decision
      FROM normalized_cell_decision
      WHERE binary_decision_count = 1
        AND non_binary_answer_value_count = 0
    ),
    normalized_conflict_resolution_answer AS (
      SELECT
        article_id,
        LOWER(TRIM(answer_value)) AS answer_value,
        CASE
          WHEN LOWER(TRIM(answer_value)) IN ('yes', 'maybe') THEN 'include'
          WHEN LOWER(TRIM(answer_value)) = 'no' THEN 'exclude'
          ELSE NULL
        END AS binary_decision
      FROM ${comparisonProjectConflictResolutionTable}
      WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND answer_value IS NOT NULL
        AND NULLIF(TRIM(answer_value), '') IS NOT NULL
    ),
    normalized_conflict_resolution_decision AS (
      SELECT
        article_id,
        COUNT(DISTINCT binary_decision) FILTER (
          WHERE binary_decision IS NOT NULL
        ) AS binary_decision_count,
        COUNT(DISTINCT answer_value) FILTER (
          WHERE answer_value IS NOT NULL AND binary_decision IS NULL
        ) AS non_binary_answer_value_count,
        MIN(binary_decision) FILTER (
          WHERE binary_decision IS NOT NULL
        ) AS binary_decision
      FROM normalized_conflict_resolution_answer
      GROUP BY article_id
    ),
    eligible_conflict_resolution_decision AS (
      SELECT article_id, binary_decision
      FROM normalized_conflict_resolution_decision
      WHERE binary_decision_count = 1
        AND non_binary_answer_value_count = 0
    ),
    comparison_decision AS (
      SELECT
        resolved_truth_group.comparison_id,
        truth_decision.binary_decision AS truth_decision,
        human_decision.binary_decision AS human_decision,
        llm_decision.binary_decision AS llm_decision
      FROM resolved_truth_group
      INNER JOIN eligible_cell_decision human_decision
        ON human_decision.column_id = resolved_truth_group.human_column_id
      INNER JOIN eligible_cell_decision llm_decision
        ON llm_decision.column_id = resolved_truth_group.llm_column_id
        AND llm_decision.article_id = human_decision.article_id
      INNER JOIN eligible_conflict_resolution_decision truth_decision
        ON truth_decision.article_id = human_decision.article_id
    )
    SELECT
      comparison_id AS comparisonId,
      CAST(COUNT(*) AS INTEGER) AS resolvedCount,
      CAST(SUM(CASE WHEN human_decision = truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS humanCorrectVsTruthCount,
      CAST(SUM(CASE WHEN human_decision <> truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS humanErrorsVsTruthCount,
      CAST(SUM(CASE WHEN llm_decision = truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS llmCorrectVsTruthCount,
      CAST(SUM(CASE WHEN llm_decision <> truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS llmErrorsVsTruthCount,
      CAST(SUM(CASE WHEN human_decision = truth_decision AND llm_decision = truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS bothCorrectCount,
      CAST(SUM(CASE WHEN human_decision <> truth_decision AND llm_decision <> truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS bothWrongCount,
      CAST(SUM(CASE WHEN human_decision = truth_decision AND llm_decision <> truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS humanOnlyCorrectCount,
      CAST(SUM(CASE WHEN llm_decision = truth_decision AND human_decision <> truth_decision THEN 1 ELSE 0 END) AS INTEGER) AS llmOnlyCorrectCount,
      CAST(SUM(CASE WHEN truth_decision = 'include' AND human_decision = 'include' THEN 1 ELSE 0 END) AS INTEGER) AS humanTruePositiveCount,
      CAST(SUM(CASE WHEN truth_decision = 'include' AND human_decision = 'exclude' THEN 1 ELSE 0 END) AS INTEGER) AS humanFalseNegativeCount,
      CAST(SUM(CASE WHEN truth_decision = 'exclude' AND human_decision = 'exclude' THEN 1 ELSE 0 END) AS INTEGER) AS humanTrueNegativeCount,
      CAST(SUM(CASE WHEN truth_decision = 'exclude' AND human_decision = 'include' THEN 1 ELSE 0 END) AS INTEGER) AS humanFalsePositiveCount,
      CAST(SUM(CASE WHEN truth_decision = 'include' AND llm_decision = 'include' THEN 1 ELSE 0 END) AS INTEGER) AS llmTruePositiveCount,
      CAST(SUM(CASE WHEN truth_decision = 'include' AND llm_decision = 'exclude' THEN 1 ELSE 0 END) AS INTEGER) AS llmFalseNegativeCount,
      CAST(SUM(CASE WHEN truth_decision = 'exclude' AND llm_decision = 'exclude' THEN 1 ELSE 0 END) AS INTEGER) AS llmTrueNegativeCount,
      CAST(SUM(CASE WHEN truth_decision = 'exclude' AND llm_decision = 'include' THEN 1 ELSE 0 END) AS INTEGER) AS llmFalsePositiveCount
    FROM comparison_decision
    GROUP BY comparison_id
    ORDER BY comparison_id ASC
  `
}

export const getComparisonProjectStats = async (params: ComparisonProjectStatsParams) => {
  const groups = getComparisonProjectStatsComparisonGroups(params)
  const columnIds = getComparisonProjectStatsColumnIds(groups)

  if (columnIds.length === 0) {
    return []
  }

  const [generationRow] = await params.queryRunner.queryJson<{generation: unknown}>(
    getComparisonProjectStatsActiveGenerationSql(params.comparisonProjectId),
  )
  const generation = getComparisonProjectStatsGenerationValue(generationRow?.generation)

  if (generation === null) {
    return []
  }

  const aggregateRows = await params.queryRunner.queryJson<ComparisonProjectStatsAggregateRow>(
    getComparisonProjectStatsAggregatesSql({
      columnIds,
      comparisonProjectId: params.comparisonProjectId,
      generation,
      groups,
    }),
  )
  const shouldComputeCohensKappa = getShouldComputeCohensKappa(params)

  return getComparisonProjectStatsFromAggregates({aggregateRows, groups, shouldComputeCohensKappa})
}

export const getComparisonProjectAdditionalStats = async (
  params: ComparisonProjectStatsParams,
): Promise<ComparisonProjectAdditionalStats> => {
  const groups = getComparisonProjectAdditionalStatsGroups(params)
  const columnIds = getComparisonProjectStatsResolvedTruthColumnIds(groups)

  if (columnIds.length === 0) {
    return {resolvedTruthComparisons: []}
  }

  const [generationRow] = await params.queryRunner.queryJson<{generation: unknown}>(
    getComparisonProjectStatsActiveGenerationSql(params.comparisonProjectId),
  )
  const generation = getComparisonProjectStatsGenerationValue(generationRow?.generation)

  if (generation === null) {
    return {resolvedTruthComparisons: []}
  }

  const aggregateRows = await params.queryRunner.queryJson<ComparisonProjectStatsResolvedTruthAggregateRow>(
    getComparisonProjectStatsResolvedTruthAggregatesSql({
      columnIds,
      comparisonProjectId: params.comparisonProjectId,
      generation,
      groups,
    }),
  )

  return getComparisonProjectAdditionalStatsFromAggregates({aggregateRows, groups})
}
