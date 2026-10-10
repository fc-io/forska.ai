import {format} from 'date-fns'
import {Show} from 'solid-js'

import type {
  ComparisonJudgmentContextSummary,
  ComparisonProjectConflictResolutionProvenance as ComparisonProjectConflictResolutionProvenanceValue,
  ComparisonProjectConflictResolutionValue,
} from '../../../services/comparisonProjectsService.ts'
import {
  type ComparisonJudgmentContextSummariesById,
  getComparisonJudgmentContextSummaryLines,
} from '../../../utils/comparisonJudgmentContextSummary.ts'

type ComparisonProjectConflictResolutionProvenanceProps = {
  currentJudgmentContext: ComparisonJudgmentContextSummary | null
  judgmentContextsById: ComparisonJudgmentContextSummariesById
  resolution: ComparisonProjectConflictResolutionValue | null
}

const conflictResolutionProvenanceHeadings = {
  current: 'Resolved under the current prompts',
  outdated: 'Resolved under older prompts',
  unknown: 'Unknown whether this was resolved under the current prompts',
}

const getReviewerName = (resolution: ComparisonProjectConflictResolutionValue) => {
  return resolution.reviewer?.displayName?.trim() || resolution.reviewerDisplayName?.trim() || null
}

const formatSetAt = (setAt: Date | string | null) => {
  const date = setAt ? new Date(setAt) : null

  return date && !Number.isNaN(date.getTime()) ? format(date, 'yyyy-MM-dd HH:mm') : null
}

const getSetAtLabel = (provenance: ComparisonProjectConflictResolutionProvenanceValue | null) => {
  const setAt = formatSetAt(provenance?.setAt ?? null)

  return setAt && provenance?.origin && provenance.origin !== 'ui' ? `imported ${setAt}` : setAt
}

export const getConflictResolutionProvenanceLabel = (resolution: ComparisonProjectConflictResolutionValue | null) => {
  const parts = resolution ? [getReviewerName(resolution), getSetAtLabel(resolution.provenance)].filter(Boolean) : []

  return parts.length > 0 ? parts.join(' · ') : null
}

const getConflictResolutionProvenanceHeading = (matchesCurrent: boolean | null) => {
  return matchesCurrent === null
    ? conflictResolutionProvenanceHeadings.unknown
    : conflictResolutionProvenanceHeadings[matchesCurrent ? 'current' : 'outdated']
}

export const getConflictResolutionProvenanceTitle = (params: {
  currentJudgmentContext: ComparisonJudgmentContextSummary | null
  judgmentContext: ComparisonJudgmentContextSummary | null
  matchesCurrent: boolean | null
}) => {
  const contextLines = params.judgmentContext
    ? getComparisonJudgmentContextSummaryLines(params.judgmentContext, params.currentJudgmentContext)
    : []

  return [getConflictResolutionProvenanceHeading(params.matchesCurrent), ...contextLines].join('\n')
}

export const ComparisonProjectConflictResolutionProvenance = (
  props: ComparisonProjectConflictResolutionProvenanceProps,
) => {
  const label = () => {
    return getConflictResolutionProvenanceLabel(props.resolution)
  }
  const isOutdated = () => {
    return props.resolution?.provenanceMatchesCurrent === false
  }
  const title = () => {
    const contextId = props.resolution?.provenance?.contextId

    return getConflictResolutionProvenanceTitle({
      currentJudgmentContext: props.currentJudgmentContext,
      judgmentContext: contextId ? (props.judgmentContextsById[contextId] ?? null) : null,
      matchesCurrent: props.resolution?.provenanceMatchesCurrent ?? null,
    })
  }

  return (
    <Show when={label() || isOutdated()}>
      <div class="mt-1 flex flex-wrap items-center gap-1" title={title()}>
        <Show when={label()}>
          {(provenanceLabel) => {
            return <p class="text-[11px] text-gray-500">{provenanceLabel()}</p>
          }}
        </Show>
        <Show when={isOutdated()}>
          <span class="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
            Older prompts
          </span>
        </Show>
      </div>
    </Show>
  )
}
