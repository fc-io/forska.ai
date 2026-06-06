import {For, Show} from 'solid-js'

import type {
  ComparisonProjectJudgmentsColumn,
  ComparisonProjectStats,
  ComparisonProjectStatsComparison,
} from '../../../../../services/comparisonProjectsService.ts'
import {ComparisonProjectAdditionalStatsSection} from './comparisonProjectStatsCard/comparisonProjectAdditionalStatsSection.tsx'

type ComparisonProjectStatsCardProps = {
  columns: ComparisonProjectJudgmentsColumn[]
  error: unknown
  isError: boolean
  isLoading: boolean
  stats: ComparisonProjectStats | undefined
}

type ComparisonProjectStatsLabelColumn = ComparisonProjectJudgmentsColumn & {projectName: string | null}

const summaryPromptId = 'summary'

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

const getColumnLabelPart = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''

  return trimmedValue.length > 0 ? trimmedValue : null
}

const getColumnSourceProjectKey = (column: ComparisonProjectJudgmentsColumn) => {
  return getColumnLabelPart(column.sourceProjectId) ?? getColumnLabelPart(column.sourceProjectName)
}

const getAmbiguousLlmModelLabels = (columns: readonly ComparisonProjectJudgmentsColumn[]) => {
  const sourceProjectKeysByModelLabel = columns
    .filter((column) => {
      return column.kind === 'llm'
    })
    .reduce<Map<string, Set<string>>>((sourceProjectKeyMap, column) => {
      const modelLabel = getColumnLabelPart(column.modelLabel)
      const sourceProjectKey = getColumnSourceProjectKey(column)

      if (!modelLabel || !sourceProjectKey) {
        return sourceProjectKeyMap
      }

      const sourceProjectKeys = sourceProjectKeyMap.get(modelLabel) ?? new Set<string>()

      sourceProjectKeys.add(sourceProjectKey)
      sourceProjectKeyMap.set(modelLabel, sourceProjectKeys)
      return sourceProjectKeyMap
    }, new Map<string, Set<string>>())

  return new Set(
    Array.from(sourceProjectKeysByModelLabel.entries())
      .filter(([, sourceProjectKeys]) => {
        return sourceProjectKeys.size > 1
      })
      .map(([modelLabel]) => {
        return modelLabel
      }),
  )
}

const getComparisonColumnsById = (columns: readonly ComparisonProjectJudgmentsColumn[]) => {
  return columns.reduce<Map<string, ComparisonProjectJudgmentsColumn>>((columnMap, column) => {
    columnMap.set(column.id, column)
    return columnMap
  }, new Map<string, ComparisonProjectJudgmentsColumn>())
}

const getComparisonProjectStatsLabelColumn = (
  column: ComparisonProjectJudgmentsColumn,
  ambiguousLlmModelLabels: ReadonlySet<string>,
): ComparisonProjectStatsLabelColumn => {
  const modelLabel = getColumnLabelPart(column.modelLabel)
  const sourceProjectName = getColumnLabelPart(column.sourceProjectName)
  const projectName =
    column.kind === 'llm' && modelLabel && sourceProjectName && ambiguousLlmModelLabels.has(modelLabel)
      ? sourceProjectName
      : null

  return {...column, projectName}
}

const getComparisonProjectStatsLabelColumns = (
  comparison: ComparisonProjectStatsComparison,
  columns: readonly ComparisonProjectJudgmentsColumn[],
) => {
  const columnsById = getComparisonColumnsById(columns)
  const leftColumn = columnsById.get(comparison.leftColumnId)
  const rightColumn = columnsById.get(comparison.rightColumnId)
  const ambiguousLlmModelLabels = getAmbiguousLlmModelLabels(columns)

  if (!leftColumn || !rightColumn) {
    return null
  }

  const firstColumn = comparison.kind === 'llm-vs-llm' ? leftColumn : rightColumn
  const secondColumn = comparison.kind === 'llm-vs-llm' ? rightColumn : leftColumn

  return [
    getComparisonProjectStatsLabelColumn(firstColumn, ambiguousLlmModelLabels),
    getComparisonProjectStatsLabelColumn(secondColumn, ambiguousLlmModelLabels),
  ] as const
}

const getComparisonProjectStatsColumnRaterLabel = (column: ComparisonProjectStatsLabelColumn) => {
  return column.kind === 'human' ? 'Human' : (getColumnLabelPart(column.modelLabel) ?? column.projectName ?? 'LLM')
}

const getComparisonProjectStatsPromptLabel = (column: ComparisonProjectStatsLabelColumn) => {
  return column.promptId === summaryPromptId ? null : getColumnLabelPart(column.promptLabel)
}

const getComparisonProjectStatsConflictResolutionLabel = (comparison: ComparisonProjectStatsComparison) => {
  return comparison.kind === 'llm-vs-conflict-resolution'
    ? 'Conflict resolution (fallback to human answer if no resolution provided)'
    : 'Conflict resolution (no fallback)'
}

const getIsComparisonProjectStatsConflictResolutionComparison = (comparison: ComparisonProjectStatsComparison) => {
  return (
    comparison.kind === 'llm-vs-conflict-resolution'
    || comparison.kind === 'llm-vs-conflict-resolution-no-fallback'
    || comparison.kind === 'human-vs-conflict-resolution'
  )
}

const ComparisonProjectStatsLabelSide = (props: {column: ComparisonProjectStatsLabelColumn}) => {
  return (
    <span class="inline-flex flex-wrap items-baseline gap-x-1">
      <span>{getComparisonProjectStatsColumnRaterLabel(props.column)}</span>
      <Show when={props.column.projectName}>
        {(projectName) => {
          return (
            <span class="inline-flex rounded-full bg-violet-100 px-2 py-0.5 text-xs font-bold text-violet-800 ring-1 ring-inset ring-violet-200">
              {projectName()}
            </span>
          )
        }}
      </Show>
      <Show when={getComparisonProjectStatsPromptLabel(props.column)}>
        {(promptLabel) => {
          return <span class="text-gray-700">- {promptLabel()}</span>
        }}
      </Show>
    </span>
  )
}

const ComparisonProjectStatsComparisonLabel = (props: {
  columns: ComparisonProjectJudgmentsColumn[]
  comparison: ComparisonProjectStatsComparison
}) => {
  return (
    <Show
      when={getComparisonProjectStatsLabelColumns(props.comparison, props.columns)}
      fallback={<span>{props.comparison.label}</span>}
    >
      {(labelColumns) => {
        return (
          <span class="inline-flex flex-wrap items-baseline gap-x-1.5">
            <ComparisonProjectStatsLabelSide column={labelColumns()[0]} />
            <span class="text-gray-500">vs</span>
            <Show
              when={getIsComparisonProjectStatsConflictResolutionComparison(props.comparison)}
              fallback={<ComparisonProjectStatsLabelSide column={labelColumns()[1]} />}
            >
              <span>{getComparisonProjectStatsConflictResolutionLabel(props.comparison)}</span>
            </Show>
          </span>
        )
      }}
    </Show>
  )
}

export const ComparisonProjectStatsCard = (props: ComparisonProjectStatsCardProps) => {
  return (
    <div class="rounded-lg bg-white p-6 shadow">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold">Project Stats</h2>
          <p class="mt-1 text-sm text-gray-600">
            Conflicts compare exact answers. True Conflicts, Cohen's Kappa, sensitivity, and specificity compare Include
            vs Exclude decisions, with Yes/Maybe as Include and No as Exclude. Sensitivity and specificity use the
            comparison's reference side: Human for Human rows. Conflict resolution (no fallback) rows include saved
            binary resolutions only. Conflict resolution (fallback to human answer if no resolution provided) rows keep
            the LLM/Human overlap denominator, using saved resolutions when present and Human otherwise.
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
          <table class="min-w-full divide-y divide-gray-200 text-xs">
            <thead>
              <tr>
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
              <For each={props.stats?.comparisons ?? []}>
                {(comparison) => {
                  return (
                    <tr>
                      <td class="max-w-[32rem] px-2 py-1.5 text-gray-900">
                        <ComparisonProjectStatsComparisonLabel columns={props.columns} comparison={comparison} />
                      </td>
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
                        {getKappaLabel(comparison.cohensKappa)}
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

      <Show when={!props.isLoading && !props.isError && props.stats}>
        {(stats) => {
          return <ComparisonProjectAdditionalStatsSection stats={stats()} />
        }}
      </Show>
    </div>
  )
}
