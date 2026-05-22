import type {
  ArticleIdentifierInput,
  ArticleStrongIdentifierKind,
  NormalizedSourceRowIdentifiers,
} from '../../../utils/articleIdentifierNormalization.ts'
import {normalizeSourceRowIdentifiers} from '../../../utils/articleIdentifierNormalization.ts'

export const projectTransferIdentifierComparisonScopes = [
  'analyze',
  'duplicateSummary',
  'overlapSummary',
  'commit',
] as const

export type ProjectTransferIdentifierComparisonScope = (typeof projectTransferIdentifierComparisonScopes)[number]

export type ProjectTransferArticleIdentifierSource = {
  arxivId?: unknown
  biorxivId?: unknown
  doi?: unknown
  identifierInputs?: readonly ArticleIdentifierInput[]
  medrxivId?: unknown
  pubmedId?: unknown
  url?: unknown
}

export type ProjectTransferStrongIdentifierComparisonKey = `${ArticleStrongIdentifierKind}:${string}`

export type ProjectTransferIdentifierComparisonInput = {
  article: ProjectTransferArticleIdentifierSource
  scope: ProjectTransferIdentifierComparisonScope
}

export type ProjectTransferIdentifierOverlapInput = {
  left: ProjectTransferArticleIdentifierSource
  right: ProjectTransferArticleIdentifierSource
  scope: ProjectTransferIdentifierComparisonScope
}

const compareStableStrings = (left: string, right: string) => {
  return left < right ? -1 : left > right ? 1 : 0
}

const hasIdentifierValue = (value: unknown) => {
  return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '')
}

const getOptionalIdentifierInput = (input: ArticleIdentifierInput): ArticleIdentifierInput[] => {
  return hasIdentifierValue(input.value) ? [input] : []
}

const getArticleFieldIdentifierInputs = (article: ProjectTransferArticleIdentifierSource): ArticleIdentifierInput[] => {
  return [
    ...getOptionalIdentifierInput({inputKind: 'doi', source: 'doi', value: article.doi}),
    ...getOptionalIdentifierInput({inputKind: 'pmid', source: 'pubmedId', value: article.pubmedId}),
    ...getOptionalIdentifierInput({inputKind: 'arxiv', source: 'arxivId', value: article.arxivId}),
    ...getOptionalIdentifierInput({inputKind: 'biorxiv', source: 'biorxivId', value: article.biorxivId}),
    ...getOptionalIdentifierInput({inputKind: 'medrxiv', source: 'medrxivId', value: article.medrxivId}),
  ]
}

export const getProjectTransferArticleIdentifierInputs = (
  article: ProjectTransferArticleIdentifierSource,
): ArticleIdentifierInput[] => {
  return [...getArticleFieldIdentifierInputs(article), ...(article.identifierInputs ?? [])]
}

export const getProjectTransferNormalizedArticleIdentifiers = (
  article: ProjectTransferArticleIdentifierSource,
): NormalizedSourceRowIdentifiers => {
  return normalizeSourceRowIdentifiers(getProjectTransferArticleIdentifierInputs(article))
}

export const getProjectTransferStrongIdentifierComparisonKeys = (
  article: ProjectTransferArticleIdentifierSource,
): ProjectTransferStrongIdentifierComparisonKey[] => {
  return getProjectTransferNormalizedArticleIdentifiers(article)
    .strongIdentifiers.map((identifier): ProjectTransferStrongIdentifierComparisonKey => {
      return `${identifier.kind}:${identifier.normalizedValue}`
    })
    .sort(compareStableStrings)
}

export const getProjectTransferIdentifierComparisonKeysForScope = ({
  article,
  scope: _scope,
}: ProjectTransferIdentifierComparisonInput) => {
  return getProjectTransferStrongIdentifierComparisonKeys(article)
}

export const getProjectTransferIdentifierOverlapKeys = ({
  left,
  right,
}: ProjectTransferIdentifierOverlapInput): ProjectTransferStrongIdentifierComparisonKey[] => {
  const rightKeys = new Set(getProjectTransferStrongIdentifierComparisonKeys(right))

  return getProjectTransferStrongIdentifierComparisonKeys(left).filter((key) => {
    return rightKeys.has(key)
  })
}
