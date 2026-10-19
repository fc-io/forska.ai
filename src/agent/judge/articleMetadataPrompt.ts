import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {getJsonValue} from '../../server/services/appQueryHelpers.ts'
import {getArticleSourceMetadataValue} from '../../utils/articleSourceMetadata.ts'

type ArticleMetadataPromptLine = [label: string, value: string | null]

type ArticleMetadataSource = Pick<ArticleRecord, 'articleCreatedAt' | 'doi' | 'pubmedId' | 'sourceMetadata'> & {
  publicationStatus: string | null
}

export type ArticleMetadataLine = {label: string; value: string}

const noArticleMetadataText = 'none available'

const getPromptLineValue = (value: unknown) => {
  const text =
    typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  const normalizedText = text.replace(/\s+/g, ' ').trim()

  return normalizedText === '' ? null : normalizedText
}

const getDateYear = (value: unknown) => {
  const date =
    value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null

  return date && Number.isFinite(date.getTime()) ? date.getUTCFullYear() : null
}

const getVolumeIssuePagesText = (metadata: ReturnType<typeof getArticleSourceMetadataValue>) => {
  const volume = getPromptLineValue(metadata?.volume) ?? ''
  const issue = getPromptLineValue(metadata?.issue)
  const pages = getPromptLineValue(metadata?.pages)
  const issueText = issue ? `(${issue})` : ''
  const pagesSeparator = volume || issueText ? ':' : ''
  const pagesText = pages ? `${pagesSeparator}${pages}` : ''

  return getPromptLineValue(`${volume}${issueText}${pagesText}`)
}

const getPublicationTypeText = (
  article: Pick<ArticleMetadataSource, 'publicationStatus'>,
  metadata: ReturnType<typeof getArticleSourceMetadataValue>,
) => {
  return (
    getPromptLineValue(metadata?.publicationType)
    ?? getPromptLineValue(article.publicationStatus)
    ?? (metadata?.isPreprint ? 'preprint' : null)
  )
}

export const getArticleMetadataLines = (article: ArticleMetadataSource): ArticleMetadataLine[] => {
  const metadata = getArticleSourceMetadataValue(getJsonValue(article.sourceMetadata))
  const lines: ArticleMetadataPromptLine[] = [
    ['journal', getPromptLineValue(metadata?.journalTitle)],
    ['year', getPromptLineValue(metadata?.publicationYear ?? getDateYear(article.articleCreatedAt))],
    ['volume/issue/pages', getVolumeIssuePagesText(metadata)],
    ['publication_type', getPublicationTypeText(article, metadata)],
    ['doi', getPromptLineValue(article.doi)],
    ['pmid', getPromptLineValue(article.pubmedId)],
  ]

  return lines
    .filter((line): line is [string, string] => {
      return line[1] !== null
    })
    .map(([label, value]) => {
      return {label, value}
    })
}

const getArticleMetadataLineText = (line: ArticleMetadataLine) => {
  return `${line.label}: ${line.value}`
}

export const getArticleMetadataPromptText = (article: ArticleRecord): string => {
  const lines = getArticleMetadataLines(article)

  return lines.length > 0 ? lines.map(getArticleMetadataLineText).join('\n') : noArticleMetadataText
}
