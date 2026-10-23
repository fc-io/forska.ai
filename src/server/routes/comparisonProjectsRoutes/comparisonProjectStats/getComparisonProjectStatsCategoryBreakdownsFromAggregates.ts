import {
  getComparisonProjectStatsArticleCategory,
  getComparisonProjectStatsCountValue,
} from './comparisonProjectStatsAggregates.ts'
import type {
  ComparisonProjectStatsAggregateRow,
  ComparisonProjectStatsArticleCategory,
  ComparisonProjectStatsArticleCategoryCountRow,
  ComparisonProjectStatsCategoryBreakdown,
  ComparisonProjectStatsColumn,
  ComparisonProjectStatsComparisonGroup,
  ComparisonProjectStatsConflictResolutionAnswerComparisonGroup,
  ComparisonProjectStatsResolvedTruthAggregateRow,
  ComparisonProjectStatsResolvedTruthComparisonGroup,
} from './comparisonProjectStatsTypes.ts'
import {getComparisonProjectAdditionalStatsFromAggregates} from './getComparisonProjectAdditionalStatsFromAggregates.ts'
import {getComparisonProjectConflictResolutionAnswerStatsFromAggregates} from './getComparisonProjectConflictResolutionAnswerStatsFromAggregates.ts'
import {getComparisonProjectStatsFromAggregates} from './getComparisonProjectStatsFromAggregates.ts'

const comparisonProjectStatsArticleCategories = ['chinese', 'non_chinese'] as const
const comparisonProjectStatsArticleCategoryLabels = {chinese: 'Chinese', non_chinese: 'Non-Chinese'} satisfies Record<
  ComparisonProjectStatsArticleCategory,
  string
>

const emptyComparisonProjectStatsArticleCategoryCounts = {chinese: 0, non_chinese: 0} satisfies Record<
  ComparisonProjectStatsArticleCategory,
  number
>

const getComparisonProjectStatsArticleCategoryCounts = (
  rows: readonly ComparisonProjectStatsArticleCategoryCountRow[],
) => {
  return rows.reduce<Record<ComparisonProjectStatsArticleCategory, number>>((counts, row) => {
    const articleCategory = getComparisonProjectStatsArticleCategory(row.articleCategory)

    return articleCategory
      ? {...counts, [articleCategory]: counts[articleCategory] + getComparisonProjectStatsCountValue(row.articleCount)}
      : counts
  }, emptyComparisonProjectStatsArticleCategoryCounts)
}

const getComparisonProjectStatsCategoryBreakdown = (params: {
  aggregateRows: readonly ComparisonProjectStatsAggregateRow[]
  articleCategory: ComparisonProjectStatsArticleCategory
  articleCount: number
  columns: readonly ComparisonProjectStatsColumn[]
  conflictResolutionAnswerAggregateRows: readonly ComparisonProjectStatsAggregateRow[]
  conflictResolutionAnswerGroups: readonly ComparisonProjectStatsConflictResolutionAnswerComparisonGroup[]
  groups: readonly ComparisonProjectStatsComparisonGroup[]
  isSummaryMode: boolean
  resolvedTruthAggregateRows: readonly ComparisonProjectStatsResolvedTruthAggregateRow[]
  resolvedTruthGroups: readonly ComparisonProjectStatsResolvedTruthComparisonGroup[]
}): ComparisonProjectStatsCategoryBreakdown => {
  const additionalProjectStats = getComparisonProjectAdditionalStatsFromAggregates({
    aggregateRows: params.resolvedTruthAggregateRows,
    articleCategory: params.articleCategory,
    groups: params.resolvedTruthGroups,
  })

  return {
    additionalProjectStats: {
      ...additionalProjectStats,
      conflictResolutionAnswerComparisons: getComparisonProjectConflictResolutionAnswerStatsFromAggregates({
        aggregateRows: params.conflictResolutionAnswerAggregateRows,
        articleCategory: params.articleCategory,
        groups: params.conflictResolutionAnswerGroups,
      }),
    },
    articleCount: params.articleCount,
    category: params.articleCategory,
    comparisons: getComparisonProjectStatsFromAggregates({
      aggregateRows: params.aggregateRows,
      articleCategory: params.articleCategory,
      columns: params.columns,
      groups: params.groups,
      isSummaryMode: params.isSummaryMode,
    }),
    label: comparisonProjectStatsArticleCategoryLabels[params.articleCategory],
  }
}

export const getComparisonProjectStatsCategoryBreakdownsFromAggregates = (params: {
  aggregateRows: readonly ComparisonProjectStatsAggregateRow[]
  articleCategoryCountRows: readonly ComparisonProjectStatsArticleCategoryCountRow[]
  columns: readonly ComparisonProjectStatsColumn[]
  conflictResolutionAnswerAggregateRows: readonly ComparisonProjectStatsAggregateRow[]
  conflictResolutionAnswerGroups: readonly ComparisonProjectStatsConflictResolutionAnswerComparisonGroup[]
  groups: readonly ComparisonProjectStatsComparisonGroup[]
  isSummaryMode: boolean
  resolvedTruthAggregateRows: readonly ComparisonProjectStatsResolvedTruthAggregateRow[]
  resolvedTruthGroups: readonly ComparisonProjectStatsResolvedTruthComparisonGroup[]
}) => {
  const articleCategoryCounts = getComparisonProjectStatsArticleCategoryCounts(params.articleCategoryCountRows)

  return comparisonProjectStatsArticleCategories.map((articleCategory) => {
    return getComparisonProjectStatsCategoryBreakdown({
      ...params,
      articleCategory,
      articleCount: articleCategoryCounts[articleCategory],
    })
  })
}
