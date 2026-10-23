import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {identifierKeySeparator} from './comparisonProjectConflictResolutionImportConstants.ts'

const getComparisonProjectConflictResolutionImportServingIdentifierListSql = () => {
  const identifierKeySql = `strong_identifier.kind || ${getSqlLiteral(identifierKeySeparator)} || strong_identifier.normalized_value`

  return `LIST(DISTINCT ${identifierKeySql} ORDER BY ${identifierKeySql}) FILTER (WHERE strong_identifier.kind IS NOT NULL) AS identifierKeys`
}

export const getComparisonProjectConflictResolutionImportServingArticleSelectSql = () => {
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

export const getComparisonProjectConflictResolutionImportServingGroupBySql = () => {
  return `
      a.article_id,
      a.doi,
      a.pubmed_id,
      a.arxiv_id,
      a.article_external_id,
      a.article_title
  `
}

export const getComparisonProjectConflictResolutionImportServingArticleJoinSql = (params: {
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
