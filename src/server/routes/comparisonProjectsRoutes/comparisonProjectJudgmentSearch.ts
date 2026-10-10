import {getNormalizedComparisonProjectSearchText} from '../../../utils/comparisonProjectSearchText.ts'
import {
  getIsReviewServingTitleSearchCjkSegment,
  getNormalizedReviewServingTitleSearchText,
  getReviewServingTitleSearchCjkBigrams,
  getReviewServingTitleSearchNormalizedTitleSql,
  getReviewServingTitleSearchSegments,
  getReviewServingTitleSearchSegmentsSql,
} from '../../reviewServing/reviewServingTitleSearchTokenizer.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'

/**
 * Query-time fuzzy title search for comparison project rows. Nothing is
 * materialized: the predicate normalizes `article_title` the same way the
 * review title search index does (`lower(strip_accents())`, CJK runs padded)
 * and matches every query term with
 *
 * - a substring match on the normalized title,
 * - for words of 5+ letters, a Damerau-Levenshtein typo budget (1 typo from 5
 *   letters, 2 from 9) against each title word or its same-length prefix,
 * - for CJK runs of 3+ characters, character-bigram coverage with the same
 *   budget of missing bigrams,
 *
 * and the whole query against the article identifiers (external id, DOI,
 * PubMed, arXiv, bioRxiv, medRxiv) when it looks like one.
 */

export const comparisonProjectSearchMaxTerms = 8

const comparisonProjectSearchOneTypoMinLength = 5
const comparisonProjectSearchTwoTypoMinLength = 9
const comparisonProjectSearchCjkBigramMinLength = 3
const comparisonProjectSearchIdentifierMinLength = 3

const digitPattern = /\p{N}/u
const identifierDisallowedPattern = /[^\p{L}\p{N}./:_()-]+/gu

export const comparisonProjectSearchColumns = {
  identifiers: 'search_identifiers',
  title: 'search_title',
  tokens: 'search_tokens',
} as const

export type ComparisonProjectSearchTextTerm = {kind: 'text'; typoBudget: number; value: string}

export type ComparisonProjectSearchCjkTerm = {
  allowedMissingBigrams: number
  bigrams: string[]
  kind: 'cjk'
  value: string
}

export type ComparisonProjectSearchTerm = ComparisonProjectSearchCjkTerm | ComparisonProjectSearchTextTerm

export type ComparisonProjectSearchQuery = {identifier: string | null; terms: ComparisonProjectSearchTerm[]}

const isDefined = <T>(value: T | null | undefined): value is T => {
  return value !== null && value !== undefined
}

const getCharacterCount = (value: string) => {
  return Array.from(value).length
}

export const getComparisonProjectSearchTypoBudget = (value: string) => {
  const length = getCharacterCount(value)

  return digitPattern.test(value) || length < comparisonProjectSearchOneTypoMinLength
    ? 0
    : length < comparisonProjectSearchTwoTypoMinLength
      ? 1
      : 2
}

const getCjkSearchTerm = (value: string): ComparisonProjectSearchCjkTerm => {
  const bigrams =
    getCharacterCount(value) >= comparisonProjectSearchCjkBigramMinLength
      ? getReviewServingTitleSearchCjkBigrams(value)
      : []

  return {allowedMissingBigrams: getComparisonProjectSearchTypoBudget(value), bigrams, kind: 'cjk', value}
}

const getSearchTerm = (segment: string): ComparisonProjectSearchTerm => {
  return getIsReviewServingTitleSearchCjkSegment(segment)
    ? getCjkSearchTerm(segment)
    : {kind: 'text', typoBudget: getComparisonProjectSearchTypoBudget(segment), value: segment}
}

const getSearchIdentifier = (normalizedText: string) => {
  const identifier = getNormalizedReviewServingTitleSearchText(normalizedText).replace(identifierDisallowedPattern, '')

  return !normalizedText.includes(' ')
    && getCharacterCount(identifier) >= comparisonProjectSearchIdentifierMinLength
    && digitPattern.test(identifier)
    ? identifier
    : null
}

export const getComparisonProjectSearchQuery = (searchText: unknown): ComparisonProjectSearchQuery | null => {
  const normalizedText = getNormalizedComparisonProjectSearchText(searchText)

  if (normalizedText === '') {
    return null
  }

  const terms = [...new Set(getReviewServingTitleSearchSegments(normalizedText))]
    .slice(0, comparisonProjectSearchMaxTerms)
    .map(getSearchTerm)
  const identifier = getSearchIdentifier(normalizedText)

  return terms.length === 0 && identifier === null ? null : {identifier, terms}
}

export const getComparisonProjectSearchRequiresTokens = (query: ComparisonProjectSearchQuery) => {
  return query.terms.some((term) => {
    return term.kind === 'text' && term.typoBudget > 0
  })
}

const getTextTermPredicateSql = (term: ComparisonProjectSearchTextTerm, titleSql: string, tokensSql: string) => {
  const literal = getSqlLiteral(term.value)
  const substringPredicate = `contains(${titleSql}, ${literal})`
  const length = getCharacterCount(term.value)
  const budget = term.typoBudget

  return budget === 0
    ? substringPredicate
    : `(${substringPredicate}
        OR len(list_filter(${tokensSql}, lambda token: CASE
          WHEN length(token) BETWEEN ${length - budget} AND ${length + budget}
            THEN damerau_levenshtein(token, ${literal}) <= ${budget}
          WHEN length(token) > ${length + budget}
            THEN damerau_levenshtein(substring(token, 1, ${length}), ${literal}) <= ${budget}
          ELSE FALSE
        END)) > 0)`
}

const getCjkTermPredicateSql = (term: ComparisonProjectSearchCjkTerm, titleSql: string) => {
  const substringPredicate = `contains(${titleSql}, ${getSqlLiteral(term.value)})`
  const requiredBigramCount = term.bigrams.length - term.allowedMissingBigrams

  return term.bigrams.length < 2
    ? substringPredicate
    : `(${substringPredicate}
        OR len(list_filter([${term.bigrams.map(getSqlLiteral).join(', ')}], lambda bigram: contains(${titleSql}, bigram))) >= ${requiredBigramCount})`
}

const getTermPredicateSql = (term: ComparisonProjectSearchTerm, titleSql: string, tokensSql: string) => {
  return term.kind === 'cjk'
    ? getCjkTermPredicateSql(term, titleSql)
    : getTextTermPredicateSql(term, titleSql, tokensSql)
}

const getTermsPredicateSql = (predicates: readonly string[]) => {
  return predicates.length === 0
    ? null
    : predicates.length === 1
      ? (predicates[0] ?? null)
      : `(${predicates.join('\n        AND ')})`
}

export const getComparisonProjectSearchPredicateSql = (query: ComparisonProjectSearchQuery, articleAlias: string) => {
  const titleSql = `${articleAlias}.${comparisonProjectSearchColumns.title}`
  const tokensSql = `${articleAlias}.${comparisonProjectSearchColumns.tokens}`
  const termsPredicate = getTermsPredicateSql(
    query.terms.map((term) => {
      return getTermPredicateSql(term, titleSql, tokensSql)
    }),
  )
  const identifierPredicate =
    query.identifier === null
      ? null
      : `contains(${articleAlias}.${comparisonProjectSearchColumns.identifiers}, ${getSqlLiteral(query.identifier)})`
  const predicates = [identifierPredicate, termsPredicate].filter(isDefined)

  return predicates.length === 0
    ? 'TRUE'
    : predicates.length === 1
      ? (predicates[0] ?? 'TRUE')
      : `(${predicates.join(' OR ')})`
}

/**
 * Row source that adds the normalized search columns to every row of the
 * article table that belongs to the comparison project's active generation,
 * so the expensive normalization runs only on in-scope rows.
 */
export const getComparisonProjectSearchArticleSourceSql = (params: {
  articleTable: string
  comparisonProjectIdSql: string
  generationSql: string
  query: ComparisonProjectSearchQuery
}) => {
  const titleColumn = comparisonProjectSearchColumns.title
  const tokensColumn = comparisonProjectSearchColumns.tokens
  const tokensSql = getComparisonProjectSearchRequiresTokens(params.query)
    ? `list_filter(${getReviewServingTitleSearchSegmentsSql(`normalized_article.${titleColumn}`)}, lambda segment: segment <> '')`
    : '[]::VARCHAR[]'

  return `(
      SELECT
        normalized_article.*,
        ${tokensSql} AS ${tokensColumn}
      FROM (
        SELECT
          source_article.*,
          ${getReviewServingTitleSearchNormalizedTitleSql('source_article.article_title')} AS ${titleColumn},
          lower(concat_ws(' ',
            source_article.article_external_id,
            source_article.doi,
            source_article.pubmed_id,
            source_article.arxiv_id,
            source_article.biorxiv_id,
            source_article.medrxiv_id
          )) AS ${comparisonProjectSearchColumns.identifiers}
        FROM ${params.articleTable} source_article
        WHERE source_article.comparison_project_id = ${params.comparisonProjectIdSql}
          AND source_article.generation IN ${params.generationSql}
      ) normalized_article
    )`
}
