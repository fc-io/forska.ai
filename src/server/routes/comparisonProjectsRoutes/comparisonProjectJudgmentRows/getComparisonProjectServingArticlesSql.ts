import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getInClause} from './comparisonProjectJudgmentRowsUtils.ts'

export const getComparisonProjectServingArticlesSql = (params: {
  articleIds: string[]
  comparisonProjectId: string
  generation: number
}) => {
  return `
    SELECT
      article.article_id AS articleId,
      article.article_id AS canonicalArticleId,
      article.article_external_id AS articleExternalId,
      article.article_title AS articleTitle,
      article.article_summary AS articleSummary,
      article.article_created_at AS articleCreatedAt,
      article.has_conflict AS hasConflict
    FROM mart.comparison_article_serving article
    WHERE article.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND article.generation = ${getSqlLiteral(params.generation)}
      AND article.article_id IN (${getInClause(params.articleIds)})
  `
}
