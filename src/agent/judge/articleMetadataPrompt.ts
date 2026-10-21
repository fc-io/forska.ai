import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {getJsonValue} from '../../server/services/appQueryHelpers.ts'
import {type ArticleMetadataLine, getArticleMetadataLinesText} from '../../utils/articleMetadataText.ts'
import {getArticleSourceMetadataValue} from '../../utils/articleSourceMetadata.ts'
import {getArticleSourceUrls} from '../../utils/articleSourceUrl.ts'
import {getTrialRegistryIdentifier, isTrialRegistryUrl} from '../../utils/trialRegistryIdentifier.ts'

type ArticleMetadataPromptLine = [label: string, value: string | null]

type ArticleMetadataSource = Pick<ArticleRecord, 'articleCreatedAt' | 'doi' | 'pubmedId' | 'sourceMetadata'> & {
  publicationStatus: string | null
}

type ArticleSourceMetadataValue = ReturnType<typeof getArticleSourceMetadataValue>

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

const getVolumeIssuePagesText = (metadata: ArticleSourceMetadataValue) => {
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
  metadata: ArticleSourceMetadataValue,
) => {
  return (
    getPromptLineValue(metadata?.publicationType)
    ?? getPromptLineValue(article.publicationStatus)
    ?? (metadata?.isPreprint ? 'preprint' : null)
  )
}

const getRegistryIdText = (metadata: ArticleSourceMetadataValue) => {
  return (
    [metadata?.accessionNumber, metadata?.sourceUrl, metadata?.journalTitle]
      .map(getTrialRegistryIdentifier)
      .find((registryId): registryId is string => {
        return registryId !== null
      }) ?? null
  )
}

const getAccessionText = (metadata: ArticleSourceMetadataValue) => {
  const accession = getPromptLineValue(metadata?.accessionNumber)

  return getTrialRegistryIdentifier(accession) === null ? accession : null
}

const getSourceUrlText = (metadata: ArticleSourceMetadataValue, doi: string | null) => {
  const sourceUrls = getArticleSourceUrls(metadata?.sourceUrl)
  const registryUrl = sourceUrls.find(isTrialRegistryUrl) ?? null

  return registryUrl ?? (doi === null ? (sourceUrls[0] ?? null) : null)
}

export const getArticleMetadataLines = (article: ArticleMetadataSource): ArticleMetadataLine[] => {
  const metadata = getArticleSourceMetadataValue(getJsonValue(article.sourceMetadata))
  const doi = getPromptLineValue(article.doi)
  const lines: ArticleMetadataPromptLine[] = [
    ['journal', getPromptLineValue(metadata?.journalTitle)],
    ['year', getPromptLineValue(metadata?.publicationYear ?? getDateYear(article.articleCreatedAt))],
    ['volume/issue/pages', getVolumeIssuePagesText(metadata)],
    ['publication_type', getPublicationTypeText(article, metadata)],
    ['doi', doi],
    ['pmid', getPromptLineValue(article.pubmedId)],
    ['registry_id', getRegistryIdText(metadata)],
    ['accession', getAccessionText(metadata)],
    ['source_url', getSourceUrlText(metadata, doi)],
  ]

  return lines
    .filter((line): line is [string, string] => {
      return line[1] !== null
    })
    .map(([label, value]) => {
      return {label, value}
    })
}

export const getArticleMetadataSourceText = (article: ArticleMetadataSource): string => {
  return getArticleMetadataLinesText(getArticleMetadataLines(article))
}

export const getArticleMetadataPromptText = (article: ArticleRecord): string => {
  return getArticleMetadataSourceText(article) || noArticleMetadataText
}
