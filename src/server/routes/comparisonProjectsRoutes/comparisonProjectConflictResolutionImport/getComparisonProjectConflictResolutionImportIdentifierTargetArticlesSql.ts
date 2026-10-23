import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {identifierKeySeparator} from './comparisonProjectConflictResolutionImportConstants.ts'
import {getComparisonProjectConflictResolutionImportTargetIdentifierCtesSql} from './comparisonProjectConflictResolutionImportIdentifierValueSql.ts'
import {getInClause, getWhereClause} from './comparisonProjectConflictResolutionImportSql.ts'
import {
  type ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
  getComparisonProjectConflictResolutionImportScopedExternalArticleCteSql,
  getComparisonProjectConflictResolutionImportScopedExternalArticleJoinSql,
  getComparisonProjectConflictResolutionImportTargetExternalArticleIdGroupBySql,
  getComparisonProjectConflictResolutionImportTargetExternalArticleIdSql,
  getComparisonProjectConflictResolutionImportWithCtesSql,
} from './comparisonProjectConflictResolutionImportTargetSql.ts'

export const getComparisonProjectConflictResolutionImportIdentifierTargetArticlesSql = (
  params: {
    articleIdentifierTable: string
    articleScopeConditions: readonly string[]
    articleTable: string
    identifierKeys: string[]
  } & ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
) => {
  const identifierKeySql = `strong_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || strong_identifier.normalizedValue`
  const matchedIdentifierKeySql = `target_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || target_identifier.normalizedValue`
  const externalArticleIdSql = getComparisonProjectConflictResolutionImportTargetExternalArticleIdSql(params)

  return `
    ${getComparisonProjectConflictResolutionImportWithCtesSql([
      getComparisonProjectConflictResolutionImportTargetIdentifierCtesSql({
        articleIdentifierTable: params.articleIdentifierTable,
        articleTable: params.articleTable,
      }),
      getComparisonProjectConflictResolutionImportScopedExternalArticleCteSql(params),
      `matched_article AS (
      SELECT DISTINCT target_identifier.articleId AS articleId
      FROM target_identifier
      WHERE target_identifier.kind IN ('doi', 'pmid', 'arxiv')
        AND ${matchedIdentifierKeySql} IN (${params.identifierKeys.length > 0 ? getInClause(params.identifierKeys) : 'NULL'})
    )`,
    ])}
    SELECT
      a.id AS articleId,
      MIN(CASE WHEN strong_identifier.kind = 'doi' THEN strong_identifier.normalizedValue ELSE NULL END) AS doi,
      LIST(DISTINCT ${identifierKeySql} ORDER BY ${identifierKeySql}) FILTER (WHERE strong_identifier.kind IS NOT NULL) AS identifierKeys,
      a.doi AS legacyDoi,
      a.pubmed_id AS pubmedId,
      a.arxiv_id AS arxivId,
      ${externalArticleIdSql} AS externalArticleId,
      a.article_title AS title
    FROM matched_article
    INNER JOIN ${params.articleTable} a ON a.id = matched_article.articleId
    LEFT JOIN target_identifier strong_identifier
      ON strong_identifier.articleId = a.id
    ${getComparisonProjectConflictResolutionImportScopedExternalArticleJoinSql(params)}
    ${getWhereClause(params.articleScopeConditions)}
    GROUP BY a.id, a.doi, a.pubmed_id, a.arxiv_id, ${getComparisonProjectConflictResolutionImportTargetExternalArticleIdGroupBySql(params)}, a.article_title
    ORDER BY a.id ASC
  `
}
