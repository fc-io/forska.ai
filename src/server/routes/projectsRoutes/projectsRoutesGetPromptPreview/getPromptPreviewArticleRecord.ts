import type {ArticleRecord} from '../../../../db/schemaTypes.ts'
import {getJsonValue} from '../../../services/appQueryHelpers.ts'
import type {PromptPreviewServingRow} from './promptPreviewServingRow.ts'

const publicationStatuses = ['preprint', 'submitted', 'accepted', 'published', 'retracted'] as const

const getPublicationStatus = (value: string | null | undefined): ArticleRecord['publicationStatus'] => {
  return (
    publicationStatuses.find((status) => {
      return status === value
    }) ?? null
  )
}

const getDateValue = (value: unknown) => {
  return value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
}

export const getPromptPreviewArticleRecord = (input: {
  fullText: string | null
  publicationStatus: string | null
  row: PromptPreviewServingRow
}): ArticleRecord => {
  return {
    articleAuthors: null,
    articleCreatedAt: getDateValue(input.row.article_created_at),
    articleId: input.row.article_external_id,
    articleSummary: input.row.article_summary,
    articleTitle: input.row.article_title ?? '',
    articleUpdatedAt: getDateValue(input.row.article_updated_at),
    articleVersion: null,
    arxivId: input.row.arxiv_id,
    biorxivId: input.row.biorxiv_id,
    contentHash: null,
    createdAt: new Date(0),
    doi: input.row.doi,
    fullText: input.fullText,
    fullTextAssets: null,
    fullTextCharCount: input.fullText?.length ?? null,
    fullTextConversionAttempts: null,
    fullTextConversionError: null,
    fullTextConversionMetadata: null,
    fullTextConversionModelId: null,
    fullTextConversionStatus: input.row.full_text_conversion_status,
    fullTextFetchedAt: getDateValue(input.row.full_text_fetched_at),
    fullTextHtml: null,
    fullTextOriginalFormat: null,
    fullTextPDF: input.row.full_text_pdf,
    fullTextSource: null,
    id: input.row.article_id,
    importRoute: null,
    medrxivId: input.row.medrxiv_id,
    originalData: null,
    publicationStatus: getPublicationStatus(input.publicationStatus),
    pubmedId: input.row.pmid,
    sourceMetadata: getJsonValue(input.row.source_metadata),
    updatedAt: new Date(0),
    url: input.row.url,
  }
}
