import {For, Show} from 'solid-js'

import type {ComparisonProjectStats} from '../../../../../services/comparisonProjectsService.ts'

type ComparisonProjectStatsCardProps = {
  error: unknown
  isError: boolean
  isLoading: boolean
  stats: ComparisonProjectStats | undefined
}

const getCountLabel = (value: number) => {
  return value.toLocaleString()
}

const getKappaLabel = (value: number | null) => {
  return value === null ? 'N/A' : value.toFixed(3)
}

const getRateLabel = (value: number | null) => {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`
}

const getComparisonProjectStatsErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : 'Failed to load project stats'
}

export const ComparisonProjectStatsCard = (props: ComparisonProjectStatsCardProps) => {
  return (
    <div class="rounded-lg bg-white p-6 shadow">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">Project Stats</h2>
          <p class="mt-1 text-sm text-gray-600">
            Conflicts compare exact answers. True Conflicts, Cohen's Kappa, sensitivity, and specificity compare Include
            vs Exclude decisions, with Yes/Maybe as Include and No as Exclude. Sensitivity and specificity use Human
            decisions as the reference. If there is no Human column, they use Conflict resolution instead.
          </p>
        </div>
      </div>

      <Show when={props.isLoading}>
        <div class="mt-4 rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
          Loading project stats...
        </div>
      </Show>

      <Show when={!props.isLoading && props.isError}>
        <div class="mt-4 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {getComparisonProjectStatsErrorMessage(props.error)}
        </div>
      </Show>

      <Show when={!props.isLoading && !props.isError && props.stats?.comparisons.length === 0}>
        <div class="mt-4 rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
          No project stats are available yet.
        </div>
      </Show>

      <Show when={!props.isLoading && !props.isError && (props.stats?.comparisons.length ?? 0) > 0}>
        <div class="mt-4 overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-200 text-sm">
            <thead>
              <tr>
                <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Comparison
                </th>
                <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Column Info
                </th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Overlap
                </th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Conflicts
                </th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                  True Conflicts
                </th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Cohen's Kappa
                  <span class="block normal-case tracking-normal">Include vs Exclude</span>
                </th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Sensitivity
                  <span class="block normal-case tracking-normal">Human Include</span>
                </th>
                <th class="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Specificity
                  <span class="block normal-case tracking-normal">Human Exclude</span>
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <For each={props.stats?.comparisons ?? []}>
                {(comparison) => {
                  return (
                    <tr>
                      <td class="max-w-[32rem] px-3 py-3 text-gray-900">{comparison.label}</td>
                      <td class="max-w-[18rem] px-3 py-3 text-gray-600">{comparison.columnInfo ?? 'N/A'}</td>
                      <td class="px-3 py-3 text-right tabular-nums text-gray-700">
                        {getCountLabel(comparison.overlapCount)}
                      </td>
                      <td class="px-3 py-3 text-right tabular-nums text-gray-700">
                        {getCountLabel(comparison.conflictCount)}
                      </td>
                      <td class="px-3 py-3 text-right tabular-nums text-gray-700">
                        {getCountLabel(comparison.trueConflictCount)}
                      </td>
                      <td class="px-3 py-3 text-right tabular-nums text-gray-700">
                        {getKappaLabel(comparison.cohensKappa)}
                      </td>
                      <td class="px-3 py-3 text-right tabular-nums text-gray-700">
                        {getRateLabel(comparison.sensitivity)}
                      </td>
                      <td class="px-3 py-3 text-right tabular-nums text-gray-700">
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
    </div>
  )
}
