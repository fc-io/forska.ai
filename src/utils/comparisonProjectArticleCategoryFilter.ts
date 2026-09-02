export const comparisonProjectArticleCategoryFilters = ['all', 'chinese', 'non_chinese'] as const

export type ComparisonProjectArticleCategoryFilter = (typeof comparisonProjectArticleCategoryFilters)[number]

export const defaultComparisonProjectArticleCategoryFilter: ComparisonProjectArticleCategoryFilter = 'all'

export const getIsComparisonProjectArticleCategoryFilter = (
  value: unknown,
): value is ComparisonProjectArticleCategoryFilter => {
  return comparisonProjectArticleCategoryFilters.includes(value as ComparisonProjectArticleCategoryFilter)
}

export const getNormalizedComparisonProjectArticleCategoryFilter = (
  value: unknown,
): ComparisonProjectArticleCategoryFilter => {
  return getIsComparisonProjectArticleCategoryFilter(value) ? value : defaultComparisonProjectArticleCategoryFilter
}

export const getComparisonProjectArticleCategoryFilterLabel = (
  articleCategoryFilter: ComparisonProjectArticleCategoryFilter,
) => {
  return articleCategoryFilter === 'chinese'
    ? 'Chinese articles'
    : articleCategoryFilter === 'non_chinese'
      ? 'Non-Chinese articles'
      : 'All'
}

export type ComparisonProjectArticleCategoryBreakdown = {articleCount: number; category: 'chinese' | 'non_chinese'}

export const getHasComparisonProjectChineseArticles = (
  categoryBreakdowns: readonly ComparisonProjectArticleCategoryBreakdown[] | null | undefined,
) => {
  return (
    categoryBreakdowns?.some((breakdown) => {
      return breakdown.category === 'chinese' && breakdown.articleCount > 0
    }) ?? false
  )
}
