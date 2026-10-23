import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {identifierKeySeparator} from './comparisonProjectConflictResolutionImportConstants.ts'
import {getComparisonProjectConflictResolutionImportTargetIdentifierCtesSql} from './comparisonProjectConflictResolutionImportIdentifierValueSql.ts'
import {getInClause, getWhereClause} from './comparisonProjectConflictResolutionImportSql.ts'
import {
  type ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
  getComparisonProjectConflictResolutionImportIdTitleKeySql,
  getComparisonProjectConflictResolutionImportScopedExternalArticleCteSql,
  getComparisonProjectConflictResolutionImportScopedExternalArticleJoinSql,
  getComparisonProjectConflictResolutionImportTargetExternalArticleIdGroupBySql,
  getComparisonProjectConflictResolutionImportTargetExternalArticleIdSql,
  getComparisonProjectConflictResolutionImportWithCtesSql,
} from './comparisonProjectConflictResolutionImportTargetSql.ts'

export const getComparisonProjectConflictResolutionImportIdTitleTargetArticlesSql = (
  params: {
    articleIdentifierTable: string
    articleScopeConditions: readonly string[]
    articleTable: string
    idTitleKeys: string[]
  } & ComparisonProjectConflictResolutionImportScopedExternalArticleSqlParams,
) => {
  const externalArticleIdSql = getComparisonProjectConflictResolutionImportTargetExternalArticleIdSql(params)
  const idTitleKeySql = getComparisonProjectConflictResolutionImportIdTitleKeySql({
    externalArticleIdColumn: externalArticleIdSql,
    titleColumn: 'a.article_title',
  })

  return `
    ${getComparisonProjectConflictResolutionImportWithCtesSql([
      `doi_identifier AS (
      SELECT
        article_id AS articleId,
        MIN(normalized_value) AS doi
      FROM ${params.articleIdentifierTable}
      WHERE kind = 'doi'
      GROUP BY article_id
    )`,
      getComparisonProjectConflictResolutionImportTargetIdentifierCtesSql({
        articleIdentifierTable: params.articleIdentifierTable,
        articleTable: params.articleTable,
      }),
      getComparisonProjectConflictResolutionImportScopedExternalArticleCteSql(params),
    ])}
    SELECT
      a.id AS articleId,
      doi_identifier.doi AS doi,
      LIST(DISTINCT strong_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || strong_identifier.normalizedValue ORDER BY strong_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || strong_identifier.normalizedValue) FILTER (WHERE strong_identifier.kind IS NOT NULL) AS identifierKeys,
      a.doi AS legacyDoi,
      a.pubmed_id AS pubmedId,
      a.arxiv_id AS arxivId,
      ${externalArticleIdSql} AS externalArticleId,
      a.article_title AS title
    FROM ${params.articleTable} a
    LEFT JOIN doi_identifier ON doi_identifier.articleId = a.id
    LEFT JOIN target_identifier strong_identifier ON strong_identifier.articleId = a.id
    ${getComparisonProjectConflictResolutionImportScopedExternalArticleJoinSql(params)}
    ${getWhereClause([
      ...params.articleScopeConditions,
      params.idTitleKeys.length > 0 ? `${idTitleKeySql} IN (${getInClause(params.idTitleKeys)})` : 'FALSE',
    ])}
    GROUP BY a.id, doi_identifier.doi, a.doi, a.pubmed_id, a.arxiv_id, ${getComparisonProjectConflictResolutionImportTargetExternalArticleIdGroupBySql(params)}, a.article_title
    ORDER BY a.id ASC
  `
}
