import {Show} from 'solid-js'

import type {
  ComparisonProjectStats,
  ComparisonProjectStatsComparison,
  ComparisonProjectStatsConflictResolutionProvenance,
} from '../../../../../../services/comparisonProjectsService.ts'

const conflictResolutionStatsLabels = {
  all: {
    fallback: 'Conflict resolution (fallback to human answer if no resolution provided)',
    noFallback: 'Conflict resolution (no fallback)',
  },
  current: {
    fallback:
      'Conflict resolution under the current prompts (fallback to human answer if no current-prompt resolution)',
    noFallback: 'Conflict resolution under the current prompts (no fallback)',
  },
} satisfies Record<ComparisonProjectStatsConflictResolutionProvenance, {fallback: string; noFallback: string}>

export const getComparisonProjectStatsConflictResolutionScope = (
  stats: Pick<ComparisonProjectStats, 'conflictResolutionProvenance'> | undefined,
): ComparisonProjectStatsConflictResolutionProvenance => {
  return stats?.conflictResolutionProvenance === 'current' ? 'current' : 'all'
}

export const getComparisonProjectStatsConflictResolutionLabel = (
  comparison: ComparisonProjectStatsComparison,
  scope: ComparisonProjectStatsConflictResolutionProvenance,
) => {
  const labels = conflictResolutionStatsLabels[scope]

  return comparison.kind === 'llm-vs-conflict-resolution' ? labels.fallback : labels.noFallback
}

export const getComparisonProjectStatsConflictResolutionHeading = (
  heading: string,
  stats: Pick<ComparisonProjectStats, 'conflictResolutionProvenance'>,
) => {
  return getComparisonProjectStatsConflictResolutionScope(stats) === 'current'
    ? `${heading} (current prompts only)`
    : heading
}

export const ComparisonProjectStatsProvenanceToggle = (props: {
  checked: boolean
  onChange: (value: ComparisonProjectStatsConflictResolutionProvenance) => void
}) => {
  return (
    <label class="inline-flex items-center gap-2 text-sm font-medium text-gray-700">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => {
          props.onChange(event.currentTarget.checked ? 'current' : 'all')
        }}
        class="h-4 w-4 rounded border-gray-300"
      />
      <span>Only resolutions made under the current prompts</span>
    </label>
  )
}

export const ComparisonProjectStatsProvenanceScopeNote = (props: {stats: ComparisonProjectStats | undefined}) => {
  return (
    <Show when={getComparisonProjectStatsConflictResolutionScope(props.stats) === 'current'}>
      <p class="mt-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
        Conflict resolution comparisons below use only resolutions made under the current prompts.
        <Show when={props.stats?.judgmentContextId === null}>
          {' '}
          The current prompts are not recorded yet, so no resolution counts as current.
        </Show>
      </p>
    </Show>
  )
}
