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
      'Conflict resolution under the current prompts (fallback to human answer if no resolution provided; articles resolved under other prompts excluded)',
    noFallback: 'Conflict resolution under the current prompts (no fallback)',
  },
} satisfies Record<ComparisonProjectStatsConflictResolutionProvenance, {fallback: string; noFallback: string}>

type ComparisonProjectStatsScopeSource = Pick<ComparisonProjectStats, 'conflictResolutionProvenanceScope'> | undefined

export const getComparisonProjectStatsConflictResolutionScope = (
  stats: ComparisonProjectStatsScopeSource,
): ComparisonProjectStatsConflictResolutionProvenance => {
  const scope = stats?.conflictResolutionProvenanceScope

  return scope?.requested === 'current' && scope.applied ? 'current' : 'all'
}

export const getIsComparisonProjectStatsCurrentScopeNotApplied = (stats: ComparisonProjectStatsScopeSource) => {
  const scope = stats?.conflictResolutionProvenanceScope

  return scope?.requested === 'current' && !scope.applied
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
  stats: ComparisonProjectStatsScopeSource,
) => {
  return getComparisonProjectStatsConflictResolutionScope(stats) === 'current'
    ? `${heading} (current prompts only)`
    : heading
}

export const ComparisonProjectStatsProvenanceToggle = (props: {
  checked: boolean
  isNotApplied: boolean
  onChange: (value: ComparisonProjectStatsConflictResolutionProvenance) => void
}) => {
  return (
    <div class="flex max-w-xs flex-col items-end gap-1">
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
      <Show when={props.isNotApplied}>
        <p class="text-right text-xs text-amber-700">
          Current prompts are not known for this generation yet; showing all resolutions
        </p>
      </Show>
    </div>
  )
}

export const ComparisonProjectStatsProvenanceScopeNote = (props: {stats: ComparisonProjectStats | undefined}) => {
  return (
    <Show when={getComparisonProjectStatsConflictResolutionScope(props.stats) === 'current'}>
      <p class="mt-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
        Conflict resolution comparisons below use only resolutions made under the current prompts.
      </p>
    </Show>
  )
}
