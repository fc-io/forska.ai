import type {ArticleRecord} from '../../../../db/schemaTypes.ts'
import {getDateValue, getJsonValue} from '../../../services/appQueryHelpers.ts'
import type {ArticleFullTextRow, ServingArticleDetailRow} from './articleReviewDetailTypes.ts'

const getArticleAuthorsValue = (value: unknown) => {
  const parsed = getJsonValue(value)

  return Array.isArray(parsed)
    ? parsed.filter((author): author is string => {
        return typeof author === 'string'
      })
    : null
}

export const getArticleRecordFromServing = (input: {
  articleId: string
  detail: ServingArticleDetailRow
  fullText: ArticleFullTextRow | null
}): ArticleRecord => {
  const sourceMetadata = getJsonValue(input.detail.source_metadata)

  return {
    articleAuthors: getArticleAuthorsValue(input.fullText?.articleAuthors),
    articleCreatedAt: getDateValue(input.detail.article_created_at),
    articleId: input.detail.article_external_id ?? null,
    articleSummary: input.fullText?.articleSummary ?? null,
    articleTitle: input.detail.article_title ?? '',
    articleUpdatedAt: getDateValue(input.detail.article_updated_at),
    articleVersion: null,
    arxivId: input.detail.arxiv_id ?? null,
    biorxivId: input.detail.biorxiv_id ?? null,
    contentHash: null,
    createdAt: new Date(0),
    doi: input.detail.doi ?? null,
    fullText: input.fullText?.fullText ?? null,
    fullTextAssets: null,
    fullTextCharCount: input.fullText?.fullTextCharCount ?? null,
    fullTextConversionAttempts: null,
    fullTextConversionError: null,
    fullTextConversionMetadata: null,
    fullTextConversionModelId: null,
    fullTextConversionStatus: input.detail.full_text_conversion_status ?? null,
    fullTextFetchedAt: getDateValue(input.detail.full_text_fetched_at),
    fullTextHtml: input.fullText?.fullTextHtml ?? null,
    fullTextOriginalFormat: input.fullText?.fullTextOriginalFormat ?? null,
    fullTextPDF: input.detail.full_text_pdf ?? null,
    fullTextSource: input.fullText?.fullTextSource ?? null,
    id: input.detail.article_id ?? input.articleId,
    importRoute: input.fullText?.importRoute ?? null,
    medrxivId: input.detail.medrxiv_id ?? null,
    originalData: null,
    publicationStatus: null,
    pubmedId: input.detail.pmid ?? null,
    sourceMetadata,
    updatedAt: new Date(0),
    url: input.detail.url ?? null,
  }
}
