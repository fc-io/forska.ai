import type {ComparisonProjectStatsResolvedTruthCounts} from './comparisonProjectStatsTypes.ts'

export const emptyComparisonProjectStatsResolvedTruthCounts = {
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
