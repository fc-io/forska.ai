import {For, Show} from 'solid-js'

import type {
  ComparisonProjectAdditionalStats,
  ComparisonProjectStats,
  ComparisonProjectStatsResolvedTruthComparison,
  ComparisonProjectStatsTruthConfusionMetrics,
} from '../../../../../../services/comparisonProjectsService.ts'
import {ComparisonProjectChineseStatsSection} from './comparisonProjectChineseStatsSection.tsx'

type ComparisonProjectAdditionalStatsSectionProps = {stats: ComparisonProjectStats}

type ComparisonProjectStatsConfusionMetricRow = {
  comparisonId: string
  label: string
  metrics: ComparisonProjectStatsTruthConfusionMetrics
  rater: 'Human' | 'LLM'
}

const getCountLabel = (value: number) => {
  return value.toLocaleString()
}

const getSignedCountLabel = (value: number) => {
  return value > 0 ? `+${getCountLabel(value)}` : getCountLabel(value)
}

const getRateLabel = (value: number | null) => {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`
}

const getScoreLabel = (value: number | null) => {
  return value === null ? 'N/A' : value.toFixed(3)
}

const getConfusionMetricRows = (
  comparisons: readonly ComparisonProjectStatsResolvedTruthComparison[],
): ComparisonProjectStatsConfusionMetricRow[] => {
  return comparisons.flatMap((comparison) => {
    return [
      {comparisonId: comparison.id, label: comparison.label, metrics: comparison.humanMetrics, rater: 'Human'},
      {comparisonId: comparison.id, label: comparison.label, metrics: comparison.llmMetrics, rater: 'LLM'},
    ]
  })
}

const getResolvedTruthComparisons = (additionalStats: ComparisonProjectAdditionalStats) => {
  return additionalStats.resolvedTruthComparisons
}

const getConflictResolutionAnswerComparisons = (additionalStats: ComparisonProjectAdditionalStats) => {
  return additionalStats.conflictResolutionAnswerComparisons
}

export const ComparisonProjectAdditionalStatsSection = (props: ComparisonProjectAdditionalStatsSectionProps) => {
  const additionalStats = () => {
    return props.stats.additionalProjectStats
  }

  return (
    <details class="group mt-6 border-t border-gray-200 pt-4">
      <summary class="flex cursor-pointer list-none items-start justify-between gap-3">
        <div>
          <h3 class="text-base font-semibold text-gray-900">Additional Project Stats</h3>
          <p class="mt-1 text-sm text-gray-600">
            Expand to compare Human and LLM performance against saved adjudicated truth without changing the main
            Project Stats table.
          </p>
        </div>
        <span class="inline-flex shrink-0 items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50">
          <span class="group-open:hidden">Expand</span>
          <span class="hidden group-open:inline">Collapse</span>
        </span>
      </summary>

      <div class="mt-4 space-y-5">
        <section>
          <div>
            <h4 class="text-sm font-semibold text-gray-900">Conflict resolution stats by answer</h4>
            <p class="mt-1 text-sm text-gray-600">
              No-fallback conflict-resolution comparisons recalculated on articles where the listed model or Human
              answer is present.
            </p>
          </div>

          <Show when={getConflictResolutionAnswerComparisons(additionalStats()).length === 0}>
            <div class="mt-3 rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
              No answer-sliced conflict resolution stats are available yet.
            </div>
          </Show>

          <Show when={getConflictResolutionAnswerComparisons(additionalStats()).length > 0}>
            <div class="mt-3 overflow-x-auto">
              <table class="min-w-full divide-y divide-gray-200 text-xs">
                <thead>
                  <tr>
                    <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Answer slice
                    </th>
                    <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Comparison
                    </th>
                    <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Column Info
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Overlap
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Conflicts
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      True Conflicts
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Cohen's Kappa
                      <span class="block normal-case tracking-normal">Include vs Exclude</span>
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Sensitivity
                      <span class="block normal-case tracking-normal">Reference Include</span>
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Specificity
                      <span class="block normal-case tracking-normal">Reference Exclude</span>
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100">
                  <For each={getConflictResolutionAnswerComparisons(additionalStats())}>
                    {(comparison) => {
                      return (
                        <tr>
                          <td class="max-w-[18rem] px-2 py-1.5 text-gray-900">{comparison.answerFilterLabel}</td>
                          <td class="max-w-[28rem] px-2 py-1.5 text-gray-900">{comparison.label}</td>
                          <td class="max-w-[18rem] px-2 py-1.5 text-gray-600">{comparison.columnInfo ?? 'N/A'}</td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getCountLabel(comparison.overlapCount)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getCountLabel(comparison.conflictCount)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getCountLabel(comparison.trueConflictCount)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getScoreLabel(comparison.cohensKappa)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getRateLabel(comparison.sensitivity)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getRateLabel(comparison.specificity)}
                          </td>
                        </tr>
                      )
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </section>

        <section>
          <div>
            <h4 class="text-sm font-semibold text-gray-900">No-fallback truth comparison</h4>
            <p class="mt-1 text-sm text-gray-600">
              Rows include articles where Human, the LLM, and the saved conflict resolution all have one binary Include
              or Exclude decision. McNemar chi-square uses the paired Human-only and LLM-only correct counts.
            </p>
          </div>

          <Show when={getResolvedTruthComparisons(additionalStats()).length === 0}>
            <div class="mt-3 rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
              No truth comparison stats with no fallback are available yet.
            </div>
          </Show>

          <Show when={getResolvedTruthComparisons(additionalStats()).length > 0}>
            <div class="mt-3 overflow-x-auto">
              <table class="min-w-full divide-y divide-gray-200 text-xs">
                <thead>
                  <tr>
                    <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">LLM</th>
                    <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Column Info
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Resolved count
                      <span class="block normal-case tracking-normal">Human, LLM, truth</span>
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Human correct vs truth
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Human errors vs truth
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      LLM correct vs truth
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      LLM errors vs truth
                    </th>
                    <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Winner
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Both correct
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Both wrong
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Human only correct
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      LLM only correct
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      LLM advantage
                      <span class="block normal-case tracking-normal">LLM-only minus Human-only</span>
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      McNemar chi-square
                      <span class="block normal-case tracking-normal">paired discordance</span>
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100">
                  <For each={getResolvedTruthComparisons(additionalStats())}>
                    {(comparison) => {
                      return (
                        <tr>
                          <td class="max-w-[28rem] px-2 py-1.5 text-gray-900">{comparison.label}</td>
                          <td class="max-w-[18rem] px-2 py-1.5 text-gray-600">{comparison.columnInfo ?? 'N/A'}</td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getCountLabel(comparison.resolvedCount)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getCountLabel(comparison.humanCorrectVsTruthCount)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getCountLabel(comparison.humanErrorsVsTruthCount)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getCountLabel(comparison.llmCorrectVsTruthCount)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getCountLabel(comparison.llmErrorsVsTruthCount)}
                          </td>
                          <td class="px-2 py-1.5 text-gray-700">{comparison.winner}</td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getCountLabel(comparison.bothCorrectCount)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getCountLabel(comparison.bothWrongCount)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getCountLabel(comparison.humanOnlyCorrectCount)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getCountLabel(comparison.llmOnlyCorrectCount)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getSignedCountLabel(comparison.llmAdvantage)}
                          </td>
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getScoreLabel(comparison.mcnemarChiSquare)}
                          </td>
                        </tr>
                      )
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </section>

        <Show when={getResolvedTruthComparisons(additionalStats()).length > 0}>
          <section>
            <div>
              <h4 class="text-sm font-semibold text-gray-900">Confusion matrix metrics</h4>
              <p class="mt-1 text-sm text-gray-600">
                Metrics use adjudicated truth as the reference. TP, FP, TN, and FN are Include or Exclude counts;
                derived rates show N/A when the denominator is zero or the backend value is null.
              </p>
            </div>

            <div class="mt-3 overflow-x-auto">
              <table class="min-w-full divide-y divide-gray-200 text-xs">
                <thead>
                  <tr>
                    <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">LLM</th>
                    <th class="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Rater
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Accuracy
                      <span class="block normal-case tracking-normal">correct over resolved</span>
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Sensitivity
                      <span class="block normal-case tracking-normal">truth Include found</span>
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Specificity
                      <span class="block normal-case tracking-normal">truth Exclude found</span>
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Precision
                      <span class="block normal-case tracking-normal">predicted Include correct</span>
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      NPV
                      <span class="block normal-case tracking-normal">predicted Exclude correct</span>
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      F1
                      <span class="block normal-case tracking-normal">Include precision and sensitivity</span>
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Balanced accuracy
                      <span class="block normal-case tracking-normal">sensitivity and specificity mean</span>
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Truth prevalence
                      <span class="block normal-case tracking-normal">truth Include share</span>
                    </th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">TP</th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">FP</th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">TN</th>
                    <th class="px-2 py-1 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">FN</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100">
                  <For each={getConfusionMetricRows(getResolvedTruthComparisons(additionalStats()))}>
                    {(row) => {
                      return (
                        <tr>
                          <td class="max-w-[28rem] px-2 py-1.5 text-gray-900">{row.label}</td>
                          <td class="px-2 py-1.5 text-gray-700">{row.rater}</td>
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
                          <td class="px-2 py-1.5 text-right tabular-nums text-gray-700">
                            {getRateLabel(row.metrics.f1)}
                          </td>
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
          </section>
        </Show>

        <ComparisonProjectChineseStatsSection stats={props.stats} />
      </div>
    </details>
  )
}
