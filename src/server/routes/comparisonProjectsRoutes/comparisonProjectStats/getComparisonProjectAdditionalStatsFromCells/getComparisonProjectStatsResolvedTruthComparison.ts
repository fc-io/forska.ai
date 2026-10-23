import {getValidBinaryDecisionValue} from '../comparisonProjectStatsBinaryDecision.ts'
import type {
  BinaryDecision,
  ComparisonProjectStatsNormalizedCell,
  ComparisonProjectStatsResolvedTruthComparisonGroup,
  ComparisonProjectStatsResolvedTruthCounts,
} from '../comparisonProjectStatsTypes.ts'
import {emptyComparisonProjectStatsResolvedTruthCounts} from '../emptyComparisonProjectStatsResolvedTruthCounts.ts'
import {getComparisonProjectStatsResolvedTruthComparisonFromCounts} from '../getComparisonProjectStatsResolvedTruthComparisonFromCounts.ts'

type ComparisonProjectStatsTruthDecision = {
  humanDecision: BinaryDecision
  llmDecision: BinaryDecision
  truthDecision: BinaryDecision
}

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

export const getComparisonProjectStatsResolvedTruthComparison = (params: {
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
