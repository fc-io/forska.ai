import type {ComparisonProjectDifferenceColumn} from '../../../../utils/comparisonProjectDifferenceFilter.ts'

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
  | 'llm-vs-conflict-resolution-no-fallback'
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

export type ComparisonProjectStatsArticleCategory = 'chinese' | 'non_chinese'
export type ComparisonProjectStatsAnswerFilterKind = 'human' | 'llm'
export type ComparisonProjectStatsAnswerFilterValue = 'maybe' | 'no' | 'yes'

export type ComparisonProjectStatsConflictResolutionAnswerComparison = ComparisonProjectStatsComparison & {
  answerFilterKind: ComparisonProjectStatsAnswerFilterKind
  answerFilterLabel: string
  answerFilterValue: ComparisonProjectStatsAnswerFilterValue
  filterColumnId: string
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
  conflictResolutionAnswerComparisons: ComparisonProjectStatsConflictResolutionAnswerComparison[]
  resolvedTruthComparisons: ComparisonProjectStatsResolvedTruthComparison[]
}

export type ComparisonProjectStatsCategoryBreakdown = {
  additionalProjectStats: ComparisonProjectAdditionalStats
  articleCount: number
  category: ComparisonProjectStatsArticleCategory
  comparisons: ComparisonProjectStatsComparison[]
  label: string
}

export type ComparisonProjectStatsCellRow = {articleId: string; columnId: string; normalizedAnswers: unknown}

export type ComparisonProjectStatsConflictResolutionRow = {answerValue: unknown; articleId: string}

export type ComparisonProjectStatsAggregateRow = {
  agreementCount: unknown
  articleCategory?: unknown
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
  articleCategory?: unknown
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

export type ComparisonProjectStatsArticleCategoryCountRow = {articleCategory: unknown; articleCount: unknown}

export type ComparisonProjectStatsQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}

export type ComparisonProjectStatsConflictResolutionProvenance = 'all' | 'current'

export type ComparisonProjectStatsConflictResolutionProvenanceParams = {
  conflictResolutionProvenance?: ComparisonProjectStatsConflictResolutionProvenance
  currentJudgmentContextId?: string | null
}

export type ComparisonProjectStatsFromCellsParams = {
  allowConflictResolution?: boolean
  cellRows: readonly ComparisonProjectStatsCellRow[]
  columns: readonly ComparisonProjectStatsColumn[]
  conflictResolutionRows?: readonly ComparisonProjectStatsConflictResolutionRow[]
  isSummaryMode: boolean
  primaryModelId?: string | null
  primarySourceProjectId?: string | null
}

export type BinaryDecision = 'exclude' | 'include'

export type ComparisonProjectStatsNormalizedCell = {articleId: string; columnId: string; normalizedAnswers: string[]}
export type ComparisonProjectStatsPair = {articleId: string; leftAnswers: string[]; rightAnswers: string[]}
export type ComparisonProjectStatsLabelContext = {ambiguousLlmModelLabels: ReadonlySet<string>}
export type ComparisonProjectStatsResolvedTruthComparisonGroup = {
  columnInfo: string | null
  humanColumnId: string
  id: string
  label: string
  llmColumnId: string
}
export type ComparisonProjectStatsAggregateGroup = ComparisonProjectStatsComparisonGroup & {
  answerFilterValue?: ComparisonProjectStatsAnswerFilterValue
  filterAnswerValue?: ComparisonProjectStatsAnswerFilterValue
  filterColumnId?: string
}
export type ComparisonProjectStatsConflictResolutionAnswerComparisonGroup = ComparisonProjectStatsComparisonGroup & {
  answerFilterKind: ComparisonProjectStatsAnswerFilterKind
  answerFilterLabel: string
  answerFilterValue: ComparisonProjectStatsAnswerFilterValue
  filterColumnId: string
}

export type ComparisonProjectStatsAggregate = {
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

export type ComparisonProjectStatsResolvedTruthCounts = {
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
