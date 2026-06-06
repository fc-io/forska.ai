import {For, Show} from 'solid-js'

import type {
  ComparisonProjectStats,
  ComparisonProjectStatsArticleCategory,
  ComparisonProjectStatsCategoryBreakdown,
  ComparisonProjectStatsComparison,
} from '../../../../../../services/comparisonProjectsService.ts'

type ComparisonProjectChineseStatsSectionProps = {stats: ComparisonProjectStats}

type ComparisonProjectCategoryComparisonRow = {
  categoryLabel: string
  comparison: ComparisonProjectStatsComparison
  isTotal: boolean
}

const comparisonProjectStatsArticleCategoryOrder = [
  'chinese',
  'non_chinese',
] satisfies ComparisonProjectStatsArticleCategory[]

const getCountLabel = (value: number) => {
  return value.toLocaleString()
}

const getRateLabel = (value: number | null) => {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`
}

const getScoreLabel = (value: number | null) => {
  return value === null ? 'N/A' : value.toFixed(3)
}

const getComparisonProjectStatsCategoryBreakdown = (
  stats: ComparisonProjectStats,
  category: ComparisonProjectStatsArticleCategory,
) => {
  return stats.categoryBreakdowns.find((breakdown) => {
    return breakdown.category === category
  })
}

const getHasChineseArticles = (stats: ComparisonProjectStats) => {
  return (getComparisonProjectStatsCategoryBreakdown(stats, 'chinese')?.articleCount ?? 0) > 0
}

const getOrderedCategoryBreakdowns = (stats: ComparisonProjectStats) => {
  return comparisonProjectStatsArticleCategoryOrder
    .map((category) => {
      return getComparisonProjectStatsCategoryBreakdown(stats, category)
    })
    .filter((breakdown): breakdown is ComparisonProjectStatsCategoryBreakdown => {
      return breakdown !== undefined
    })
}

const getComparisonProjectCategoryComparison = (
  breakdown: ComparisonProjectStatsCategoryBreakdown,
  comparisonId: string,
) => {
  return breakdown.comparisons.find((comparison) => {
    return comparison.id === comparisonId
  })
}

const getComparisonProjectCategoryRows = (
  breakdowns: readonly ComparisonProjectStatsCategoryBreakdown[],
  totalComparison: ComparisonProjectStatsComparison,
) => {
  return breakdowns
    .map((breakdown) => {
      const comparison = getComparisonProjectCategoryComparison(breakdown, totalComparison.id)

      return comparison ? {categoryLabel: breakdown.label, comparison, isTotal: false} : null
    })
    .filter((row): row is ComparisonProjectCategoryComparisonRow => {
      return row !== null
    })
}

const getComparisonProjectCategoryComparisonRows = (stats: ComparisonProjectStats) => {
  const breakdowns = getOrderedCategoryBreakdowns(stats)

  return stats.comparisons.flatMap((totalComparison) => {
    return [
      ...getComparisonProjectCategoryRows(breakdowns, totalComparison),
      {categoryLabel: 'Total', comparison: totalComparison, isTotal: true},
    ]
  })
}

const getComparisonProjectCategoryComparisonRowClass = (row: ComparisonProjectCategoryComparisonRow) => {
  return row.isTotal ? 'bg-gray-50 font-semibold' : ''
}

const ComparisonProjectCategoryComparisonTable = (props: {rows: ComparisonProjectCategoryComparisonRow[]}) => {
  return (
    <div class="mt-3 overflow-x-auto">
      <table class="min-w-full divide-y divide-gray-200 text-xs">
        <thead>
          <tr>
            <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Comparison</th>
            <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Category</th>
            <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Column Info</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Overlap</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Conflicts</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
              True Conflicts
            </th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
              Cohen's Kappa
            </th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
              Sensitivity
            </th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
              Specificity
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <For each={props.rows}>
            {(row) => {
              return (
                <tr class={getComparisonProjectCategoryComparisonRowClass(row)}>
                  <td class="max-w-[28rem] px-2 py-1.5 text-gray-900">{row.comparison.label}</td>
                  <td class="px-2 py-1.5 text-gray-900">{row.categoryLabel}</td>
                  <td class="max-w-[18rem] px-2 py-1.5 text-gray-600">{row.comparison.columnInfo ?? 'N/A'}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getCountLabel(row.comparison.overlapCount)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getCountLabel(row.comparison.conflictCount)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getCountLabel(row.comparison.trueConflictCount)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getScoreLabel(row.comparison.cohensKappa)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getRateLabel(row.comparison.sensitivity)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getRateLabel(row.comparison.specificity)}
                  </td>
                </tr>
              )
            }}
          </For>
        </tbody>
      </table>
    </div>
  )
}

export const ComparisonProjectChineseStatsSection = (props: ComparisonProjectChineseStatsSectionProps) => {
  const categoryComparisonRows = () => {
    return getComparisonProjectCategoryComparisonRows(props.stats)
  }

  return (
    <Show when={getHasChineseArticles(props.stats)}>
      <section class="mt-6 border-t border-gray-200 pt-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-base font-semibold text-gray-900">Chinese vs Non-Chinese</h3>
            <p class="mt-1 text-sm text-gray-600">
              Same comparison pairs as Project Stats, with Chinese, Non-Chinese, and Total rows for each comparison.
              Counts use each row's overlap, conflicts, and binary Include vs Exclude denominators.
            </p>
          </div>
        </div>

        <ComparisonProjectCategoryComparisonTable rows={categoryComparisonRows()} />
      </section>
    </Show>
  )
}
