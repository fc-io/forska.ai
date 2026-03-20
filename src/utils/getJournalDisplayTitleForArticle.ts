import {getArticleSourceMetadata, getArticleSourceMetadataValue} from './articleSourceMetadata.ts'

type JournalDisplayArticle = {
  journalTitle?: unknown
  sourceMetadata?: unknown
  originalData?: unknown
  articleId?: unknown
  importRoute?: unknown
}

const asNonEmptyString = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed : null
}

export const getJournalDisplayTitleForArticle = (article: JournalDisplayArticle) => {
  const fromField = asNonEmptyString(article.journalTitle)
  const sourceMetadata =
    getArticleSourceMetadataValue(article.sourceMetadata)
    ?? getArticleSourceMetadata({
      articleId: article.articleId,
      importRoute: article.importRoute,
      journalTitle: article.journalTitle,
      originalData: article.originalData,
    })
  const journalTitle = fromField ?? sourceMetadata.journalTitle

  return journalTitle
    ? journalTitle
    : sourceMetadata.isPreprint && sourceMetadata.preprintSource
      ? `(${sourceMetadata.preprintSource})`
      : null
}
