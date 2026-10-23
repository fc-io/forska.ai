import type {
  ComparisonProjectConflictResolutionImportAnalyzeRow,
  ComparisonProjectConflictResolutionImportAnalyzeRowReason,
} from './comparisonProjectConflictResolutionImportAnalyzeTypes.ts'
import type {
  ImportCandidateRow,
  ImportRowMatchDetail,
  NormalizedTargetArticle,
} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import {getUniqueStringValues} from './comparisonProjectConflictResolutionImportUtils.ts'
import type {CommentChangeBySourceRowId} from './getCommentChangeBySourceRowId.ts'
import {getImportRowMatchDetail} from './getImportRowMatchDetail.ts'

const getFirstAnalyzeTargetArticle = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return targetArticles[0] ?? null
}

const getAnalyzeTargetArticleIds = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return getUniqueStringValues(
    targetArticles.map((targetArticle) => {
      return targetArticle.articleId
    }),
  )
}

const getAnalyzeTargetExternalArticleIds = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return getUniqueStringValues(
    targetArticles
      .map((targetArticle) => {
        return targetArticle.externalArticleId ?? ''
      })
      .filter(Boolean),
  )
}

export const getAnalyzeRow = (params: {
  commentChangeBySourceRowId: CommentChangeBySourceRowId
  detail: ImportRowMatchDetail
  reason: ComparisonProjectConflictResolutionImportAnalyzeRowReason
  selectedResolution: string
}): ComparisonProjectConflictResolutionImportAnalyzeRow => {
  const firstTargetArticle = getFirstAnalyzeTargetArticle(params.detail.targetArticles)
  const commentChange = params.commentChangeBySourceRowId.get(params.detail.sourceRow.sourceRowId)

  return {
    sourceTitle: params.detail.sourceRow.sourceArticleTitle ?? params.detail.sourceRow.title ?? null,
    sourceArticleRowId: params.detail.sourceRow.sourceArticleId,
    sourceExternalArticleId:
      params.detail.sourceRow.sourceExternalArticleId ?? params.detail.sourceRow.externalArticleId ?? null,
    sourceResolutionId: params.detail.sourceRow.sourceResolutionId,
    sourceComparisonProjectId: params.detail.sourceRow.sourceComparisonProjectId,
    sourceComparisonProjectName: params.detail.sourceRow.sourceComparisonProjectName,
    targetTitle: firstTargetArticle?.title ?? null,
    targetArticleId: firstTargetArticle?.articleId ?? null,
    targetArticleIds: getAnalyzeTargetArticleIds(params.detail.targetArticles),
    targetExternalArticleId: firstTargetArticle?.externalArticleId ?? null,
    targetExternalArticleIds: getAnalyzeTargetExternalArticleIds(params.detail.targetArticles),
    selectedResolution: params.selectedResolution,
    matchKind: params.detail.matchKind,
    matchKey: params.detail.matchKey,
    reason: params.reason,
    ...(commentChange ? {commentChange} : {}),
  }
}

export const getAnalyzeRowFromCandidateRow = (
  candidateRow: ImportCandidateRow,
  commentChangeBySourceRowId: CommentChangeBySourceRowId,
): ComparisonProjectConflictResolutionImportAnalyzeRow => {
  return getAnalyzeRow({
    commentChangeBySourceRowId,
    detail: getImportRowMatchDetail({
      matchKey: candidateRow.matchKey,
      matchKind: candidateRow.matchKind,
      sourceRow: candidateRow.sourceRow,
      targetArticles: [candidateRow.targetArticle],
    }),
    reason: candidateRow.isOverwrite ? 'overwrite-candidate' : 'importable',
    selectedResolution: candidateRow.resolutionValue ?? '',
  })
}
