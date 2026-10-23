import {
  getComparisonProjectConflictResolutionImportServingArticleJoinSql,
  getComparisonProjectConflictResolutionImportServingArticleSelectSql,
  getComparisonProjectConflictResolutionImportServingGroupBySql,
} from './comparisonProjectConflictResolutionImportServingSql.ts'
import {getInClause} from './comparisonProjectConflictResolutionImportSql.ts'
import {getComparisonProjectConflictResolutionImportTitleKeySql} from './comparisonProjectConflictResolutionImportTargetSql.ts'

export const getComparisonProjectConflictResolutionImportServingTitleTargetArticlesSql = (params: {
  comparisonProjectId: string
  generation: number
  titleKeys: string[]
}) => {
  const titleKeySql = getComparisonProjectConflictResolutionImportTitleKeySql('a.article_title')

  return `
    SELECT
${getComparisonProjectConflictResolutionImportServingArticleSelectSql()}
    FROM mart.comparison_article_serving a
${getComparisonProjectConflictResolutionImportServingArticleJoinSql(params)}
      AND ${params.titleKeys.length > 0 ? `${titleKeySql} IN (${getInClause(params.titleKeys)})` : 'FALSE'}
    GROUP BY ${getComparisonProjectConflictResolutionImportServingGroupBySql()}
    ORDER BY a.article_id ASC
  `
}
