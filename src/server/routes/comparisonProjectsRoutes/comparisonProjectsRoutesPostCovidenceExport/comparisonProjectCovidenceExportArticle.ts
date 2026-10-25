import {type ArticleSourceMetadata, getArticleSourceMetadataValue} from '../../../../utils/articleSourceMetadata.ts'
import {getJsonValue} from '../../../services/appQueryHelpers.ts'
import type {ComparisonProjectCovidenceExportArticleRow} from '../../../services/comparisonProjectCovidenceExportArticleRepository.ts'

export type ComparisonProjectCovidenceExportCitation = {
  citation: Record<string, string | null>
  notes: string[]
  tags: string[]
}

export type ComparisonProjectCovidenceExportArticle = {
  articleAuthors: string[]
  articleId: string
  articleSummary: string | null
  articleTitle: string | null
  covidence: ComparisonProjectCovidenceExportCitation | null
  doi: string | null
  pubmedId: string | null
  sourceMetadata: ArticleSourceMetadata | null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getTrimmedStrings = (value: unknown) => {
  const values = Array.isArray(value) ? value : []

  return values
    .map((entry) => {
      return typeof entry === 'string' ? entry.trim() : ''
    })
    .filter((entry) => {
      return entry !== ''
    })
}

const getCitationValue = (value: unknown) => {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null
}

const getCitationRecord = (value: Record<string, unknown>) => {
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      return [key, getCitationValue(entryValue)]
    }),
  )
}

const getComparisonProjectCovidenceExportCitation = (
  value: unknown,
): ComparisonProjectCovidenceExportCitation | null => {
  const covidence = getJsonValue(value)
  const citation = isRecord(covidence) ? getJsonValue(covidence.citation) : null

  return isRecord(covidence) && isRecord(citation)
    ? {
        citation: getCitationRecord(citation),
        notes: getTrimmedStrings(covidence.notes),
        tags: getTrimmedStrings(covidence.tags),
      }
    : null
}

export const getComparisonProjectCovidenceExportArticle = (
  row: ComparisonProjectCovidenceExportArticleRow,
): ComparisonProjectCovidenceExportArticle => {
  return {
    articleAuthors: getTrimmedStrings(getJsonValue(row.articleAuthors)),
    articleId: row.articleId,
    articleSummary: row.articleSummary,
    articleTitle: row.articleTitle,
    covidence: getComparisonProjectCovidenceExportCitation(row.covidence),
    doi: row.doi,
    pubmedId: row.pubmedId,
    sourceMetadata: getArticleSourceMetadataValue(getJsonValue(row.sourceMetadata)),
  }
}
