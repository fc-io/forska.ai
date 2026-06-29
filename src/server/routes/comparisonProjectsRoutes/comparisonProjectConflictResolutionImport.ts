import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'
import {
  type ArticleStrongIdentifierKind,
  normalizeSourceRowIdentifiers,
} from '../../../utils/articleIdentifierNormalization.ts'
import {getDateValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import type {
  ComparisonProjectConflictResolutionTransferArtifactV1,
  ComparisonProjectConflictResolutionTransferRowV1,
} from './comparisonProjectConflictResolutionFileTransfer.ts'

export type ComparisonProjectConflictResolutionImportSource = {
  id: string
  name: string
  description: string | null
  createdAt: Date
  humanJudgmentMode: HumanJudgmentMode
  resolutionCount: number
}

export type ComparisonProjectConflictResolutionImportSourceQueryRow = {
  id: string
  name: string
  description: string | null
  createdAt: unknown
  humanJudgmentMode: HumanJudgmentMode | null
  resolutionCount: unknown
}

export type ComparisonProjectConflictResolutionImportMatchKind =
  | ArticleStrongIdentifierKind
  | 'article-id'
  | 'id-title'
  | 'title'

export type ComparisonProjectConflictResolutionImportIdentifier = {
  kind: ArticleStrongIdentifierKind
  normalizedValue: string
}

export type ComparisonProjectConflictResolutionImportSourceRow = {
  arxivId?: string | null
  doi?: string | null
  doiKeys?: readonly (string | null | undefined)[] | null
  externalArticleId?: string | null
  identifierKeys?: readonly (string | null | undefined)[] | null
  identifiers?: readonly ComparisonProjectConflictResolutionImportIdentifier[] | null
  pubmedId?: string | null
  resolutionMode?: HumanJudgmentMode | null
  resolutionValue: string
  sourceArticleId: string
  sourceArticleTitle?: string | null
  sourceComparisonProjectId: string
  sourceComparisonProjectName: string
  sourceExternalArticleId?: string | null
  sourceResolutionId: string
  sourceRowId: string
  title?: string | null
}

export type ComparisonProjectConflictResolutionImportTargetArticle = {
  articleId: string
  arxivId?: string | null
  doi?: string | null
  doiKeys?: readonly (string | null | undefined)[] | null
  externalArticleId?: string | null
  hasExistingResolution?: boolean
  identifierKeys?: readonly (string | null | undefined)[] | null
  identifiers?: readonly ComparisonProjectConflictResolutionImportIdentifier[] | null
  legacyDoi?: string | null
  isConflictResolutionEligible: boolean
  pubmedId?: string | null
  title?: string | null
}

export type ComparisonProjectConflictResolutionImportMode = 'all-matched' | 'conflicting-only'

export type ComparisonProjectConflictResolutionImportTargetArticleQueryRow = Omit<
  ComparisonProjectConflictResolutionImportTargetArticle,
  'isConflictResolutionEligible'
>

export type ComparisonProjectConflictResolutionImportCandidateSource = {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  sourceRowId: string
}

export type ComparisonProjectConflictResolutionImportCandidate = {
  resolutionValue: string
  sourceRows: ComparisonProjectConflictResolutionImportCandidateSource[]
  targetArticleId: string
}

export type ComparisonProjectConflictResolutionImportSkipReason =
  | 'ambiguous-target-match'
  | 'conflicting-identifiers'
  | 'conflicting-resolution-values'
  | 'existing-target-resolution'
  | 'invalid-target-resolution-value'
  | 'no-usable-key'
  | 'no-target-match'
  | 'not-conflicting'
  | 'unsupported-mode'

export type ComparisonProjectConflictResolutionImportSkippedRow = {
  reason: ComparisonProjectConflictResolutionImportSkipReason
  sourceRowId: string
}

export type ComparisonProjectConflictResolutionImportSkipCounts = {
  ambiguousTarget: number
  conflictingIdentifiers: number
  conflicting: number
  existingTargetResolution: number
  invalidValue: number
  noTargetMatch: number
  noUsableKey: number
  notConflicting: number
  unsupportedMode: number
}

export type ComparisonProjectConflictResolutionImportErrorCode =
  | 'duplicate-source-doi-key'
  | 'duplicate-source-id-title-key'
  | 'conflicting-source-resolution-values'
  | 'invalid-source-resolution-value'

export type ComparisonProjectConflictResolutionImportError = {
  code: ComparisonProjectConflictResolutionImportErrorCode
  key?: string
  message: string
  sourceRowIds?: string[]
  targetArticleId?: string
  targetArticleIds?: string[]
  value?: string
  values?: string[]
}

export type ComparisonProjectConflictResolutionImportWarningCode =
  | 'ambiguous-target-match'
  | 'conflicting-identifiers'
  | 'conflicting-resolution-values'
  | 'invalid-target-resolution-value'

export type ComparisonProjectConflictResolutionImportWarningSourceRow = {
  articleId: string
  articleTitle: string | null
  compareProjectId: string
  compareProjectName: string
  externalArticleId: string | null
  resolutionAnswer: string
  sourceResolutionId: string
  sourceRowId: string
}

export type ComparisonProjectConflictResolutionImportWarningTargetArticle = {
  articleId: string
  articleTitle: string | null
  doiKeys: string[]
  externalArticleId: string | null
  identifierKeys: string[]
}

export type ComparisonProjectConflictResolutionImportWarning = {
  code: ComparisonProjectConflictResolutionImportWarningCode
  matchKey?: string
  matchKeys?: string[]
  matchKind?: ComparisonProjectConflictResolutionImportMatchKind
  matchKinds?: ComparisonProjectConflictResolutionImportMatchKind[]
  message: string
  sourceRows: ComparisonProjectConflictResolutionImportWarningSourceRow[]
  targetArticles: ComparisonProjectConflictResolutionImportWarningTargetArticle[]
  value?: string
  values?: string[]
}

export type ComparisonProjectConflictResolutionImportPlan = {
  candidates: ComparisonProjectConflictResolutionImportCandidate[]
  dedupedCount: number
  errors: ComparisonProjectConflictResolutionImportError[]
  skipCounts: ComparisonProjectConflictResolutionImportSkipCounts
  skippedRows: ComparisonProjectConflictResolutionImportSkippedRow[]
  warnings: ComparisonProjectConflictResolutionImportWarning[]
}

export type ComparisonProjectConflictResolutionImportPlanParams = {
  importMode?: ComparisonProjectConflictResolutionImportMode
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
  targetArticles: readonly ComparisonProjectConflictResolutionImportTargetArticle[]
  targetSummaryOptionValues: readonly string[]
}

export type ComparisonProjectConflictResolutionImportSummary = {
  deduped: number
  scanned: number
  matched: number
  imported: number
  skipped: number
  skippedAmbiguousTarget: number
  skippedConflictingIdentifiers: number
  skippedConflicting: number
  skippedExistingTargetResolution: number
  skippedInvalidValue: number
  skippedNoTargetMatch: number
  skippedNoUsableKey: number
  skippedNotConflicting: number
  skippedUnsupportedMode: number
  warnings: ComparisonProjectConflictResolutionImportWarning[]
}

export type ComparisonProjectConflictResolutionImportAnalyzeSource = {
  comparisonProjectId: string
  comparisonProjectName: string
  comparisonProjectDescription: string | null
  exportedAt: string
  format: string
  version: number
  rowCount: number
}

export type ComparisonProjectConflictResolutionImportAnalyzeSummary = {
  scanned: number
  matched: number
  importable: number
  deduped: number
  skipped: number
  skippedExisting: number
  skippedUnsupportedMode: number
  skippedNoUsableKey: number
  skippedNoTargetMatch: number
  skippedNotConflicting: number
  skippedAmbiguousTarget: number
  skippedConflicting: number
  skippedInvalidValue: number
}

export type ComparisonProjectConflictResolutionImportAnalyzeRowReason =
  | 'importable'
  | ComparisonProjectConflictResolutionImportSkipReason

export type ComparisonProjectConflictResolutionImportAnalyzeRow = {
  sourceTitle: string | null
  sourceArticleRowId: string
  sourceExternalArticleId: string | null
  sourceResolutionId: string
  sourceComparisonProjectId: string
  sourceComparisonProjectName: string
  targetTitle: string | null
  targetArticleId: string | null
  targetArticleIds: string[]
  targetExternalArticleId: string | null
  targetExternalArticleIds: string[]
  selectedResolution: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind | null
  matchKey: string | null
  reason: ComparisonProjectConflictResolutionImportAnalyzeRowReason
}

export type ComparisonProjectConflictResolutionImportAnalyzeResult = {
  source: ComparisonProjectConflictResolutionImportAnalyzeSource
  summary: ComparisonProjectConflictResolutionImportAnalyzeSummary
  importableRows: ComparisonProjectConflictResolutionImportAnalyzeRow[]
  skippedRows: ComparisonProjectConflictResolutionImportAnalyzeRow[]
  warnings: ComparisonProjectConflictResolutionImportWarning[]
}

export type ComparisonProjectConflictResolutionImportCommitSummary =
  ComparisonProjectConflictResolutionImportAnalyzeSummary & {inserted: number}

export type ComparisonProjectConflictResolutionImportCommitResult = Omit<
  ComparisonProjectConflictResolutionImportAnalyzeResult,
  'summary'
> & {summary: ComparisonProjectConflictResolutionImportCommitSummary}

type NormalizedSourceRow = Omit<
  ComparisonProjectConflictResolutionImportSourceRow,
  'doiKeys' | 'identifierKeys' | 'resolutionMode'
> & {
  doiKeys: string[]
  identifierKeys: NormalizedIdentifierKey[]
  idTitleKey: string | null
  resolutionMode: HumanJudgmentMode
  resolutionValue: string
  titleKey: string | null
}

type NormalizedTargetArticle = Omit<
  ComparisonProjectConflictResolutionImportTargetArticle,
  'doiKeys' | 'identifierKeys'
> & {doiKeys: string[]; identifierKeys: NormalizedIdentifierKey[]; idTitleKey: string | null; titleKey: string | null}

type ImportCandidateRow = {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  resolutionValue: string
  sourceRow: NormalizedSourceRow
  sourceRowId: string
  targetArticle: NormalizedTargetArticle
  targetArticleId: string
}

type ImportTargetArticleMatch = {
  identifierKey?: NormalizedIdentifierKey
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  targetArticle: NormalizedTargetArticle
}

type ImportCandidateRowResult = {
  candidate: ImportCandidateRow | null
  detail: ImportRowMatchDetail | null
  skippedRow: ComparisonProjectConflictResolutionImportSkippedRow | null
  warnings: ComparisonProjectConflictResolutionImportWarning[]
}

type ImportRowMatchDetail = {
  matchKey: string | null
  matchKind: ComparisonProjectConflictResolutionImportMatchKind | null
  sourceRow: NormalizedSourceRow
  targetArticles: NormalizedTargetArticle[]
}

const doiPrefixPattern = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i
const idTitleKeySeparator = '\u001F'
const identifierKeySeparator = '\u001F'
const strongIdentifierKinds = ['doi', 'pmid', 'arxiv'] as const satisfies ArticleStrongIdentifierKind[]
const sourceIdentifierTierOrder = ['doi', 'canonical', 'legacy'] as const

type SourceIdentifierTier = (typeof sourceIdentifierTierOrder)[number]

type NormalizedIdentifierKey = {
  key: string
  kind: ArticleStrongIdentifierKind
  matchKey: string
  normalizedValue: string
  tier?: SourceIdentifierTier
}

const getInClause = (values: string[]) => {
  return getQuotedStringList(values).join(', ')
}

const getWhereClause = (conditions: Array<string | null | undefined>) => {
  const filteredConditions = conditions.filter((condition): condition is string => {
    return Boolean(condition)
  })
  return filteredConditions.length > 0 ? `WHERE ${filteredConditions.join('\n  AND ')}` : ''
}

const getComparisonProjectConflictResolutionImportTitleKeySql = (column: string) => {
  return `regexp_replace(LOWER(TRIM(COALESCE(${column}, ''))), '\\s+', ' ', 'g')`
}

const getComparisonProjectConflictResolutionImportIdTitleKeySql = (params: {
  externalArticleIdColumn: string
  titleColumn: string
}) => {
  return `LOWER(TRIM(COALESCE(${params.externalArticleIdColumn}, ''))) || ${getSqlLiteral(idTitleKeySeparator)} || ${getComparisonProjectConflictResolutionImportTitleKeySql(params.titleColumn)}`
}

const getComparisonProjectConflictResolutionImportDoiIdentifierValueSql = (column: string) => {
  return `regexp_replace(LOWER(TRIM(COALESCE(${column}, ''))), '^(https?://(dx\\.)?doi\\.org/|doi:\\s*)', '')`
}

const getComparisonProjectConflictResolutionImportPmidIdentifierValueSql = (column: string) => {
  return `regexp_replace(regexp_replace(LOWER(TRIM(COALESCE(${column}, ''))), '^(pmid:|pubmed:)', ''), '^0+', '')`
}

const getComparisonProjectConflictResolutionImportArxivIdentifierValueSql = (column: string) => {
  return `regexp_replace(regexp_replace(regexp_replace(LOWER(TRIM(COALESCE(${column}, ''))), '^(https?://(www\\.)?arxiv\\.org/(abs|pdf)/|oai:arxiv\\.org:|arxiv:)', ''), '\\.pdf$', ''), 'v[0-9]+$', '')`
}

const getComparisonProjectConflictResolutionImportTargetIdentifierCtesSql = (params: {
  articleIdentifierTable: string
  articleTable: string
}) => {
  const legacyDoiSql = getComparisonProjectConflictResolutionImportDoiIdentifierValueSql('legacy_article.doi')
  const legacyPmidSql = getComparisonProjectConflictResolutionImportPmidIdentifierValueSql('legacy_article.pubmed_id')
  const legacyArxivSql = getComparisonProjectConflictResolutionImportArxivIdentifierValueSql('legacy_article.arxiv_id')

  return `
    canonical_identifier AS (
      SELECT
        article_id AS articleId,
        kind,
        normalized_value AS normalizedValue
      FROM ${params.articleIdentifierTable}
      WHERE kind IN ('doi', 'pmid', 'arxiv')
    ),
    legacy_identifier AS (
      SELECT
        legacy_article.id AS articleId,
        'doi' AS kind,
        ${legacyDoiSql} AS normalizedValue
      FROM ${params.articleTable} legacy_article
      WHERE ${legacyDoiSql} <> ''
      UNION ALL
      SELECT
        legacy_article.id AS articleId,
        'pmid' AS kind,
        ${legacyPmidSql} AS normalizedValue
      FROM ${params.articleTable} legacy_article
      WHERE ${legacyPmidSql} <> ''
      UNION ALL
      SELECT
        legacy_article.id AS articleId,
        'arxiv' AS kind,
        ${legacyArxivSql} AS normalizedValue
      FROM ${params.articleTable} legacy_article
      WHERE ${legacyArxivSql} <> ''
    ),
    target_identifier AS (
      SELECT articleId, kind, normalizedValue FROM canonical_identifier
      UNION
      SELECT articleId, kind, normalizedValue FROM legacy_identifier
    )
  `
}

export const getComparisonProjectConflictResolutionImportSourcesSql = (params: {
  comparisonProjectConflictResolutionTable: string
  comparisonProjectTable: string
}) => {
  return `
    SELECT
      cp.id AS id,
      cp.name AS name,
      cp.description AS description,
      cp.created_at AS createdAt,
      cp.human_judgment_mode AS humanJudgmentMode,
      COUNT(cr.article_id) AS resolutionCount
    FROM ${params.comparisonProjectTable} cp
    INNER JOIN ${params.comparisonProjectConflictResolutionTable} cr
      ON cr.comparison_project_id = cp.id
    WHERE cp.archived = FALSE
      AND cp.allow_conflict_resolution = TRUE
      AND cp.human_judgment_mode = 'summary'
    GROUP BY
      cp.id,
      cp.name,
      cp.description,
      cp.created_at,
      cp.human_judgment_mode
    ORDER BY cp.created_at DESC, cp.name ASC, cp.id ASC
  `
}

export const getComparisonProjectConflictResolutionImportSourceRowsSql = (params: {
  articleIdentifierTable: string
  articleTable: string
  comparisonProjectTable: string
  comparisonProjectConflictResolutionTable: string
  sourceComparisonProjectIds: string[]
}) => {
  return `
    WITH source_resolution AS (
      SELECT
        cr.comparison_project_id AS sourceComparisonProjectId,
        cr.id AS sourceResolutionId,
        cr.id AS sourceRowId,
        cr.article_id AS sourceArticleId,
        COALESCE(cr.answer_value, cr.prompt_id, '') AS resolutionValue
      FROM ${params.comparisonProjectConflictResolutionTable} cr
      ${params.sourceComparisonProjectIds.length > 0 ? `WHERE cr.comparison_project_id IN (${getInClause(params.sourceComparisonProjectIds)})` : 'WHERE FALSE'}
    ),
    doi_identifier AS (
      SELECT
        article_id AS articleId,
        LIST(DISTINCT normalized_value ORDER BY normalized_value) AS doiKeys
      FROM ${params.articleIdentifierTable}
      WHERE kind = 'doi'
      GROUP BY article_id
    ),
    strong_identifier AS (
      SELECT
        article_id AS articleId,
        LIST(DISTINCT kind || ${getSqlLiteral(identifierKeySeparator)} || normalized_value ORDER BY kind || ${getSqlLiteral(identifierKeySeparator)} || normalized_value) AS identifierKeys
      FROM ${params.articleIdentifierTable}
      WHERE kind IN ('doi', 'pmid', 'arxiv')
      GROUP BY article_id
    )
    SELECT
      source_resolution.sourceComparisonProjectId AS sourceComparisonProjectId,
      source_comparison_project.name AS sourceComparisonProjectName,
      source_resolution.sourceResolutionId AS sourceResolutionId,
      source_resolution.sourceRowId AS sourceRowId,
      source_resolution.sourceArticleId AS sourceArticleId,
      source_article.article_id AS sourceExternalArticleId,
      source_article.article_title AS sourceArticleTitle,
      source_resolution.resolutionValue AS resolutionValue,
      'summary' AS resolutionMode,
      doi_identifier.doiKeys AS doiKeys,
      strong_identifier.identifierKeys AS identifierKeys,
      source_article.doi AS doi,
      source_article.pubmed_id AS pubmedId,
      source_article.arxiv_id AS arxivId,
      source_article.article_id AS externalArticleId,
      source_article.article_title AS title
    FROM source_resolution
    INNER JOIN ${params.comparisonProjectTable} source_comparison_project
      ON source_comparison_project.id = source_resolution.sourceComparisonProjectId
    INNER JOIN ${params.articleTable} source_article ON source_article.id = source_resolution.sourceArticleId
    LEFT JOIN doi_identifier ON doi_identifier.articleId = source_article.id
    LEFT JOIN strong_identifier ON strong_identifier.articleId = source_article.id
    ORDER BY source_resolution.sourceRowId ASC
  `
}

export const getComparisonProjectConflictResolutionImportDoiTargetArticlesSql = (params: {
  articleIdentifierTable: string
  articleScopeConditions: readonly string[]
  articleTable: string
  doiKeys: string[]
}) => {
  return `
    SELECT
      a.id AS articleId,
      MIN(doi_identifier.normalized_value) AS doi,
      LIST(DISTINCT doi_identifier.normalized_value ORDER BY doi_identifier.normalized_value) AS doiKeys,
      a.article_id AS externalArticleId,
      a.article_title AS title
    FROM ${params.articleIdentifierTable} doi_identifier
    INNER JOIN ${params.articleTable} a ON a.id = doi_identifier.article_id
    ${getWhereClause([
      ...params.articleScopeConditions,
      "doi_identifier.kind = 'doi'",
      params.doiKeys.length > 0 ? `doi_identifier.normalized_value IN (${getInClause(params.doiKeys)})` : 'FALSE',
    ])}
    GROUP BY a.id, a.article_id, a.article_title
    ORDER BY a.id ASC
  `
}

export const getComparisonProjectConflictResolutionImportIdentifierTargetArticlesSql = (params: {
  articleIdentifierTable: string
  articleScopeConditions: readonly string[]
  articleTable: string
  identifierKeys: string[]
}) => {
  const identifierKeySql = `strong_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || strong_identifier.normalizedValue`
  const matchedIdentifierKeySql = `target_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || target_identifier.normalizedValue`

  return `
    WITH ${getComparisonProjectConflictResolutionImportTargetIdentifierCtesSql({
      articleIdentifierTable: params.articleIdentifierTable,
      articleTable: params.articleTable,
    })},
    matched_article AS (
      SELECT DISTINCT target_identifier.articleId AS articleId
      FROM target_identifier
      WHERE target_identifier.kind IN ('doi', 'pmid', 'arxiv')
        AND ${matchedIdentifierKeySql} IN (${params.identifierKeys.length > 0 ? getInClause(params.identifierKeys) : 'NULL'})
    )
    SELECT
      a.id AS articleId,
      MIN(CASE WHEN strong_identifier.kind = 'doi' THEN strong_identifier.normalizedValue ELSE NULL END) AS doi,
      LIST(DISTINCT ${identifierKeySql} ORDER BY ${identifierKeySql}) FILTER (WHERE strong_identifier.kind IS NOT NULL) AS identifierKeys,
      a.doi AS legacyDoi,
      a.pubmed_id AS pubmedId,
      a.arxiv_id AS arxivId,
      a.article_id AS externalArticleId,
      a.article_title AS title
    FROM matched_article
    INNER JOIN ${params.articleTable} a ON a.id = matched_article.articleId
    LEFT JOIN target_identifier strong_identifier
      ON strong_identifier.articleId = a.id
    ${getWhereClause(params.articleScopeConditions)}
    GROUP BY a.id, a.doi, a.pubmed_id, a.arxiv_id, a.article_id, a.article_title
    ORDER BY a.id ASC
  `
}

export const getComparisonProjectConflictResolutionImportArticleIdTargetArticlesSql = (params: {
  articleIds: string[]
  articleIdentifierTable: string
  articleScopeConditions: readonly string[]
  articleTable: string
}) => {
  const identifierKeySql = `strong_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || strong_identifier.normalized_value`

  return `
    SELECT
      a.id AS articleId,
      MIN(CASE WHEN strong_identifier.kind = 'doi' THEN strong_identifier.normalized_value ELSE NULL END) AS doi,
      LIST(DISTINCT ${identifierKeySql} ORDER BY ${identifierKeySql}) FILTER (WHERE strong_identifier.kind IS NOT NULL) AS identifierKeys,
      a.doi AS legacyDoi,
      a.pubmed_id AS pubmedId,
      a.arxiv_id AS arxivId,
      a.article_id AS externalArticleId,
      a.article_title AS title
    FROM ${params.articleTable} a
    LEFT JOIN ${params.articleIdentifierTable} strong_identifier
      ON strong_identifier.article_id = a.id
      AND strong_identifier.kind IN ('doi', 'pmid', 'arxiv')
    ${getWhereClause([
      ...params.articleScopeConditions,
      params.articleIds.length > 0 ? `a.id IN (${getInClause(params.articleIds)})` : 'FALSE',
    ])}
    GROUP BY a.id, a.doi, a.pubmed_id, a.arxiv_id, a.article_id, a.article_title
    ORDER BY a.id ASC
  `
}

const getComparisonProjectConflictResolutionImportServingIdentifierListSql = () => {
  const identifierKeySql = `strong_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || strong_identifier.normalized_value`

  return `LIST(DISTINCT ${identifierKeySql} ORDER BY ${identifierKeySql}) FILTER (WHERE strong_identifier.kind IS NOT NULL) AS identifierKeys`
}

const getComparisonProjectConflictResolutionImportServingArticleSelectSql = () => {
  return `
      a.article_id AS articleId,
      MIN(CASE WHEN strong_identifier.kind = 'doi' THEN strong_identifier.normalized_value ELSE NULL END) AS doi,
      ${getComparisonProjectConflictResolutionImportServingIdentifierListSql()},
      a.doi AS legacyDoi,
      a.pubmed_id AS pubmedId,
      a.arxiv_id AS arxivId,
      a.article_external_id AS externalArticleId,
      a.article_title AS title
  `
}

const getComparisonProjectConflictResolutionImportServingGroupBySql = () => {
  return `
      a.article_id,
      a.doi,
      a.pubmed_id,
      a.arxiv_id,
      a.article_external_id,
      a.article_title
  `
}

const getComparisonProjectConflictResolutionImportServingArticleJoinSql = (params: {
  comparisonProjectId: string
  generation: number
}) => {
  return `
    LEFT JOIN mart.comparison_article_identifier_serving strong_identifier
      ON strong_identifier.comparison_project_id = a.comparison_project_id
     AND strong_identifier.generation = a.generation
     AND strong_identifier.article_id = a.article_id
     AND strong_identifier.kind IN ('doi', 'pmid', 'arxiv')
    WHERE a.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND a.generation = ${getSqlLiteral(params.generation)}
  `
}

export const getComparisonProjectConflictResolutionImportServingArticleIdTargetArticlesSql = (params: {
  articleIds: string[]
  comparisonProjectId: string
  generation: number
}) => {
  return `
    SELECT
${getComparisonProjectConflictResolutionImportServingArticleSelectSql()}
    FROM mart.comparison_article_serving a
${getComparisonProjectConflictResolutionImportServingArticleJoinSql(params)}
      AND ${params.articleIds.length > 0 ? `a.article_id IN (${getInClause(params.articleIds)})` : 'FALSE'}
    GROUP BY ${getComparisonProjectConflictResolutionImportServingGroupBySql()}
    ORDER BY a.article_id ASC
  `
}

export const getComparisonProjectConflictResolutionImportServingIdentifierTargetArticlesSql = (params: {
  comparisonProjectId: string
  generation: number
  identifierKeys: string[]
}) => {
  const identifierKeySql = `matched_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || matched_identifier.normalized_value`
  const legacyDoiSql = getComparisonProjectConflictResolutionImportDoiIdentifierValueSql('legacy_article.doi')
  const legacyPmidSql = getComparisonProjectConflictResolutionImportPmidIdentifierValueSql('legacy_article.pubmed_id')
  const legacyArxivSql = getComparisonProjectConflictResolutionImportArxivIdentifierValueSql('legacy_article.arxiv_id')
  const legacyIdentifierKeySql = `legacy_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || legacy_identifier.normalizedValue`
  const identifierFilterSql =
    params.identifierKeys.length > 0 ? `IN (${getInClause(params.identifierKeys)})` : 'IN (NULL)'

  return `
    WITH legacy_identifier AS (
      SELECT
        legacy_article.article_id AS articleId,
        'doi' AS kind,
        ${legacyDoiSql} AS normalizedValue
      FROM mart.comparison_article_serving legacy_article
      WHERE legacy_article.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND legacy_article.generation = ${getSqlLiteral(params.generation)}
        AND ${legacyDoiSql} <> ''
      UNION ALL
      SELECT
        legacy_article.article_id AS articleId,
        'pmid' AS kind,
        ${legacyPmidSql} AS normalizedValue
      FROM mart.comparison_article_serving legacy_article
      WHERE legacy_article.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND legacy_article.generation = ${getSqlLiteral(params.generation)}
        AND ${legacyPmidSql} <> ''
      UNION ALL
      SELECT
        legacy_article.article_id AS articleId,
        'arxiv' AS kind,
        ${legacyArxivSql} AS normalizedValue
      FROM mart.comparison_article_serving legacy_article
      WHERE legacy_article.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND legacy_article.generation = ${getSqlLiteral(params.generation)}
        AND ${legacyArxivSql} <> ''
    ),
    matched_article AS (
      SELECT DISTINCT matched_identifier.article_id AS articleId
      FROM mart.comparison_article_identifier_serving matched_identifier
      WHERE matched_identifier.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND matched_identifier.generation = ${getSqlLiteral(params.generation)}
        AND matched_identifier.kind IN ('doi', 'pmid', 'arxiv')
        AND ${identifierKeySql} ${identifierFilterSql}
      UNION
      SELECT DISTINCT legacy_identifier.articleId
      FROM legacy_identifier
      WHERE ${legacyIdentifierKeySql} ${identifierFilterSql}
    )
    SELECT
${getComparisonProjectConflictResolutionImportServingArticleSelectSql()}
    FROM matched_article
    INNER JOIN mart.comparison_article_serving a
      ON a.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
     AND a.generation = ${getSqlLiteral(params.generation)}
     AND a.article_id = matched_article.articleId
${getComparisonProjectConflictResolutionImportServingArticleJoinSql(params)}
    GROUP BY ${getComparisonProjectConflictResolutionImportServingGroupBySql()}
    ORDER BY a.article_id ASC
  `
}

export const getComparisonProjectConflictResolutionImportServingIdTitleTargetArticlesSql = (params: {
  comparisonProjectId: string
  generation: number
  idTitleKeys: string[]
}) => {
  const idTitleKeySql = getComparisonProjectConflictResolutionImportIdTitleKeySql({
    externalArticleIdColumn: 'a.article_external_id',
    titleColumn: 'a.article_title',
  })

  return `
    SELECT
${getComparisonProjectConflictResolutionImportServingArticleSelectSql()}
    FROM mart.comparison_article_serving a
${getComparisonProjectConflictResolutionImportServingArticleJoinSql(params)}
      AND ${params.idTitleKeys.length > 0 ? `${idTitleKeySql} IN (${getInClause(params.idTitleKeys)})` : 'FALSE'}
    GROUP BY ${getComparisonProjectConflictResolutionImportServingGroupBySql()}
    ORDER BY a.article_id ASC
  `
}

export const getComparisonProjectConflictResolutionImportServingTitleTargetArticlesSql = (params: {
  comparisonProjectId: string
  generation: number
  titleKeys: string[]
}) => {
  const titleKeySql = getComparisonProjectConflictResolutionImportTitleKeySql('a.article_title')

  return `
    SELECT
${getComparisonProjectConflictResolutionImportServingArticleSelectSql()}
    FROM mart.comparison_article_serving a
${getComparisonProjectConflictResolutionImportServingArticleJoinSql(params)}
      AND ${params.titleKeys.length > 0 ? `${titleKeySql} IN (${getInClause(params.titleKeys)})` : 'FALSE'}
    GROUP BY ${getComparisonProjectConflictResolutionImportServingGroupBySql()}
    ORDER BY a.article_id ASC
  `
}

export const getComparisonProjectConflictResolutionImportIdTitleTargetArticlesSql = (params: {
  articleIdentifierTable: string
  articleScopeConditions: readonly string[]
  articleTable: string
  idTitleKeys: string[]
}) => {
  const idTitleKeySql = getComparisonProjectConflictResolutionImportIdTitleKeySql({
    externalArticleIdColumn: 'a.article_id',
    titleColumn: 'a.article_title',
  })

  return `
    WITH doi_identifier AS (
      SELECT
        article_id AS articleId,
        MIN(normalized_value) AS doi
      FROM ${params.articleIdentifierTable}
      WHERE kind = 'doi'
      GROUP BY article_id
    ),
    ${getComparisonProjectConflictResolutionImportTargetIdentifierCtesSql({
      articleIdentifierTable: params.articleIdentifierTable,
      articleTable: params.articleTable,
    })}
    SELECT
      a.id AS articleId,
      doi_identifier.doi AS doi,
      LIST(DISTINCT strong_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || strong_identifier.normalizedValue ORDER BY strong_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || strong_identifier.normalizedValue) FILTER (WHERE strong_identifier.kind IS NOT NULL) AS identifierKeys,
      a.doi AS legacyDoi,
      a.pubmed_id AS pubmedId,
      a.arxiv_id AS arxivId,
      a.article_id AS externalArticleId,
      a.article_title AS title
    FROM ${params.articleTable} a
    LEFT JOIN doi_identifier ON doi_identifier.articleId = a.id
    LEFT JOIN target_identifier strong_identifier ON strong_identifier.articleId = a.id
    ${getWhereClause([
      ...params.articleScopeConditions,
      params.idTitleKeys.length > 0 ? `${idTitleKeySql} IN (${getInClause(params.idTitleKeys)})` : 'FALSE',
    ])}
    GROUP BY a.id, doi_identifier.doi, a.doi, a.pubmed_id, a.arxiv_id, a.article_id, a.article_title
    ORDER BY a.id ASC
  `
}

export const getComparisonProjectConflictResolutionImportTitleTargetArticlesSql = (params: {
  articleIdentifierTable: string
  articleScopeConditions: readonly string[]
  articleTable: string
  titleKeys: string[]
}) => {
  const titleKeySql = getComparisonProjectConflictResolutionImportTitleKeySql('a.article_title')

  return `
    WITH doi_identifier AS (
      SELECT
        article_id AS articleId,
        MIN(normalized_value) AS doi
      FROM ${params.articleIdentifierTable}
      WHERE kind = 'doi'
      GROUP BY article_id
    ),
    ${getComparisonProjectConflictResolutionImportTargetIdentifierCtesSql({
      articleIdentifierTable: params.articleIdentifierTable,
      articleTable: params.articleTable,
    })}
    SELECT
      a.id AS articleId,
      doi_identifier.doi AS doi,
      LIST(DISTINCT strong_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || strong_identifier.normalizedValue ORDER BY strong_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || strong_identifier.normalizedValue) FILTER (WHERE strong_identifier.kind IS NOT NULL) AS identifierKeys,
      a.doi AS legacyDoi,
      a.pubmed_id AS pubmedId,
      a.arxiv_id AS arxivId,
      a.article_id AS externalArticleId,
      a.article_title AS title
    FROM ${params.articleTable} a
    LEFT JOIN doi_identifier ON doi_identifier.articleId = a.id
    LEFT JOIN target_identifier strong_identifier ON strong_identifier.articleId = a.id
    ${getWhereClause([
      ...params.articleScopeConditions,
      params.titleKeys.length > 0 ? `${titleKeySql} IN (${getInClause(params.titleKeys)})` : 'FALSE',
    ])}
    GROUP BY a.id, doi_identifier.doi, a.doi, a.pubmed_id, a.arxiv_id, a.article_id, a.article_title
    ORDER BY a.id ASC
  `
}

export const getComparisonProjectConflictResolutionImportSourceValue = (
  row: ComparisonProjectConflictResolutionImportSourceQueryRow,
): ComparisonProjectConflictResolutionImportSource => {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: getDateValue(row.createdAt) ?? new Date(0),
    humanJudgmentMode: row.humanJudgmentMode ?? 'prompt',
    resolutionCount: Number(row.resolutionCount ?? 0),
  }
}

export const getComparisonProjectConflictResolutionImportSourceRowsFromTransferRows = (params: {
  rows: readonly ComparisonProjectConflictResolutionTransferRowV1[]
  sourceComparisonProjectId: string
  sourceComparisonProjectName: string
}): ComparisonProjectConflictResolutionImportSourceRow[] => {
  return params.rows.map((row, rowIndex) => {
    const generatedSourceRowId = `${params.sourceComparisonProjectId}:transfer-row-${String(rowIndex + 1).padStart(6, '0')}`
    const sourceArticleId = row.sourceArticleRowId ?? `${generatedSourceRowId}:article`
    const sourceResolutionId = row.sourceResolutionId ?? `${generatedSourceRowId}:resolution`

    return {
      arxivId: row.arxivId ?? null,
      doi: row.doi ?? null,
      externalArticleId: row.externalArticleId,
      identifiers: row.identifiers.map((identifier) => {
        return {kind: identifier.kind, normalizedValue: identifier.normalizedValue}
      }),
      pubmedId: row.pubmedId ?? null,
      resolutionMode: row.resolution.mode,
      resolutionValue: row.resolution.value,
      sourceArticleId,
      sourceArticleTitle: row.title,
      sourceComparisonProjectId: params.sourceComparisonProjectId,
      sourceComparisonProjectName: params.sourceComparisonProjectName,
      sourceExternalArticleId: row.externalArticleId,
      sourceResolutionId,
      sourceRowId: sourceResolutionId,
      title: row.title,
    }
  })
}

export const getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact = (
  artifact: ComparisonProjectConflictResolutionTransferArtifactV1,
): ComparisonProjectConflictResolutionImportSourceRow[] => {
  return getComparisonProjectConflictResolutionImportSourceRowsFromTransferRows({
    rows: artifact.rows,
    sourceComparisonProjectId: artifact.source.comparisonProjectId,
    sourceComparisonProjectName: artifact.source.comparisonProjectName,
  })
}

const getTrimmedText = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''
  return trimmedValue.length > 0 ? trimmedValue : null
}

const getNormalizedResolutionValue = (value: string) => {
  return value.trim()
}

const getStrongIdentifierKind = (value: string | null | undefined) => {
  const normalizedValue = getTrimmedText(value)?.toLowerCase()

  return normalizedValue && strongIdentifierKinds.includes(normalizedValue as ArticleStrongIdentifierKind)
    ? (normalizedValue as ArticleStrongIdentifierKind)
    : null
}

const getIdentifierKeyValue = (identifier: ComparisonProjectConflictResolutionImportIdentifier) => {
  return `${identifier.kind}${identifierKeySeparator}${identifier.normalizedValue}`
}

const getIdentifierMatchKey = (identifier: ComparisonProjectConflictResolutionImportIdentifier) => {
  return identifier.kind === 'doi' ? identifier.normalizedValue : `${identifier.kind}:${identifier.normalizedValue}`
}

const getIdentifierKeyParts = (
  value: string | null | undefined,
): ComparisonProjectConflictResolutionImportIdentifier | null => {
  const trimmedValue = getTrimmedText(value)
  const [kindValue, normalizedValue, ...extraValues] = trimmedValue?.split(identifierKeySeparator) ?? []
  const kind = getStrongIdentifierKind(kindValue)
  const normalizedIdentifierValue = getTrimmedText(normalizedValue)

  return kind && normalizedIdentifierValue && extraValues.length === 0
    ? {kind, normalizedValue: normalizedIdentifierValue}
    : null
}

const getNormalizedIdentifierKey = (params: {
  kind: ArticleStrongIdentifierKind
  source: string
  tier?: SourceIdentifierTier
  value: string | null | undefined
}): NormalizedIdentifierKey | null => {
  const normalizedIdentifiers = normalizeSourceRowIdentifiers([
    {inputKind: params.kind, source: params.source, value: params.value},
  ]).strongIdentifiers
  const identifier = normalizedIdentifiers[0]

  return identifier
    ? {
        key: getIdentifierKeyValue(identifier),
        kind: identifier.kind,
        matchKey: getIdentifierMatchKey(identifier),
        normalizedValue: identifier.normalizedValue,
        ...(params.tier ? {tier: params.tier} : {}),
      }
    : null
}

const getNormalizedIdentifierKeyFromParts = (params: {
  identifier: ComparisonProjectConflictResolutionImportIdentifier
  source: string
  tier?: SourceIdentifierTier
}) => {
  return getNormalizedIdentifierKey({
    kind: params.identifier.kind,
    source: params.source,
    tier: params.tier,
    value: params.identifier.normalizedValue,
  })
}

const getUniqueNormalizedIdentifierKeys = (identifierKeys: readonly NormalizedIdentifierKey[]) => {
  return Array.from(
    identifierKeys
      .reduce<Map<string, NormalizedIdentifierKey>>((identifierMap, identifier) => {
        return identifierMap.has(identifier.key) ? identifierMap : identifierMap.set(identifier.key, identifier)
      }, new Map<string, NormalizedIdentifierKey>())
      .values(),
  )
}

const getCanonicalIdentifierTier = (kind: ArticleStrongIdentifierKind): SourceIdentifierTier => {
  return kind === 'doi' ? 'doi' : 'canonical'
}

const getIdentifierKeysFromCanonicalPairs = (
  identifiers: readonly ComparisonProjectConflictResolutionImportIdentifier[] | null | undefined,
) => {
  return (identifiers ?? []).flatMap((identifier) => {
    const tier = getCanonicalIdentifierTier(identifier.kind)
    const identifierKey = getNormalizedIdentifierKeyFromParts({identifier, source: 'article_identifier', tier})

    return identifierKey ? [identifierKey] : []
  })
}

const getIdentifierKeysFromCanonicalKeyValues = (
  identifierKeys: readonly (string | null | undefined)[] | null | undefined,
) => {
  return (identifierKeys ?? []).flatMap((value) => {
    const identifier = getIdentifierKeyParts(value)
    const tier = identifier ? getCanonicalIdentifierTier(identifier.kind) : null
    const identifierKey =
      identifier && tier ? getNormalizedIdentifierKeyFromParts({identifier, source: 'article_identifier', tier}) : null

    return identifierKey ? [identifierKey] : []
  })
}

const getIdentifierKeysFromDoiValues = (values: readonly (string | null | undefined)[]) => {
  return values.flatMap((value) => {
    const identifierKey = getNormalizedIdentifierKey({kind: 'doi', source: 'doi', tier: 'doi', value})

    return identifierKey ? [identifierKey] : []
  })
}

const getIdentifierKeysFromLegacyFields = (params: {
  arxivId?: string | null
  doi?: string | null
  legacyDoi?: string | null
  pubmedId?: string | null
}) => {
  return [
    ...getIdentifierKeysFromDoiValues([params.doi, params.legacyDoi]),
    getNormalizedIdentifierKey({kind: 'pmid', source: 'pubmed_id', tier: 'legacy', value: params.pubmedId}),
    getNormalizedIdentifierKey({kind: 'arxiv', source: 'arxiv_id', tier: 'legacy', value: params.arxivId}),
  ].filter((identifierKey): identifierKey is NormalizedIdentifierKey => {
    return identifierKey !== null
  })
}

const getNormalizedIdentifierKeys = (row: {
  arxivId?: string | null
  doi?: string | null
  doiKeys?: readonly (string | null | undefined)[] | null
  identifierKeys?: readonly (string | null | undefined)[] | null
  identifiers?: readonly ComparisonProjectConflictResolutionImportIdentifier[] | null
  legacyDoi?: string | null
  pubmedId?: string | null
}) => {
  return getUniqueNormalizedIdentifierKeys([
    ...getIdentifierKeysFromDoiValues(row.doiKeys ?? []),
    ...getIdentifierKeysFromCanonicalPairs(row.identifiers),
    ...getIdentifierKeysFromCanonicalKeyValues(row.identifierKeys),
    ...getIdentifierKeysFromLegacyFields(row),
  ])
}

export const normalizeComparisonProjectConflictResolutionImportDoi = (value: string | null | undefined) => {
  const trimmedValue = getTrimmedText(value)
  const normalizedValue = trimmedValue?.toLowerCase().replace(doiPrefixPattern, '').trim() ?? ''

  return normalizedValue.length > 0 ? normalizedValue : null
}

export const getComparisonProjectConflictResolutionImportDoiKeys = (row: {
  arxivId?: string | null
  doi?: string | null
  doiKeys?: readonly (string | null | undefined)[] | null
  identifierKeys?: readonly (string | null | undefined)[] | null
  identifiers?: readonly ComparisonProjectConflictResolutionImportIdentifier[] | null
  legacyDoi?: string | null
  pubmedId?: string | null
}) => {
  return getNormalizedIdentifierKeys(row)
    .filter((identifierKey) => {
      return identifierKey.kind === 'doi'
    })
    .map((identifierKey) => {
      return identifierKey.normalizedValue
    })
}

export const getComparisonProjectConflictResolutionImportIdentifierKeys = (
  row: Parameters<typeof getComparisonProjectConflictResolutionImportDoiKeys>[0],
) => {
  return getNormalizedIdentifierKeys(row).map((identifierKey) => {
    return identifierKey.key
  })
}

const mergeComparisonProjectConflictResolutionImportTargetArticleRow = (
  currentRow: ComparisonProjectConflictResolutionImportTargetArticleQueryRow,
  nextRow: ComparisonProjectConflictResolutionImportTargetArticleQueryRow,
): ComparisonProjectConflictResolutionImportTargetArticleQueryRow => {
  return {
    articleId: currentRow.articleId,
    doi: currentRow.doi ?? nextRow.doi ?? null,
    doiKeys: getUniqueStringValues([
      ...getComparisonProjectConflictResolutionImportDoiKeys(currentRow),
      ...getComparisonProjectConflictResolutionImportDoiKeys(nextRow),
    ]),
    identifierKeys: getUniqueStringValues([
      ...getNormalizedIdentifierKeys(currentRow).map((identifierKey) => {
        return identifierKey.key
      }),
      ...getNormalizedIdentifierKeys(nextRow).map((identifierKey) => {
        return identifierKey.key
      }),
    ]),
    externalArticleId: currentRow.externalArticleId ?? nextRow.externalArticleId ?? null,
    legacyDoi: currentRow.legacyDoi ?? nextRow.legacyDoi ?? null,
    pubmedId: currentRow.pubmedId ?? nextRow.pubmedId ?? null,
    arxivId: currentRow.arxivId ?? nextRow.arxivId ?? null,
    title: currentRow.title ?? nextRow.title ?? null,
  }
}

export const mergeComparisonProjectConflictResolutionImportTargetArticleRows = (
  rows: readonly ComparisonProjectConflictResolutionImportTargetArticleQueryRow[],
) => {
  return Array.from(
    rows
      .reduce<Map<string, ComparisonProjectConflictResolutionImportTargetArticleQueryRow>>((rowMap, row) => {
        const currentRow = rowMap.get(row.articleId)

        rowMap.set(
          row.articleId,
          currentRow ? mergeComparisonProjectConflictResolutionImportTargetArticleRow(currentRow, row) : row,
        )
        return rowMap
      }, new Map<string, ComparisonProjectConflictResolutionImportTargetArticleQueryRow>())
      .values(),
  )
}

export const normalizeComparisonProjectConflictResolutionImportExternalArticleId = (
  value: string | null | undefined,
) => {
  const normalizedValue = getTrimmedText(value)?.toLowerCase() ?? ''

  return normalizedValue.length > 0 ? normalizedValue : null
}

export const normalizeComparisonProjectConflictResolutionImportTitle = (value: string | null | undefined) => {
  const normalizedValue = getTrimmedText(value)?.toLowerCase().replace(/\s+/g, ' ') ?? ''

  return normalizedValue.length > 0 ? normalizedValue : null
}

export const getComparisonProjectConflictResolutionImportIdTitleKey = (params: {
  externalArticleId?: string | null
  title?: string | null
}) => {
  const externalArticleId = normalizeComparisonProjectConflictResolutionImportExternalArticleId(
    params.externalArticleId,
  )
  const title = normalizeComparisonProjectConflictResolutionImportTitle(params.title)

  return externalArticleId && title ? `${externalArticleId}${idTitleKeySeparator}${title}` : null
}

export const getComparisonProjectConflictResolutionImportTitleKey = (params: {title?: string | null}) => {
  return normalizeComparisonProjectConflictResolutionImportTitle(params.title)
}

const getNormalizedSourceRows = (
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[],
): NormalizedSourceRow[] => {
  return sourceRows.map((row) => {
    return {
      ...row,
      doiKeys: getComparisonProjectConflictResolutionImportDoiKeys(row),
      identifierKeys: getNormalizedIdentifierKeys(row),
      idTitleKey: getComparisonProjectConflictResolutionImportIdTitleKey(row),
      resolutionMode: row.resolutionMode ?? 'summary',
      resolutionValue: getNormalizedResolutionValue(row.resolutionValue),
      titleKey: getComparisonProjectConflictResolutionImportTitleKey(row),
    }
  })
}

const getNormalizedTargetArticles = (
  targetArticles: readonly ComparisonProjectConflictResolutionImportTargetArticle[],
): NormalizedTargetArticle[] => {
  return targetArticles.map((article) => {
    const doiKeys = getComparisonProjectConflictResolutionImportDoiKeys(article)

    return {
      ...article,
      doiKeys,
      identifierKeys: getNormalizedIdentifierKeys(article),
      idTitleKey: getComparisonProjectConflictResolutionImportIdTitleKey(article),
      titleKey: getComparisonProjectConflictResolutionImportTitleKey(article),
    }
  })
}

const getUniqueStringValues = (values: readonly string[]) => {
  return values.reduce<string[]>((uniqueValues, value) => {
    return uniqueValues.includes(value) ? uniqueValues : [...uniqueValues, value]
  }, [])
}

const getTargetArticleIds = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return getUniqueStringValues(
    targetArticles.map((article) => {
      return article.articleId
    }),
  )
}

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

const getTargetArticlesByTitleKey = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return getTargetArticleGroupsByKey(targetArticles, (article) => {
    return article.titleKey
  })
}

const getTargetArticlesForSourceIdentifierKeys = (
  identifierKeys: readonly NormalizedIdentifierKey[],
  targetArticlesByIdentifierKey: Map<string, NormalizedTargetArticle[]>,
) => {
  return identifierKeys.flatMap((identifierKey) => {
    return (targetArticlesByIdentifierKey.get(identifierKey.key) ?? []).map((targetArticle) => {
      return {identifierKey, matchKey: identifierKey.matchKey, matchKind: identifierKey.kind, targetArticle}
    })
  })
}

const getUniqueTargetArticleMatches = (matches: readonly ImportTargetArticleMatch[]) => {
  return Array.from(
    matches
      .reduce<Map<string, ImportTargetArticleMatch>>((matchMap, match) => {
        return matchMap.has(match.targetArticle.articleId)
          ? matchMap
          : matchMap.set(match.targetArticle.articleId, match)
      }, new Map<string, ImportTargetArticleMatch>())
      .values(),
  )
}

const getCanUseIdTitleFallbackTargetArticle = (row: NormalizedSourceRow, targetArticle: NormalizedTargetArticle) => {
  return (
    row.idTitleKey === targetArticle.idTitleKey
    && (row.identifierKeys.length === 0 || targetArticle.identifierKeys.length === 0)
  )
}

const getCanUseTitleFallbackTargetArticle = (row: NormalizedSourceRow, targetArticle: NormalizedTargetArticle) => {
  return (
    !row.idTitleKey
    && row.titleKey === targetArticle.titleKey
    && (row.identifierKeys.length === 0 || targetArticle.identifierKeys.length === 0)
  )
}

const getWarningSourceRow = (row: NormalizedSourceRow): ComparisonProjectConflictResolutionImportWarningSourceRow => {
  return {
    articleId: row.sourceArticleId,
    articleTitle: row.sourceArticleTitle ?? row.title ?? null,
    compareProjectId: row.sourceComparisonProjectId,
    compareProjectName: row.sourceComparisonProjectName,
    externalArticleId: row.sourceExternalArticleId ?? row.externalArticleId ?? null,
    resolutionAnswer: row.resolutionValue,
    sourceResolutionId: row.sourceResolutionId,
    sourceRowId: row.sourceRowId,
  }
}

const getWarningTargetArticle = (
  targetArticle: NormalizedTargetArticle,
): ComparisonProjectConflictResolutionImportWarningTargetArticle => {
  return {
    articleId: targetArticle.articleId,
    articleTitle: targetArticle.title ?? null,
    doiKeys: targetArticle.doiKeys,
    externalArticleId: targetArticle.externalArticleId ?? null,
    identifierKeys: targetArticle.identifierKeys.map((identifierKey) => {
      return identifierKey.matchKey
    }),
  }
}

const getAmbiguousTargetMatchWarning = (params: {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  sourceRow: NormalizedSourceRow
  targetArticles: readonly NormalizedTargetArticle[]
}): ComparisonProjectConflictResolutionImportWarning => {
  const targetArticleIds = getTargetArticleIds(params.targetArticles)

  return {
    code: 'ambiguous-target-match',
    matchKey: params.matchKey,
    matchKind: params.matchKind,
    message: `Source row ${params.sourceRow.sourceRowId} matched multiple eligible target articles: ${targetArticleIds.join(', ')}`,
    sourceRows: [getWarningSourceRow(params.sourceRow)],
    targetArticles: params.targetArticles.map(getWarningTargetArticle),
  }
}

const getConflictingIdentifiersWarning = (params: {
  matches: readonly ImportTargetArticleMatch[]
  sourceRow: NormalizedSourceRow
}): ComparisonProjectConflictResolutionImportWarning => {
  const matchKeys = getUniqueStringValues(
    params.matches.map((match) => {
      return match.matchKey
    }),
  )
  const matchKinds = params.matches.reduce<ComparisonProjectConflictResolutionImportMatchKind[]>(
    (matchKinds, match) => {
      return matchKinds.includes(match.matchKind) ? matchKinds : [...matchKinds, match.matchKind]
    },
    [],
  )
  const targetArticleIds = getTargetArticleIds(getTargetArticlesFromMatches(params.matches))

  return {
    code: 'conflicting-identifiers',
    matchKey: matchKeys.join(', '),
    matchKeys,
    matchKind: matchKinds[0],
    matchKinds,
    message: `Source row ${params.sourceRow.sourceRowId} identifiers point to different target articles: ${targetArticleIds.join(', ')}`,
    sourceRows: [getWarningSourceRow(params.sourceRow)],
    targetArticles: getTargetArticlesFromMatches(params.matches).map(getWarningTargetArticle),
  }
}

const getSkippedRow = (
  sourceRowId: string,
  reason: ComparisonProjectConflictResolutionImportSkipReason,
): ComparisonProjectConflictResolutionImportSkippedRow => {
  return {reason, sourceRowId}
}

const getFirstIdentifierKeyForTier = (row: NormalizedSourceRow, tier: SourceIdentifierTier) => {
  return row.identifierKeys.find((identifierKey) => {
    return identifierKey.tier === tier
  })
}

const getPreferredSourceRowMatchDetail = (row: NormalizedSourceRow): ImportRowMatchDetail => {
  const identifierKey =
    sourceIdentifierTierOrder.reduce<NormalizedIdentifierKey | null>((selectedIdentifierKey, tier) => {
      return selectedIdentifierKey ?? getFirstIdentifierKeyForTier(row, tier) ?? null
    }, null) ?? row.identifierKeys[0]

  return identifierKey
    ? {matchKey: identifierKey.matchKey, matchKind: identifierKey.kind, sourceRow: row, targetArticles: []}
    : row.idTitleKey
      ? {matchKey: row.idTitleKey, matchKind: 'id-title', sourceRow: row, targetArticles: []}
      : row.titleKey
        ? {matchKey: row.titleKey, matchKind: 'title', sourceRow: row, targetArticles: []}
        : {matchKey: null, matchKind: null, sourceRow: row, targetArticles: []}
}

const getImportRowMatchDetail = (params: {
  matchKey: string | null
  matchKind: ComparisonProjectConflictResolutionImportMatchKind | null
  sourceRow: NormalizedSourceRow
  targetArticles: readonly NormalizedTargetArticle[]
}): ImportRowMatchDetail => {
  return {
    matchKey: params.matchKey,
    matchKind: params.matchKind,
    sourceRow: params.sourceRow,
    targetArticles: [...params.targetArticles],
  }
}

const getImportRowMatchDetailFromMatch = (
  row: NormalizedSourceRow,
  match: ImportTargetArticleMatch,
): ImportRowMatchDetail => {
  return getImportRowMatchDetail({
    matchKey: match.matchKey,
    matchKind: match.matchKind,
    sourceRow: row,
    targetArticles: [match.targetArticle],
  })
}

const getTargetSummaryOptionValueMap = (targetSummaryOptionValues: readonly string[]) => {
  return targetSummaryOptionValues.reduce<Map<string, string[]>>((optionValueMap, optionValue) => {
    const normalizedValue = getNormalizedResolutionValue(optionValue)
    const currentValues = optionValueMap.get(normalizedValue) ?? []

    return normalizedValue.length === 0
      ? optionValueMap
      : optionValueMap.set(normalizedValue, [...currentValues, normalizedValue])
  }, new Map<string, string[]>())
}

const getCanonicalTargetSummaryOptionValue = (
  row: ImportCandidateRow,
  targetSummaryOptionValueMap: Map<string, string[]>,
) => {
  const normalizedValue = getNormalizedResolutionValue(row.resolutionValue)
  const matchingOptionValues = targetSummaryOptionValueMap.get(normalizedValue) ?? []

  return matchingOptionValues.length === 1 ? matchingOptionValues[0] : null
}

const getInvalidTargetResolutionValueWarning = (
  row: ImportCandidateRow,
): ComparisonProjectConflictResolutionImportWarning => {
  return {
    code: 'invalid-target-resolution-value',
    matchKey: row.matchKey,
    matchKind: row.matchKind,
    message: `Source resolution value does not map to exactly one target summary option: ${row.resolutionValue}`,
    sourceRows: [getWarningSourceRow(row.sourceRow)],
    targetArticles: [getWarningTargetArticle(row.targetArticle)],
    value: row.resolutionValue,
  }
}

const getTargetArticleMaps = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return {
    byArticleId: getTargetArticlesByArticleId(targetArticles),
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

const getIsTargetArticleImportEligible = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  targetArticle: NormalizedTargetArticle,
) => {
  return importMode === 'all-matched' || targetArticle.isConflictResolutionEligible
}

const getEligibleTargetMatches = (
  matches: readonly ImportTargetArticleMatch[],
  importMode: ComparisonProjectConflictResolutionImportMode,
) => {
  return matches.filter((match) => {
    return getIsTargetArticleImportEligible(importMode, match.targetArticle)
  })
}

const getTargetArticlesFromMatches = (matches: readonly ImportTargetArticleMatch[]) => {
  return matches.map((match) => {
    return match.targetArticle
  })
}

const getAmbiguousMatchKey = (matches: readonly ImportTargetArticleMatch[]) => {
  return getUniqueStringValues(
    matches.map((match) => {
      return match.matchKey
    }),
  ).join(', ')
}

const getAmbiguousMatchKind = (matches: readonly ImportTargetArticleMatch[]) => {
  return matches[0]?.matchKind ?? 'id-title'
}

const getCandidateRow = (params: {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  row: NormalizedSourceRow
  targetArticle: NormalizedTargetArticle
}): ImportCandidateRow => {
  return {
    matchKey: params.matchKey,
    matchKind: params.matchKind,
    resolutionValue: params.row.resolutionValue,
    sourceRow: params.row,
    sourceRowId: params.row.sourceRowId,
    targetArticle: params.targetArticle,
    targetArticleId: params.targetArticle.articleId,
  }
}

const getIdentifierTieBreakerMatches = (row: NormalizedSourceRow, matches: readonly ImportTargetArticleMatch[]) => {
  return row.idTitleKey
    ? matches.filter((match) => {
        return match.targetArticle.idTitleKey === row.idTitleKey
      })
    : []
}

const getHasConflictingIdentifierMatches = (matches: readonly ImportTargetArticleMatch[]) => {
  const targetArticleIds = getTargetArticleIds(getTargetArticlesFromMatches(matches))
  const matchKeys = getUniqueStringValues(
    matches.map((match) => {
      return match.matchKey
    }),
  )

  return targetArticleIds.length > 1 && matchKeys.length > 1
}

const getExistingTargetResolutionResult = (
  row: NormalizedSourceRow,
  selectedMatch: ImportTargetArticleMatch,
): ImportCandidateRowResult | null => {
  return selectedMatch.targetArticle.hasExistingResolution
    ? {
        candidate: null,
        detail: getImportRowMatchDetailFromMatch(row, selectedMatch),
        skippedRow: getSkippedRow(row.sourceRowId, 'existing-target-resolution'),
        warnings: [],
      }
    : null
}

const getIdentifierKeysForTier = (row: NormalizedSourceRow, tier: SourceIdentifierTier) => {
  return row.identifierKeys.filter((identifierKey) => {
    return identifierKey.tier === tier
  })
}

const getIdentifierImportCandidateRowForTier = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
  tier: SourceIdentifierTier,
): ImportCandidateRowResult | null => {
  const identifierKeys = getIdentifierKeysForTier(row, tier)
  const targetMatches = getUniqueTargetArticleMatches(
    getTargetArticlesForSourceIdentifierKeys(identifierKeys, targetArticleMaps.byIdentifierKey),
  )
  const eligibleMatches = getEligibleTargetMatches(targetMatches, importMode)
  const hasConflictingIdentifiers = getHasConflictingIdentifierMatches(eligibleMatches)
  const tieBreakerMatches = hasConflictingIdentifiers ? [] : getIdentifierTieBreakerMatches(row, eligibleMatches)
  const selectedMatch =
    eligibleMatches.length === 1 ? eligibleMatches[0] : tieBreakerMatches.length === 1 ? tieBreakerMatches[0] : null
  const skipReason =
    targetMatches.length === 0
      ? null
      : eligibleMatches.length === 0
        ? 'not-conflicting'
        : hasConflictingIdentifiers
          ? 'conflicting-identifiers'
          : selectedMatch
            ? null
            : 'ambiguous-target-match'
  const existingResolutionResult = selectedMatch ? getExistingTargetResolutionResult(row, selectedMatch) : null

  return existingResolutionResult
    ? existingResolutionResult
    : selectedMatch
      ? {
          candidate: getCandidateRow({
            matchKey: selectedMatch.matchKey,
            matchKind: selectedMatch.matchKind,
            row,
            targetArticle: selectedMatch.targetArticle,
          }),
          detail: getImportRowMatchDetailFromMatch(row, selectedMatch),
          skippedRow: null,
          warnings: [],
        }
      : skipReason
        ? {
            candidate: null,
            detail: getImportRowMatchDetail({
              matchKey: getAmbiguousMatchKey(eligibleMatches.length > 0 ? eligibleMatches : targetMatches),
              matchKind: getAmbiguousMatchKind(eligibleMatches.length > 0 ? eligibleMatches : targetMatches),
              sourceRow: row,
              targetArticles: getTargetArticlesFromMatches(
                eligibleMatches.length > 0 ? eligibleMatches : targetMatches,
              ),
            }),
            skippedRow: getSkippedRow(row.sourceRowId, skipReason),
            warnings:
              skipReason === 'ambiguous-target-match'
                ? [
                    getAmbiguousTargetMatchWarning({
                      matchKey: getAmbiguousMatchKey(eligibleMatches),
                      matchKind: getAmbiguousMatchKind(eligibleMatches),
                      sourceRow: row,
                      targetArticles: getTargetArticlesFromMatches(eligibleMatches),
                    }),
                  ]
                : skipReason === 'conflicting-identifiers'
                  ? [getConflictingIdentifiersWarning({matches: eligibleMatches, sourceRow: row})]
                  : [],
          }
        : null
}

const getIdentifierImportCandidateRow = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
) => {
  return sourceIdentifierTierOrder.reduce<ImportCandidateRowResult | null>((result, tier) => {
    return result ?? getIdentifierImportCandidateRowForTier(importMode, row, targetArticleMaps, tier)
  }, null)
}

const getArticleIdImportCandidateRow = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): ImportCandidateRowResult | null => {
  const targetArticle = targetArticleMaps.byArticleId.get(row.sourceArticleId) ?? null
  const targetMatch = targetArticle
    ? {matchKey: row.sourceArticleId, matchKind: 'article-id' as const, targetArticle}
    : null
  const eligibleMatch =
    targetMatch && getIsTargetArticleImportEligible(importMode, targetMatch.targetArticle) ? targetMatch : null
  const existingResolutionResult = eligibleMatch ? getExistingTargetResolutionResult(row, eligibleMatch) : null

  return existingResolutionResult
    ? existingResolutionResult
    : eligibleMatch
      ? {
          candidate: getCandidateRow({
            matchKey: eligibleMatch.matchKey,
            matchKind: eligibleMatch.matchKind,
            row,
            targetArticle: eligibleMatch.targetArticle,
          }),
          detail: getImportRowMatchDetailFromMatch(row, eligibleMatch),
          skippedRow: null,
          warnings: [],
        }
      : targetMatch
        ? {
            candidate: null,
            detail: getImportRowMatchDetailFromMatch(row, targetMatch),
            skippedRow: getSkippedRow(row.sourceRowId, 'not-conflicting'),
            warnings: [],
          }
        : null
}

const getIdTitleImportCandidateRow = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): ImportCandidateRowResult => {
  const targetMatches = getUniqueTargetArticleMatches(
    row.idTitleKey
      ? (targetArticleMaps.byIdTitleKey.get(row.idTitleKey) ?? [])
          .filter((targetArticle) => {
            return getCanUseIdTitleFallbackTargetArticle(row, targetArticle)
          })
          .map((targetArticle) => {
            return {matchKey: row.idTitleKey ?? '', matchKind: 'id-title' as const, targetArticle}
          })
      : [],
  )
  const eligibleMatches = getEligibleTargetMatches(targetMatches, importMode)
  const selectedMatch = eligibleMatches.length === 1 ? eligibleMatches[0] : null
  const existingResolutionResult = selectedMatch ? getExistingTargetResolutionResult(row, selectedMatch) : null
  const skipReason =
    targetMatches.length === 0
      ? 'no-target-match'
      : eligibleMatches.length === 0
        ? 'not-conflicting'
        : selectedMatch
          ? null
          : 'ambiguous-target-match'

  return existingResolutionResult
    ? existingResolutionResult
    : selectedMatch
      ? {
          candidate: getCandidateRow({
            matchKey: selectedMatch.matchKey,
            matchKind: 'id-title',
            row,
            targetArticle: selectedMatch.targetArticle,
          }),
          detail: getImportRowMatchDetailFromMatch(row, selectedMatch),
          skippedRow: null,
          warnings: [],
        }
      : {
          candidate: null,
          detail: getImportRowMatchDetail({
            matchKey: row.idTitleKey,
            matchKind: row.idTitleKey ? 'id-title' : null,
            sourceRow: row,
            targetArticles: getTargetArticlesFromMatches(eligibleMatches.length > 0 ? eligibleMatches : targetMatches),
          }),
          skippedRow: getSkippedRow(row.sourceRowId, skipReason),
          warnings:
            skipReason === 'ambiguous-target-match'
              ? [
                  getAmbiguousTargetMatchWarning({
                    matchKey: getAmbiguousMatchKey(eligibleMatches),
                    matchKind: 'id-title',
                    sourceRow: row,
                    targetArticles: getTargetArticlesFromMatches(eligibleMatches),
                  }),
                ]
              : [],
        }
}

const getTitleImportCandidateRow = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): ImportCandidateRowResult | null => {
  const targetMatches = getUniqueTargetArticleMatches(
    row.titleKey && !row.idTitleKey
      ? (targetArticleMaps.byTitleKey.get(row.titleKey) ?? [])
          .filter((targetArticle) => {
            return getCanUseTitleFallbackTargetArticle(row, targetArticle)
          })
          .map((targetArticle) => {
            return {matchKey: row.titleKey ?? '', matchKind: 'title' as const, targetArticle}
          })
      : [],
  )
  const eligibleMatches = getEligibleTargetMatches(targetMatches, importMode)
  const selectedMatch = eligibleMatches.length === 1 ? eligibleMatches[0] : null
  const existingResolutionResult = selectedMatch ? getExistingTargetResolutionResult(row, selectedMatch) : null
  const skipReason =
    targetMatches.length === 0
      ? 'no-target-match'
      : eligibleMatches.length === 0
        ? 'not-conflicting'
        : selectedMatch
          ? null
          : 'ambiguous-target-match'

  return !row.titleKey || row.idTitleKey
    ? null
    : existingResolutionResult
      ? existingResolutionResult
      : selectedMatch
        ? {
            candidate: getCandidateRow({
              matchKey: selectedMatch.matchKey,
              matchKind: 'title',
              row,
              targetArticle: selectedMatch.targetArticle,
            }),
            detail: getImportRowMatchDetailFromMatch(row, selectedMatch),
            skippedRow: null,
            warnings: [],
          }
        : {
            candidate: null,
            detail: getImportRowMatchDetail({
              matchKey: row.titleKey,
              matchKind: 'title',
              sourceRow: row,
              targetArticles: getTargetArticlesFromMatches(
                eligibleMatches.length > 0 ? eligibleMatches : targetMatches,
              ),
            }),
            skippedRow: getSkippedRow(row.sourceRowId, skipReason),
            warnings:
              skipReason === 'ambiguous-target-match'
                ? [
                    getAmbiguousTargetMatchWarning({
                      matchKey: getAmbiguousMatchKey(eligibleMatches),
                      matchKind: 'title',
                      sourceRow: row,
                      targetArticles: getTargetArticlesFromMatches(eligibleMatches),
                    }),
                  ]
                : [],
          }
}

const getNoTargetMatchImportCandidateRow = (row: NormalizedSourceRow): ImportCandidateRowResult => {
  return {
    candidate: null,
    detail: getPreferredSourceRowMatchDetail(row),
    skippedRow: getSkippedRow(row.sourceRowId, 'no-target-match'),
    warnings: [],
  }
}

const getImportCandidateRow = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  row: NormalizedSourceRow,
  targetArticleMaps: ReturnType<typeof getTargetArticleMaps>,
): ImportCandidateRowResult => {
  const hasUsableKey = row.identifierKeys.length > 0 || Boolean(row.idTitleKey) || Boolean(row.titleKey)
  const articleIdResult = getArticleIdImportCandidateRow(importMode, row, targetArticleMaps)
  const identifierResult =
    row.identifierKeys.length > 0 ? getIdentifierImportCandidateRow(importMode, row, targetArticleMaps) : null
  const idTitleResult = row.idTitleKey ? getIdTitleImportCandidateRow(importMode, row, targetArticleMaps) : null
  const titleResult = row.titleKey ? getTitleImportCandidateRow(importMode, row, targetArticleMaps) : null

  return row.resolutionMode !== 'summary'
    ? {
        candidate: null,
        detail: getPreferredSourceRowMatchDetail(row),
        skippedRow: getSkippedRow(row.sourceRowId, 'unsupported-mode'),
        warnings: [],
      }
    : articleIdResult
      ? articleIdResult
      : !hasUsableKey
        ? {
            candidate: null,
            detail: getPreferredSourceRowMatchDetail(row),
            skippedRow: getSkippedRow(row.sourceRowId, 'no-usable-key'),
            warnings: [],
          }
        : identifierResult
          ? identifierResult
          : idTitleResult
            ? idTitleResult
            : titleResult
              ? titleResult
              : getNoTargetMatchImportCandidateRow(row)
}

const getCandidateRows = (
  importMode: ComparisonProjectConflictResolutionImportMode,
  sourceRows: readonly NormalizedSourceRow[],
  targetArticles: readonly NormalizedTargetArticle[],
) => {
  const targetArticleMaps = getTargetArticleMaps(targetArticles)

  return sourceRows.map((row) => {
    return getImportCandidateRow(importMode, row, targetArticleMaps)
  })
}

const getSkipCounts = (
  skippedRows: readonly ComparisonProjectConflictResolutionImportSkippedRow[],
): ComparisonProjectConflictResolutionImportSkipCounts => {
  return skippedRows.reduce<ComparisonProjectConflictResolutionImportSkipCounts>(
    (counts, skippedRow) => {
      return {
        ambiguousTarget: counts.ambiguousTarget + (skippedRow.reason === 'ambiguous-target-match' ? 1 : 0),
        conflictingIdentifiers:
          counts.conflictingIdentifiers + (skippedRow.reason === 'conflicting-identifiers' ? 1 : 0),
        conflicting: counts.conflicting + (skippedRow.reason === 'conflicting-resolution-values' ? 1 : 0),
        existingTargetResolution:
          counts.existingTargetResolution + (skippedRow.reason === 'existing-target-resolution' ? 1 : 0),
        invalidValue: counts.invalidValue + (skippedRow.reason === 'invalid-target-resolution-value' ? 1 : 0),
        noTargetMatch: counts.noTargetMatch + (skippedRow.reason === 'no-target-match' ? 1 : 0),
        noUsableKey: counts.noUsableKey + (skippedRow.reason === 'no-usable-key' ? 1 : 0),
        notConflicting: counts.notConflicting + (skippedRow.reason === 'not-conflicting' ? 1 : 0),
        unsupportedMode: counts.unsupportedMode + (skippedRow.reason === 'unsupported-mode' ? 1 : 0),
      }
    },
    {
      ambiguousTarget: 0,
      conflictingIdentifiers: 0,
      conflicting: 0,
      existingTargetResolution: 0,
      invalidValue: 0,
      noTargetMatch: 0,
      noUsableKey: 0,
      notConflicting: 0,
      unsupportedMode: 0,
    },
  )
}

const getTargetResolvedCandidateRows = (
  candidateRows: readonly ImportCandidateRow[],
  targetSummaryOptionValues: readonly string[],
) => {
  const targetSummaryOptionValueMap = getTargetSummaryOptionValueMap(targetSummaryOptionValues)

  return candidateRows.reduce<{
    candidateRows: ImportCandidateRow[]
    skippedRows: ComparisonProjectConflictResolutionImportSkippedRow[]
    warnings: ComparisonProjectConflictResolutionImportWarning[]
  }>(
    (result, row) => {
      const targetResolutionValue = getCanonicalTargetSummaryOptionValue(row, targetSummaryOptionValueMap)

      return targetResolutionValue
        ? {...result, candidateRows: [...result.candidateRows, {...row, resolutionValue: targetResolutionValue}]}
        : {
            candidateRows: result.candidateRows,
            skippedRows: [...result.skippedRows, getSkippedRow(row.sourceRowId, 'invalid-target-resolution-value')],
            warnings: [...result.warnings, getInvalidTargetResolutionValueWarning(row)],
          }
    },
    {candidateRows: [], skippedRows: [], warnings: []},
  )
}

const getCandidateRowsByTargetArticleId = (candidateRows: readonly ImportCandidateRow[]) => {
  return candidateRows.reduce<Map<string, ImportCandidateRow[]>>((candidateMap, row) => {
    const currentRows = candidateMap.get(row.targetArticleId) ?? []

    candidateMap.set(row.targetArticleId, [...currentRows, row])
    return candidateMap
  }, new Map<string, ImportCandidateRow[]>())
}

const getCandidateRowResolutionValues = (candidateRows: readonly ImportCandidateRow[]) => {
  return getUniqueStringValues(
    candidateRows.map((row) => {
      return row.resolutionValue
    }),
  )
}

const getCandidateRowMatchKinds = (candidateRows: readonly ImportCandidateRow[]) => {
  return candidateRows.reduce<ComparisonProjectConflictResolutionImportMatchKind[]>((matchKinds, row) => {
    return matchKinds.includes(row.matchKind) ? matchKinds : [...matchKinds, row.matchKind]
  }, [])
}

const getWarningTargetArticles = (candidateRows: readonly ImportCandidateRow[]) => {
  return Array.from(
    candidateRows
      .reduce<Map<string, NormalizedTargetArticle>>((targetArticleMap, row) => {
        return targetArticleMap.has(row.targetArticleId)
          ? targetArticleMap
          : targetArticleMap.set(row.targetArticleId, row.targetArticle)
      }, new Map<string, NormalizedTargetArticle>())
      .values(),
  ).map(getWarningTargetArticle)
}

const getConflictingResolutionValuesWarning = (
  candidateRows: readonly ImportCandidateRow[],
): ComparisonProjectConflictResolutionImportWarning => {
  const values = getCandidateRowResolutionValues(candidateRows)
  const matchKeys = getUniqueStringValues(
    candidateRows.map((row) => {
      return row.matchKey
    }),
  )
  const matchKinds = getCandidateRowMatchKinds(candidateRows)
  const targetArticleIds = getTargetArticleIds(
    candidateRows.map((row) => {
      return row.targetArticle
    }),
  )

  return {
    code: 'conflicting-resolution-values',
    matchKey: matchKeys.join(', '),
    matchKeys,
    matchKind: matchKinds[0],
    matchKinds,
    message: `Conflicting source resolution values map to target article ${targetArticleIds.join(', ')}: ${values.join(', ')}`,
    sourceRows: candidateRows.map((row) => {
      return getWarningSourceRow(row.sourceRow)
    }),
    targetArticles: getWarningTargetArticles(candidateRows),
    values,
  }
}

const getImportCandidateSourceRows = (candidateRows: readonly ImportCandidateRow[]) => {
  return candidateRows.map((row) => {
    return {matchKey: row.matchKey, matchKind: row.matchKind, sourceRowId: row.sourceRowId}
  })
}

const getImportCandidateFromCandidateRows = (
  candidateRows: readonly ImportCandidateRow[],
): ComparisonProjectConflictResolutionImportCandidate | null => {
  const firstRow = candidateRows[0]

  return firstRow
    ? {
        resolutionValue: firstRow.resolutionValue,
        sourceRows: getImportCandidateSourceRows(candidateRows),
        targetArticleId: firstRow.targetArticleId,
      }
    : null
}

const getGroupedImportCandidates = (candidateRows: readonly ImportCandidateRow[]) => {
  return Array.from(getCandidateRowsByTargetArticleId(candidateRows).values()).reduce<{
    candidates: ComparisonProjectConflictResolutionImportCandidate[]
    skippedRows: ComparisonProjectConflictResolutionImportSkippedRow[]
    warnings: ComparisonProjectConflictResolutionImportWarning[]
  }>(
    (result, rows) => {
      const values = getCandidateRowResolutionValues(rows)
      const candidate = values.length === 1 ? getImportCandidateFromCandidateRows(rows) : null

      return candidate
        ? {...result, candidates: [...result.candidates, candidate]}
        : {
            candidates: result.candidates,
            skippedRows: [
              ...result.skippedRows,
              ...rows.map((row) => {
                return getSkippedRow(row.sourceRowId, 'conflicting-resolution-values')
              }),
            ],
            warnings: [...result.warnings, getConflictingResolutionValuesWarning(rows)],
          }
    },
    {candidates: [], skippedRows: [], warnings: []},
  )
}

const getDedupedCount = (candidates: readonly ComparisonProjectConflictResolutionImportCandidate[]) => {
  return candidates.reduce((count, candidate) => {
    return count + Math.max(candidate.sourceRows.length - 1, 0)
  }, 0)
}

const getComparisonProjectConflictResolutionImportPlanState = ({
  importMode = 'conflicting-only',
  sourceRows,
  targetArticles,
  targetSummaryOptionValues,
}: ComparisonProjectConflictResolutionImportPlanParams) => {
  const normalizedSourceRows = getNormalizedSourceRows(sourceRows)
  const normalizedTargetArticles = getNormalizedTargetArticles(targetArticles)
  const candidateRowResults = getCandidateRows(importMode, normalizedSourceRows, normalizedTargetArticles)
  const candidateRows = candidateRowResults
    .map((result) => {
      return result.candidate
    })
    .filter((candidate): candidate is ImportCandidateRow => {
      return candidate !== null
    })
  const skippedRows = candidateRowResults
    .map((result) => {
      return result.skippedRow
    })
    .filter((skippedRow): skippedRow is ComparisonProjectConflictResolutionImportSkippedRow => {
      return skippedRow !== null
    })
  const warnings = candidateRowResults.flatMap((result) => {
    return result.warnings
  })
  const targetResolvedCandidateRowResults = getTargetResolvedCandidateRows(candidateRows, targetSummaryOptionValues)
  const groupedImportCandidateResults = getGroupedImportCandidates(targetResolvedCandidateRowResults.candidateRows)
  const allSkippedRows = [
    ...skippedRows,
    ...targetResolvedCandidateRowResults.skippedRows,
    ...groupedImportCandidateResults.skippedRows,
  ]
  const allWarnings = [
    ...warnings,
    ...targetResolvedCandidateRowResults.warnings,
    ...groupedImportCandidateResults.warnings,
  ]

  return {
    allSkippedRows,
    allWarnings,
    candidateRowResults,
    candidateRows,
    groupedImportCandidateResults,
    normalizedSourceRows,
    normalizedTargetArticles,
    targetResolvedCandidateRowResults,
  }
}

export const getComparisonProjectConflictResolutionImportPlan = (
  params: ComparisonProjectConflictResolutionImportPlanParams,
): ComparisonProjectConflictResolutionImportPlan => {
  const planState = getComparisonProjectConflictResolutionImportPlanState(params)

  return {
    candidates: planState.groupedImportCandidateResults.candidates,
    dedupedCount: getDedupedCount(planState.groupedImportCandidateResults.candidates),
    errors: [],
    skipCounts: getSkipCounts(planState.allSkippedRows),
    skippedRows: planState.allSkippedRows,
    warnings: planState.allWarnings,
  }
}

const getAnalyzeSource = (
  artifact: ComparisonProjectConflictResolutionTransferArtifactV1,
): ComparisonProjectConflictResolutionImportAnalyzeSource => {
  return {
    comparisonProjectId: artifact.source.comparisonProjectId,
    comparisonProjectName: artifact.source.comparisonProjectName,
    comparisonProjectDescription: artifact.source.comparisonProjectDescription,
    exportedAt: artifact.exportedAt,
    format: artifact.format,
    version: artifact.version,
    rowCount: artifact.rows.length,
  }
}

const getFirstAnalyzeTargetArticle = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return targetArticles[0] ?? null
}

const getAnalyzeTargetArticleIds = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return getUniqueStringValues(
    targetArticles.map((targetArticle) => {
      return targetArticle.articleId
    }),
  )
}

const getAnalyzeTargetExternalArticleIds = (targetArticles: readonly NormalizedTargetArticle[]) => {
  return getUniqueStringValues(
    targetArticles
      .map((targetArticle) => {
        return targetArticle.externalArticleId ?? ''
      })
      .filter(Boolean),
  )
}

const getAnalyzeRow = (params: {
  detail: ImportRowMatchDetail
  reason: ComparisonProjectConflictResolutionImportAnalyzeRowReason
  selectedResolution: string
}): ComparisonProjectConflictResolutionImportAnalyzeRow => {
  const firstTargetArticle = getFirstAnalyzeTargetArticle(params.detail.targetArticles)

  return {
    sourceTitle: params.detail.sourceRow.sourceArticleTitle ?? params.detail.sourceRow.title ?? null,
    sourceArticleRowId: params.detail.sourceRow.sourceArticleId,
    sourceExternalArticleId:
      params.detail.sourceRow.sourceExternalArticleId ?? params.detail.sourceRow.externalArticleId ?? null,
    sourceResolutionId: params.detail.sourceRow.sourceResolutionId,
    sourceComparisonProjectId: params.detail.sourceRow.sourceComparisonProjectId,
    sourceComparisonProjectName: params.detail.sourceRow.sourceComparisonProjectName,
    targetTitle: firstTargetArticle?.title ?? null,
    targetArticleId: firstTargetArticle?.articleId ?? null,
    targetArticleIds: getAnalyzeTargetArticleIds(params.detail.targetArticles),
    targetExternalArticleId: firstTargetArticle?.externalArticleId ?? null,
    targetExternalArticleIds: getAnalyzeTargetExternalArticleIds(params.detail.targetArticles),
    selectedResolution: params.selectedResolution,
    matchKind: params.detail.matchKind,
    matchKey: params.detail.matchKey,
    reason: params.reason,
  }
}

const getAnalyzeRowFromCandidateRow = (
  candidateRow: ImportCandidateRow,
): ComparisonProjectConflictResolutionImportAnalyzeRow => {
  return getAnalyzeRow({
    detail: getImportRowMatchDetail({
      matchKey: candidateRow.matchKey,
      matchKind: candidateRow.matchKind,
      sourceRow: candidateRow.sourceRow,
      targetArticles: [candidateRow.targetArticle],
    }),
    reason: 'importable',
    selectedResolution: candidateRow.resolutionValue,
  })
}

const getCandidateRowsForCandidates = (params: {
  candidates: readonly ComparisonProjectConflictResolutionImportCandidate[]
  candidateRows: readonly ImportCandidateRow[]
}) => {
  const candidateSourceRowIds = new Set(
    params.candidates.flatMap((candidate) => {
      return candidate.sourceRows.map((sourceRow) => {
        return sourceRow.sourceRowId
      })
    }),
  )

  return params.candidateRows.filter((candidateRow) => {
    return candidateSourceRowIds.has(candidateRow.sourceRowId)
  })
}

const getInitialAnalyzeSkippedRows = (
  candidateRowResults: readonly ImportCandidateRowResult[],
): ComparisonProjectConflictResolutionImportAnalyzeRow[] => {
  return candidateRowResults.flatMap((result) => {
    return result.skippedRow && result.detail
      ? [
          getAnalyzeRow({
            detail: result.detail,
            reason: result.skippedRow.reason,
            selectedResolution: result.detail.sourceRow.resolutionValue,
          }),
        ]
      : []
  })
}

const getInvalidValueAnalyzeSkippedRows = (
  candidateRows: readonly ImportCandidateRow[],
  skippedRows: readonly ComparisonProjectConflictResolutionImportSkippedRow[],
): ComparisonProjectConflictResolutionImportAnalyzeRow[] => {
  const skippedSourceRowIds = new Set(
    skippedRows.map((skippedRow) => {
      return skippedRow.sourceRowId
    }),
  )

  return candidateRows
    .filter((candidateRow) => {
      return skippedSourceRowIds.has(candidateRow.sourceRowId)
    })
    .map((candidateRow) => {
      return {...getAnalyzeRowFromCandidateRow(candidateRow), reason: 'invalid-target-resolution-value' as const}
    })
}

const getConflictingAnalyzeSkippedRows = (
  candidateRows: readonly ImportCandidateRow[],
  skippedRows: readonly ComparisonProjectConflictResolutionImportSkippedRow[],
): ComparisonProjectConflictResolutionImportAnalyzeRow[] => {
  const skippedSourceRowIds = new Set(
    skippedRows.map((skippedRow) => {
      return skippedRow.sourceRowId
    }),
  )

  return candidateRows
    .filter((candidateRow) => {
      return skippedSourceRowIds.has(candidateRow.sourceRowId)
    })
    .map((candidateRow) => {
      return {...getAnalyzeRowFromCandidateRow(candidateRow), reason: 'conflicting-resolution-values' as const}
    })
}

const getAnalyzeSummary = (params: {
  importableCount: number
  plan: ComparisonProjectConflictResolutionImportPlan
  scannedCount: number
}): ComparisonProjectConflictResolutionImportAnalyzeSummary => {
  const skippedConflicting = params.plan.skipCounts.conflicting + params.plan.skipCounts.conflictingIdentifiers
  const skipped =
    params.plan.skipCounts.ambiguousTarget
    + skippedConflicting
    + params.plan.skipCounts.existingTargetResolution
    + params.plan.skipCounts.invalidValue
    + params.plan.skipCounts.noTargetMatch
    + params.plan.skipCounts.noUsableKey
    + params.plan.skipCounts.notConflicting
    + params.plan.skipCounts.unsupportedMode

  return {
    scanned: params.scannedCount,
    matched: params.plan.candidates.reduce((count, candidate) => {
      return count + candidate.sourceRows.length
    }, 0),
    importable: params.importableCount,
    deduped: params.plan.dedupedCount,
    skipped,
    skippedExisting: params.plan.skipCounts.existingTargetResolution,
    skippedUnsupportedMode: params.plan.skipCounts.unsupportedMode,
    skippedNoUsableKey: params.plan.skipCounts.noUsableKey,
    skippedNoTargetMatch: params.plan.skipCounts.noTargetMatch,
    skippedNotConflicting: params.plan.skipCounts.notConflicting,
    skippedAmbiguousTarget: params.plan.skipCounts.ambiguousTarget,
    skippedConflicting,
    skippedInvalidValue: params.plan.skipCounts.invalidValue,
  }
}

export const getComparisonProjectConflictResolutionImportAnalyzeResult = (params: {
  artifact: ComparisonProjectConflictResolutionTransferArtifactV1
  importMode?: ComparisonProjectConflictResolutionImportMode
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
  targetArticles: readonly ComparisonProjectConflictResolutionImportTargetArticle[]
  targetSummaryOptionValues: readonly string[]
}): ComparisonProjectConflictResolutionImportAnalyzeResult => {
  const planState = getComparisonProjectConflictResolutionImportPlanState({
    importMode: params.importMode,
    sourceRows: params.sourceRows,
    targetArticles: params.targetArticles,
    targetSummaryOptionValues: params.targetSummaryOptionValues,
  })
  const plan = getComparisonProjectConflictResolutionImportPlan({
    importMode: params.importMode,
    sourceRows: params.sourceRows,
    targetArticles: params.targetArticles,
    targetSummaryOptionValues: params.targetSummaryOptionValues,
  })
  const importableCandidateRows = getCandidateRowsForCandidates({
    candidates: plan.candidates,
    candidateRows: planState.targetResolvedCandidateRowResults.candidateRows,
  })
  const skippedRows = [
    ...getInitialAnalyzeSkippedRows(planState.candidateRowResults),
    ...getInvalidValueAnalyzeSkippedRows(
      planState.candidateRows,
      planState.targetResolvedCandidateRowResults.skippedRows,
    ),
    ...getConflictingAnalyzeSkippedRows(
      planState.targetResolvedCandidateRowResults.candidateRows,
      planState.groupedImportCandidateResults.skippedRows,
    ),
  ]

  return {
    source: getAnalyzeSource(params.artifact),
    summary: getAnalyzeSummary({importableCount: plan.candidates.length, plan, scannedCount: params.sourceRows.length}),
    importableRows: importableCandidateRows.map(getAnalyzeRowFromCandidateRow),
    skippedRows,
    warnings: plan.warnings,
  }
}

export const getComparisonProjectConflictResolutionImportCommitResult = (params: {
  analyzeResult: ComparisonProjectConflictResolutionImportAnalyzeResult
  inserted: number
}): ComparisonProjectConflictResolutionImportCommitResult => {
  return {...params.analyzeResult, summary: {...params.analyzeResult.summary, inserted: params.inserted}}
}
