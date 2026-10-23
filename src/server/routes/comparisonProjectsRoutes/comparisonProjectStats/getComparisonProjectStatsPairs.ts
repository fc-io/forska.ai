import {getHasOneValidBinaryDecision} from './comparisonProjectStatsBinaryDecision.ts'
import {getIsComparisonProjectStatsNoFallbackConflictResolutionComparison} from './comparisonProjectStatsComparisonKind.ts'
import type {
  ComparisonProjectStatsComparisonGroup,
  ComparisonProjectStatsNormalizedCell,
  ComparisonProjectStatsPair,
} from './comparisonProjectStatsTypes.ts'

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

const getComparisonProjectStatsNoFallbackConflictResolutionPair = (
  articleId: string,
  rightCell: ComparisonProjectStatsNormalizedCell,
  conflictResolutionAnswersByArticleId: Map<string, string[]>,
) => {
  const conflictResolutionAnswers = conflictResolutionAnswersByArticleId.get(articleId) ?? []
  const rightAnswers = rightCell.normalizedAnswers

  return getHasOneValidBinaryDecision(conflictResolutionAnswers) && getHasOneValidBinaryDecision(rightAnswers)
    ? {articleId, leftAnswers: conflictResolutionAnswers, rightAnswers}
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

  return getIsComparisonProjectStatsNoFallbackConflictResolutionComparison(params.group.kind)
    ? getComparisonProjectStatsNoFallbackConflictResolutionPair(
        params.articleId,
        params.rightCell,
        params.conflictResolutionAnswersByArticleId,
      )
    : {
        articleId: params.articleId,
        leftAnswers: getComparisonProjectStatsLeftAnswers(
          params.group,
          params.articleId,
          params.leftCell,
          params.conflictResolutionAnswersByArticleId,
        ),
        rightAnswers: params.rightCell.normalizedAnswers,
      }
}

export const getComparisonProjectStatsPairs = (
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
