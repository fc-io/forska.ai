import {For, Show} from 'solid-js'

import type {
  ComparisonProjectStats,
  ComparisonProjectStatsArticleCategory,
  ComparisonProjectStatsCategoryBreakdown,
  ComparisonProjectStatsComparison,
  ComparisonProjectStatsResolvedTruthComparison,
  ComparisonProjectStatsTruthConfusionMetrics,
} from '../../../../../../services/comparisonProjectsService.ts'

type ComparisonProjectChineseStatsSectionProps = {stats: ComparisonProjectStats}

type ComparisonProjectCategoryResolvedTruthMetricRow = {
  articleCount: number
  categoryLabel: string
  comparison: ComparisonProjectStatsResolvedTruthComparison
  metrics: ComparisonProjectStatsTruthConfusionMetrics
  rater: 'Human' | 'LLM'
}

type ComparisonProjectCategoryAgreementMetricRow = {
  articleCount: number
  categoryLabel: string
  comparison: ComparisonProjectStatsComparison
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

const getResolvedTruthMetricRows = (stats: ComparisonProjectStats) => {
  return getOrderedCategoryBreakdowns(stats).flatMap((breakdown) => {
    return breakdown.additionalProjectStats.resolvedTruthComparisons.flatMap((comparison) => {
      return [
        {
          articleCount: breakdown.articleCount,
          categoryLabel: breakdown.label,
          comparison,
          metrics: comparison.humanMetrics,
          rater: 'Human',
        },
        {
          articleCount: breakdown.articleCount,
          categoryLabel: breakdown.label,
          comparison,
          metrics: comparison.llmMetrics,
          rater: 'LLM',
        },
      ]
    })
  })
}

const getAgreementMetricRows = (stats: ComparisonProjectStats) => {
  return getOrderedCategoryBreakdowns(stats).flatMap((breakdown) => {
    return breakdown.comparisons.map((comparison) => {
      return {articleCount: breakdown.articleCount, categoryLabel: breakdown.label, comparison}
    })
  })
}

const ComparisonProjectCategorySummaryBadges = (props: {breakdowns: ComparisonProjectStatsCategoryBreakdown[]}) => {
  return (
    <div class="mt-3 flex flex-wrap gap-2">
      <For each={props.breakdowns}>
        {(breakdown) => {
          return (
            <span class="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-medium text-gray-700">
              <span>{breakdown.label}</span>
              <span class="tabular-nums text-gray-900">{getCountLabel(breakdown.articleCount)}</span>
            </span>
          )
        }}
      </For>
    </div>
  )
}

const ComparisonProjectCategoryResolvedTruthTable = (props: {
  rows: ComparisonProjectCategoryResolvedTruthMetricRow[]
}) => {
  return (
    <div class="mt-3 overflow-x-auto">
      <table class="min-w-full divide-y divide-gray-200 text-xs">
        <thead>
          <tr>
            <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Category</th>
            <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">LLM</th>
            <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Rater</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Articles</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Resolved</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Accuracy</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
              Sensitivity
            </th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
              Specificity
            </th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Precision</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">NPV</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">F1</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
              Balanced accuracy
            </th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
              Truth prevalence
            </th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">TP</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">FP</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">TN</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">FN</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <For each={props.rows}>
            {(row) => {
              return (
                <tr>
                  <td class="px-2 py-1.5 text-gray-900">{row.categoryLabel}</td>
                  <td class="max-w-[24rem] px-2 py-1.5 text-gray-900">{row.comparison.label}</td>
                  <td class="px-2 py-1.5 text-gray-700">{row.rater}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">{getCountLabel(row.articleCount)}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getCountLabel(row.comparison.resolvedCount)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getRateLabel(row.metrics.accuracy)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getRateLabel(row.metrics.sensitivity)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getRateLabel(row.metrics.specificity)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getRateLabel(row.metrics.precision)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getRateLabel(row.metrics.negativePredictiveValue)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">{getRateLabel(row.metrics.f1)}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getRateLabel(row.metrics.balancedAccuracy)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getRateLabel(row.metrics.truthPrevalence)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getCountLabel(row.metrics.truePositiveCount)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getCountLabel(row.metrics.falsePositiveCount)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getCountLabel(row.metrics.trueNegativeCount)}
                  </td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                    {getCountLabel(row.metrics.falseNegativeCount)}
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

const ComparisonProjectCategoryAgreementTable = (props: {rows: ComparisonProjectCategoryAgreementMetricRow[]}) => {
  return (
    <div class="mt-3 overflow-x-auto">
      <table class="min-w-full divide-y divide-gray-200 text-xs">
        <thead>
          <tr>
            <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Category</th>
            <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Comparison</th>
            <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Articles</th>
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
                <tr>
                  <td class="px-2 py-1.5 text-gray-900">{row.categoryLabel}</td>
                  <td class="max-w-[28rem] px-2 py-1.5 text-gray-900">{row.comparison.label}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">{getCountLabel(row.articleCount)}</td>
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
  const resolvedTruthRows = () => {
    return getResolvedTruthMetricRows(props.stats)
  }
  const agreementRows = () => {
    return getAgreementMetricRows(props.stats)
  }
  const categoryBreakdowns = () => {
    return getOrderedCategoryBreakdowns(props.stats)
  }

  return (
    <Show when={getHasChineseArticles(props.stats)}>
      <section class="mt-6 border-t border-gray-200 pt-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-base font-semibold text-gray-900">Chinese vs Non-Chinese</h3>
          </div>
        </div>

        <ComparisonProjectCategorySummaryBadges breakdowns={categoryBreakdowns()} />

        <Show
          when={resolvedTruthRows().length > 0}
          fallback={<ComparisonProjectCategoryAgreementTable rows={agreementRows()} />}
        >
          <ComparisonProjectCategoryResolvedTruthTable rows={resolvedTruthRows()} />
        </Show>
      </section>
    </Show>
  )
}
