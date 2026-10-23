import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {identifierKeySeparator} from './comparisonProjectConflictResolutionImportConstants.ts'
import {
  getComparisonProjectConflictResolutionImportArxivIdentifierValueSql,
  getComparisonProjectConflictResolutionImportDoiIdentifierValueSql,
  getComparisonProjectConflictResolutionImportPmidIdentifierValueSql,
} from './comparisonProjectConflictResolutionImportIdentifierValueSql.ts'
import {
  getComparisonProjectConflictResolutionImportServingArticleJoinSql,
  getComparisonProjectConflictResolutionImportServingArticleSelectSql,
  getComparisonProjectConflictResolutionImportServingGroupBySql,
} from './comparisonProjectConflictResolutionImportServingSql.ts'
import {getInClause} from './comparisonProjectConflictResolutionImportSql.ts'

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
