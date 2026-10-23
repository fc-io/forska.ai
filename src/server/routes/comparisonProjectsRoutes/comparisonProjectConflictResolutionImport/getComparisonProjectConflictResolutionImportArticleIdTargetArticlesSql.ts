import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {identifierKeySeparator} from './comparisonProjectConflictResolutionImportConstants.ts'
import {getInClause, getWhereClause} from './comparisonProjectConflictResolutionImportSql.ts'
import {
  type ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
  getComparisonProjectConflictResolutionImportScopedExternalArticleCteSql,
  getComparisonProjectConflictResolutionImportScopedExternalArticleJoinSql,
  getComparisonProjectConflictResolutionImportTargetExternalArticleIdGroupBySql,
  getComparisonProjectConflictResolutionImportTargetExternalArticleIdSql,
  getComparisonProjectConflictResolutionImportWithCtesSql,
} from './comparisonProjectConflictResolutionImportTargetSql.ts'

export const getComparisonProjectConflictResolutionImportArticleIdTargetArticlesSql = (
  params: {
    articleIds: string[]
    articleIdentifierTable: string
    articleScopeConditions: readonly string[]
    articleTable: string
  } & ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
) => {
  const identifierKeySql = `strong_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || strong_identifier.normalized_value`
  const externalArticleIdSql = getComparisonProjectConflictResolutionImportTargetExternalArticleIdSql(params)

  return `
    ${getComparisonProjectConflictResolutionImportWithCtesSql([
      getComparisonProjectConflictResolutionImportScopedExternalArticleCteSql(params),
    ])}
    SELECT
      a.id AS articleId,
      MIN(CASE WHEN strong_identifier.kind = 'doi' THEN strong_identifier.normalized_value ELSE NULL END) AS doi,
      LIST(DISTINCT ${identifierKeySql} ORDER BY ${identifierKeySql}) FILTER (WHERE strong_identifier.kind IS NOT NULL) AS identifierKeys,
      a.doi AS legacyDoi,
      a.pubmed_id AS pubmedId,
      a.arxiv_id AS arxivId,
      ${externalArticleIdSql} AS externalArticleId,
      a.article_title AS title
    FROM ${params.articleTable} a
    LEFT JOIN ${params.articleIdentifierTable} strong_identifier
      ON strong_identifier.article_id = a.id
      AND strong_identifier.kind IN ('doi', 'pmid', 'arxiv')
    ${getComparisonProjectConflictResolutionImportScopedExternalArticleJoinSql(params)}
    ${getWhereClause([
      ...params.articleScopeConditions,
      params.articleIds.length > 0 ? `a.id IN (${getInClause(params.articleIds)})` : 'FALSE',
    ])}
    GROUP BY a.id, a.doi, a.pubmed_id, a.arxiv_id, ${getComparisonProjectConflictResolutionImportTargetExternalArticleIdGroupBySql(params)}, a.article_title
    ORDER BY a.id ASC
  `
}
