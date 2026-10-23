import {defaultComparisonProjectArticleCategoryFilter} from '../../../../utils/comparisonProjectArticleCategoryFilter.ts'
import {getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getComparisonProjectSearchQuery} from '../comparisonProjectJudgmentSearch.ts'
import type {
  ComparisonProjectArticleCategoryFilterSelection,
  ComparisonProjectConflictResolutionFilterSelection,
  ComparisonProjectDifferenceFilterSelection,
  ComparisonProjectRowFilterSelection,
  ComparisonProjectServingConflictResolutionProvenanceParams,
} from './comparisonProjectJudgmentRowsTypes.ts'
import {getPositiveInteger} from './comparisonProjectJudgmentRowsUtils.ts'
import {
  getComparisonProjectServingCursorWhereSql,
  getComparisonProjectServingPageCursor,
} from './comparisonProjectServingCursor.ts'
import {
  getComparisonProjectServingArticleCategoryFilterPredicateSql,
  getComparisonProjectServingArticleSourceSql,
  getComparisonProjectServingConflictResolutionFilterPredicateSql,
  getComparisonProjectServingConflictResolutionJoinSql,
  getComparisonProjectServingDifferenceFilterPredicateSql,
  getComparisonProjectServingProvenancePredicateSql,
  getComparisonProjectServingRowFilterPredicateSql,
  getComparisonProjectServingSearchPredicateSql,
} from './comparisonProjectServingFilterSql.ts'

export const getComparisonProjectServingMemberSql = (
  params: ComparisonProjectServingConflictResolutionProvenanceParams & {
    articleCategoryFilter?: ComparisonProjectArticleCategoryFilterSelection
    comparisonProjectId: string
    conflictResolutionFilter?: ComparisonProjectConflictResolutionFilterSelection
    cursor?: string | null
    differenceFilter: ComparisonProjectDifferenceFilterSelection
    limit: number
    rowFilter: ComparisonProjectRowFilterSelection
    searchText?: string | null
  },
) => {
  const cursor = getComparisonProjectServingPageCursor(params.cursor)
  const limit = getPositiveInteger(params.limit)
  const searchQuery = getComparisonProjectSearchQuery(params.searchText)
  const rowFilterPredicate = getComparisonProjectServingRowFilterPredicateSql(params.rowFilter)
  const differenceFilterPredicate = getComparisonProjectServingDifferenceFilterPredicateSql(params.differenceFilter)
  const articleCategoryFilterPredicate = getComparisonProjectServingArticleCategoryFilterPredicateSql(
    params.articleCategoryFilter ?? defaultComparisonProjectArticleCategoryFilter,
    'article',
  )
  const conflictResolutionJoin = getComparisonProjectServingConflictResolutionJoinSql(
    params.conflictResolutionFilter,
    params.differenceFilter,
    params.conflictResolutionProvenanceFilter,
  )
  const conflictResolutionFilterPredicate = getComparisonProjectServingConflictResolutionFilterPredicateSql(
    params.conflictResolutionFilter,
  )

  return `
    WITH active_generation AS (
      SELECT active_generation AS generation
      FROM app.comparison_project_serving_generation
      WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
        AND active_generation > 0
    )
    SELECT
      article.article_id AS articleId,
      article.generation AS generation,
      article.row_sort_created_at AS rowSortCreatedAt,
      article.row_sort_title AS rowSortTitle,
      article.row_sort_article_id AS rowSortArticleId
    FROM ${getComparisonProjectServingArticleSourceSql(searchQuery, params.comparisonProjectId)} article
    INNER JOIN active_generation active ON active.generation = article.generation
    ${conflictResolutionJoin}
    WHERE article.comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND ${rowFilterPredicate}
      AND ${differenceFilterPredicate}
      AND ${articleCategoryFilterPredicate}
      AND ${conflictResolutionFilterPredicate}
      AND ${getComparisonProjectServingProvenancePredicateSql(params)}
      AND ${getComparisonProjectServingSearchPredicateSql(searchQuery)}
      ${getComparisonProjectServingCursorWhereSql(cursor)}
    ORDER BY article.row_sort_created_at DESC NULLS LAST, article.row_sort_title ASC, article.row_sort_article_id ASC
    LIMIT ${limit + 1}
  `
}
