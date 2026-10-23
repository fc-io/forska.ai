import type {
  ComparisonProjectStatsResolvedTruthComparison,
  ComparisonProjectStatsResolvedTruthComparisonGroup,
  ComparisonProjectStatsResolvedTruthCounts,
  ComparisonProjectStatsTruthConfusionMetrics,
  ComparisonProjectStatsTruthWinner,
} from './comparisonProjectStatsTypes.ts'
import {getRate} from './getRate.ts'

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

export const getComparisonProjectStatsResolvedTruthComparisonFromCounts = (
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
