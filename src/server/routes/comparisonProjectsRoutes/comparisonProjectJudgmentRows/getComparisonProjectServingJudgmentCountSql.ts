import {
  type ComparisonProjectArticleCategoryFilter,
  defaultComparisonProjectArticleCategoryFilter,
} from '../../../../utils/comparisonProjectArticleCategoryFilter.ts'
import type {ComparisonProjectDifferenceFilter} from '../../../../utils/comparisonProjectDifferenceFilter.ts'
import type {ComparisonProjectRowFilter} from '../../../../utils/comparisonProjectRowFilter.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'

export const getComparisonProjectServingJudgmentCountSql = (params: {
  articleCategoryFilter?: ComparisonProjectArticleCategoryFilter
  comparisonProjectId: string
  differenceFilter: ComparisonProjectDifferenceFilter
  rowFilter: ComparisonProjectRowFilter
}) => {
  return `
    WITH active_generation AS (
      SELECT active_generation AS generation
      FROM app.comparison_project_serving_generation
      WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND active_generation > 0
    )
    SELECT stats.total_count AS totalCount
    FROM mart.comparison_filter_stats stats
    INNER JOIN active_generation active ON active.generation = stats.generation
    WHERE stats.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND stats.row_filter = ${getSqlLiteral(params.rowFilter)}
      AND stats.difference_filter = ${getSqlLiteral(params.differenceFilter)}
      AND stats.article_category_filter = ${getSqlLiteral(
        params.articleCategoryFilter ?? defaultComparisonProjectArticleCategoryFilter,
      )}
    LIMIT 1
  `
}
