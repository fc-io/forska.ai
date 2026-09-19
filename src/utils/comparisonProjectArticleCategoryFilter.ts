import {getComparisonProjectCanonicalFilterSelection} from './comparisonProjectFilterSelection.ts'

export const comparisonProjectArticleCategoryFilters = ['all', 'chinese', 'non_chinese'] as const

export type ComparisonProjectArticleCategoryFilter = (typeof comparisonProjectArticleCategoryFilters)[number]

export const comparisonProjectArticleCategories = ['chinese', 'non_chinese'] as const

export type ComparisonProjectArticleCategory = (typeof comparisonProjectArticleCategories)[number]

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

export const getNormalizedComparisonProjectArticleCategoryFilters = (
  value: unknown,
): ComparisonProjectArticleCategory[] => {
  return getComparisonProjectCanonicalFilterSelection(value, comparisonProjectArticleCategories)
}

export const getComparisonProjectArticleCategoryFilterLabel = (
  articleCategoryFilter: ComparisonProjectArticleCategoryFilter,
) => {
  return articleCategoryFilter === 'chinese'
    ? 'Chinese'
    : articleCategoryFilter === 'non_chinese'
      ? 'Non-Chinese'
      : 'All'
}

export const getComparisonProjectArticleCategoryFiltersLabel = (
  articleCategoryFilters: readonly ComparisonProjectArticleCategory[],
) => {
  return articleCategoryFilters.length === 0
    ? getComparisonProjectArticleCategoryFilterLabel('all')
    : articleCategoryFilters.map(getComparisonProjectArticleCategoryFilterLabel).join(' + ')
}

export const getComparisonProjectArticleCategoryFilterOptions = () => {
  return comparisonProjectArticleCategories.map((articleCategory) => {
    return {label: getComparisonProjectArticleCategoryFilterLabel(articleCategory), value: articleCategory}
  })
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
