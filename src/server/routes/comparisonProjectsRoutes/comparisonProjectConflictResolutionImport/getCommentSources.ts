import {getImportedComparisonProjectConflictResolutionComment} from '../comparisonProjectConflictResolutionProvenance.ts'
import type {ImportCandidateRowResult} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {
  ComparisonProjectConflictResolutionImportCommentSource,
  ComparisonProjectConflictResolutionImportSkipReason,
} from './comparisonProjectConflictResolutionImportTypes.ts'

const commentSourceSkipReasons = new Set<ComparisonProjectConflictResolutionImportSkipReason>([
  'existing-target-resolution',
  'not-conflicting',
  'same-value',
])

const getCommentSourceTargetArticleId = (result: ImportCandidateRowResult) => {
  const skippedTargetArticles =
    result.skippedRow && commentSourceSkipReasons.has(result.skippedRow.reason)
      ? (result.detail?.targetArticles ?? [])
      : []

  return (
    result.candidate?.targetArticleId
    ?? (skippedTargetArticles.length === 1 ? (skippedTargetArticles[0]?.articleId ?? null) : null)
  )
}

const getCommentSourceFromResult = (
  result: ImportCandidateRowResult,
): ComparisonProjectConflictResolutionImportCommentSource[] => {
  const sourceRow = result.candidate?.sourceRow ?? result.detail?.sourceRow ?? null
  const targetArticleId = getCommentSourceTargetArticleId(result)
  const comment = getImportedComparisonProjectConflictResolutionComment(sourceRow?.sourceComment)

  return sourceRow && targetArticleId && comment
    ? [
        {
          authorDisplayName: sourceRow.sourceCommentAuthorDisplayName ?? null,
          authorUserId: sourceRow.sourceCommentAuthorUserId ?? null,
          comment,
          sourceRowId: sourceRow.sourceRowId,
          targetArticleId,
        },
      ]
    : []
}

export const getCommentSources = (candidateRowResults: readonly ImportCandidateRowResult[]) => {
  return Array.from(
    candidateRowResults
      .flatMap(getCommentSourceFromResult)
      .reduce<Map<string, ComparisonProjectConflictResolutionImportCommentSource>>((sourceMap, commentSource) => {
        return sourceMap.has(commentSource.targetArticleId)
          ? sourceMap
          : sourceMap.set(commentSource.targetArticleId, commentSource)
      }, new Map<string, ComparisonProjectConflictResolutionImportCommentSource>())
      .values(),
  )
}
