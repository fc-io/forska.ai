import {
  getComparisonProjectConflictResolutionImportServingArticleJoinSql,
  getComparisonProjectConflictResolutionImportServingArticleSelectSql,
  getComparisonProjectConflictResolutionImportServingGroupBySql,
} from './comparisonProjectConflictResolutionImportServingSql.ts'
import {getInClause} from './comparisonProjectConflictResolutionImportSql.ts'
import {getComparisonProjectConflictResolutionImportIdTitleKeySql} from './comparisonProjectConflictResolutionImportTargetSql.ts'

export const getComparisonProjectConflictResolutionImportServingIdTitleTargetArticlesSql = (params: {
  comparisonProjectId: string
  generation: number
  idTitleKeys: string[]
}) => {
  const idTitleKeySql = getComparisonProjectConflictResolutionImportIdTitleKeySql({
    externalArticleIdColumn: 'a.article_external_id',
    titleColumn: 'a.article_title',
  })

  return `
    SELECT
${getComparisonProjectConflictResolutionImportServingArticleSelectSql()}
    FROM mart.comparison_article_serving a
${getComparisonProjectConflictResolutionImportServingArticleJoinSql(params)}
      AND ${params.idTitleKeys.length > 0 ? `${idTitleKeySql} IN (${getInClause(params.idTitleKeys)})` : 'FALSE'}
    GROUP BY ${getComparisonProjectConflictResolutionImportServingGroupBySql()}
    ORDER BY a.article_id ASC
  `
}
