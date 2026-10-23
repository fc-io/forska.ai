export const getComparisonProjectConflictResolutionImportDoiIdentifierValueSql = (column: string) => {
  return `regexp_replace(LOWER(TRIM(COALESCE(${column}, ''))), '^(https?://(dx\\.)?doi\\.org/|doi:\\s*)', '')`
}

export const getComparisonProjectConflictResolutionImportPmidIdentifierValueSql = (column: string) => {
  return `regexp_replace(regexp_replace(LOWER(TRIM(COALESCE(${column}, ''))), '^(pmid:|pubmed:)', ''), '^0+', '')`
}

export const getComparisonProjectConflictResolutionImportArxivIdentifierValueSql = (column: string) => {
  return `regexp_replace(regexp_replace(regexp_replace(LOWER(TRIM(COALESCE(${column}, ''))), '^(https?://(www\\.)?arxiv\\.org/(abs|pdf)/|oai:arxiv\\.org:|arxiv:)', ''), '\\.pdf$', ''), 'v[0-9]+$', '')`
}

export const getComparisonProjectConflictResolutionImportTargetIdentifierCtesSql = (params: {
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
