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
      : 'All article categories'
}
