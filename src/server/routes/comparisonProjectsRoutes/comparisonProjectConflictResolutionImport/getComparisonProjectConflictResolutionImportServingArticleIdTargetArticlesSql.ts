import {
  getComparisonProjectConflictResolutionImportServingArticleJoinSql,
  getComparisonProjectConflictResolutionImportServingArticleSelectSql,
  getComparisonProjectConflictResolutionImportServingGroupBySql,
} from './comparisonProjectConflictResolutionImportServingSql.ts'
import {getInClause} from './comparisonProjectConflictResolutionImportSql.ts'

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
