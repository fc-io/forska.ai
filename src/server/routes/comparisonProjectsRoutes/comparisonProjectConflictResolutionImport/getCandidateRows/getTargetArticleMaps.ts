import type {NormalizedTargetArticle} from '../comparisonProjectConflictResolutionImportMatchTypes.ts'

const getTargetArticleGroupsByKey = (
  targetArticles: readonly NormalizedTargetArticle[],
  getKey: (article: NormalizedTargetArticle) => string | null,
) => {
  return targetArticles.reduce<Map<string, NormalizedTargetArticle[]>>((articleMap, article) => {
    const key = getKey(article)
    const currentArticles = key ? (articleMap.get(key) ?? []) : []

    return key ? articleMap.set(key, [...currentArticles, article]) : articleMap
  }, new Map<string, NormalizedTargetArticle[]>())
}

const getTargetArticlesByIdentifierKey = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return targetArticles.reduce<Map<string, NormalizedTargetArticle[]>>((articleMap, article) => {
    return article.identifierKeys.reduce<Map<string, NormalizedTargetArticle[]>>((identifierMap, identifierKey) => {
      const currentArticles = identifierMap.get(identifierKey.key) ?? []

      identifierMap.set(identifierKey.key, [...currentArticles, article])
      return identifierMap
    }, articleMap)
  }, new Map<string, NormalizedTargetArticle[]>())
}

const getTargetArticlesByIdTitleKey = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return getTargetArticleGroupsByKey(targetArticles, (article) => {
    return article.idTitleKey
  })
}

const getTargetArticlesByCovidenceIdTitleKey = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return getTargetArticleGroupsByKey(targetArticles, (article) => {
    return article.covidenceIdTitleKey
  })
}

const getTargetArticlesByTitleKey = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return getTargetArticleGroupsByKey(targetArticles, (article) => {
    return article.titleKey
  })
}

export const getTargetArticleMaps = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return {
    byArticleId: getTargetArticlesByArticleId(targetArticles),
    byCovidenceIdTitleKey: getTargetArticlesByCovidenceIdTitleKey(targetArticles),
    byIdentifierKey: getTargetArticlesByIdentifierKey(targetArticles),
    byIdTitleKey: getTargetArticlesByIdTitleKey(targetArticles),
    byTitleKey: getTargetArticlesByTitleKey(targetArticles),
  }
}

const getTargetArticlesByArticleId = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return targetArticles.reduce<Map<string, NormalizedTargetArticle>>((articleMap, article) => {
    articleMap.set(article.articleId, article)
    return articleMap
  }, new Map<string, NormalizedTargetArticle>())
}
