import {
  normalizeArxivIdentifier,
  normalizeBiorxivIdentifier,
  normalizeDoiIdentifier,
  normalizeMedrxivIdentifier,
  normalizePmidIdentifier,
} from '../../utils/articleIdentifierNormalization.ts'
import {getArticleSourceMetadataValue} from '../../utils/articleSourceMetadata.ts'

export type ArticleUrlInput = {
  arxivId?: unknown
  articleId?: unknown
  articleUrl?: unknown
  biorxivId?: unknown
  canonicalUrl?: unknown
  doi?: unknown
  landingUrl?: unknown
  medrxivId?: unknown
  originalData?: unknown
  pubmedId?: unknown
  scopedImportMetadata?: unknown
  scopedRawPayload?: unknown
  sourceMetadata?: unknown
  sourceUrl?: unknown
  url?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getStringValue = (value: unknown) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed : null
}

const getHttpUrlValue = (value: unknown) => {
  const urlValue = getStringValue(value)

  if (!urlValue) {
    return null
  }

  try {
    const parsed = new URL(urlValue)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

const getValueAtPath = (value: unknown, path: string[]): unknown => {
  const [first, ...rest] = path
  return first === undefined ? value : getValueAtPath(isRecord(value) ? value[first] : null, rest)
}

const getFirstHttpUrl = (values: unknown[]) => {
  return (
    values
      .map((value) => {
        return getHttpUrlValue(value)
      })
      .find((value): value is string => {
        return value !== null
      }) ?? null
  )
}

const sourceUrlPaths = [
  ['sourceUrl'],
  ['articleUrl'],
  ['landingUrl'],
  ['url'],
  ['citation', 'url'],
  ['covidence', 'citation', 'url'],
]

const getScopedSourceUrl = (article: ArticleUrlInput) => {
  return getFirstHttpUrl([
    article.sourceUrl,
    article.articleUrl,
    article.landingUrl,
    ...[article.scopedImportMetadata, article.scopedRawPayload, article.originalData].flatMap((value) => {
      return sourceUrlPaths.map((path) => {
        return getValueAtPath(value, path)
      })
    }),
  ])
}

const getSourceMetadataUrl = (sourceMetadata: unknown) => {
  const metadata = getArticleSourceMetadataValue(sourceMetadata)
  return getFirstHttpUrl(
    metadata?.fullTextLinks.map((link) => {
      return link.url
    }) ?? [],
  )
}

const getDoiUrl = (value: unknown) => {
  const outcome = normalizeDoiIdentifier(value)
  return outcome.status === 'accepted' ? `https://doi.org/${outcome.identifier.normalizedValue}` : null
}

const getPmidUrl = (value: unknown) => {
  const outcome = normalizePmidIdentifier(value)
  return outcome.status === 'accepted' ? `https://pubmed.ncbi.nlm.nih.gov/${outcome.identifier.normalizedValue}/` : null
}

const getArxivUrl = (value: unknown) => {
  const outcome = normalizeArxivIdentifier(value)
  return outcome.status === 'accepted' ? `https://arxiv.org/abs/${outcome.identifier.normalizedValue}` : null
}

const getBiorxivUrl = (value: unknown) => {
  const outcome = normalizeBiorxivIdentifier(value)
  return outcome.status === 'accepted' ? `https://www.biorxiv.org/content/${outcome.identifier.normalizedValue}` : null
}

const getMedrxivUrl = (value: unknown) => {
  const outcome = normalizeMedrxivIdentifier(value)
  return outcome.status === 'accepted' ? `https://www.medrxiv.org/content/${outcome.identifier.normalizedValue}` : null
}

const getIdentifierUrl = (article: ArticleUrlInput) => {
  return (
    getArxivUrl(article.arxivId)
    ?? getBiorxivUrl(article.biorxivId)
    ?? getMedrxivUrl(article.medrxivId)
    ?? getDoiUrl(article.doi)
    ?? getPmidUrl(article.pubmedId)
  )
}

export const getArticleUrl = (article: ArticleUrlInput | null | undefined): string => {
  if (!article) {
    return ''
  }

  return (
    getFirstHttpUrl([article.canonicalUrl, article.url])
    ?? getScopedSourceUrl(article)
    ?? getIdentifierUrl(article)
    ?? getSourceMetadataUrl(article.sourceMetadata)
    ?? ''
  )
}
