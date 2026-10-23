import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getComparisonProjectStatsArticleCategorySql} from './comparisonProjectStatsSql.ts'

export const getComparisonProjectStatsArticleCategoryCountsSql = (params: {
  comparisonProjectId: string
  generation: number
}) => {
  return `
    SELECT
      ${getComparisonProjectStatsArticleCategorySql('article.article_category')} AS articleCategory,
      CAST(COUNT(*) AS INTEGER) AS articleCount
    FROM mart.comparison_article_serving article
    WHERE article.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND article.generation = ${getSqlLiteral(params.generation)}
    GROUP BY 1
    ORDER BY articleCategory ASC
  `
}
