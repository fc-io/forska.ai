import type {NormalizedTargetArticle} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import {getUniqueStringValues} from './comparisonProjectConflictResolutionImportUtils.ts'

export const getTargetArticleIds = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return getUniqueStringValues(
    targetArticles.map((article) => {
      return article.articleId
    }),
  )
}
