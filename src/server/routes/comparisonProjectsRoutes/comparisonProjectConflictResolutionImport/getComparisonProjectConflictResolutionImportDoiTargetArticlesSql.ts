import {getInClause, getWhereClause} from './comparisonProjectConflictResolutionImportSql.ts'
import {
  type ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
  getComparisonProjectConflictResolutionImportScopedExternalArticleCteSql,
  getComparisonProjectConflictResolutionImportScopedExternalArticleJoinSql,
  getComparisonProjectConflictResolutionImportTargetExternalArticleIdGroupBySql,
  getComparisonProjectConflictResolutionImportTargetExternalArticleIdSql,
  getComparisonProjectConflictResolutionImportWithCtesSql,
} from './comparisonProjectConflictResolutionImportTargetSql.ts'

export const getComparisonProjectConflictResolutionImportDoiTargetArticlesSql = (
  params: {
    articleIdentifierTable: string
    articleScopeConditions: readonly string[]
    articleTable: string
    doiKeys: string[]
  } & ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
) => {
  const externalArticleIdSql = getComparisonProjectConflictResolutionImportTargetExternalArticleIdSql(params)

  return `
    ${getComparisonProjectConflictResolutionImportWithCtesSql([
      getComparisonProjectConflictResolutionImportScopedExternalArticleCteSql(params),
    ])}
    SELECT
      a.id AS articleId,
      MIN(doi_identifier.normalized_value) AS doi,
      LIST(DISTINCT doi_identifier.normalized_value ORDER BY doi_identifier.normalized_value) AS doiKeys,
      ${externalArticleIdSql} AS externalArticleId,
      a.article_title AS title
    FROM ${params.articleIdentifierTable} doi_identifier
    INNER JOIN ${params.articleTable} a ON a.id = doi_identifier.article_id
    ${getComparisonProjectConflictResolutionImportScopedExternalArticleJoinSql(params)}
    ${getWhereClause([
      ...params.articleScopeConditions,
      "doi_identifier.kind = 'doi'",
      params.doiKeys.length > 0 ? `doi_identifier.normalized_value IN (${getInClause(params.doiKeys)})` : 'FALSE',
    ])}
    GROUP BY a.id, ${getComparisonProjectConflictResolutionImportTargetExternalArticleIdGroupBySql(params)}, a.article_title
    ORDER BY a.id ASC
  `
}
