import type {
  NormalizedSourceRow,
  NormalizedTargetArticle,
} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {
  ComparisonProjectConflictResolutionImportWarningSourceRow,
  ComparisonProjectConflictResolutionImportWarningTargetArticle,
} from './comparisonProjectConflictResolutionImportTypes.ts'

export const getWarningSourceRow = (
  row: NormalizedSourceRow,
): ComparisonProjectConflictResolutionImportWarningSourceRow => {
  return {
    articleId: row.sourceArticleId,
    articleTitle: row.sourceArticleTitle ?? row.title ?? null,
    compareProjectId: row.sourceComparisonProjectId,
    compareProjectName: row.sourceComparisonProjectName,
    externalArticleId: row.sourceExternalArticleId ?? row.externalArticleId ?? null,
    resolutionAnswer: row.resolutionValue ?? '',
    sourceResolutionId: row.sourceResolutionId,
    sourceRowId: row.sourceRowId,
  }
}

export const getWarningTargetArticle = (
  targetArticle: NormalizedTargetArticle,
): ComparisonProjectConflictResolutionImportWarningTargetArticle => {
  return {
    articleId: targetArticle.articleId,
    articleTitle: targetArticle.title ?? null,
    doiKeys: targetArticle.doiKeys,
    externalArticleId: targetArticle.externalArticleId ?? null,
    identifierKeys: targetArticle.identifierKeys.map((identifierKey) => {
      return identifierKey.matchKey
    }),
  }
}
