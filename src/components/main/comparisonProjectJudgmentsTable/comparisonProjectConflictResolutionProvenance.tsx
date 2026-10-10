import {format} from 'date-fns'
import {Show} from 'solid-js'

import type {
  ComparisonJudgmentContextSummary,
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

type ConflictResolutionProvenanceState = 'beforeTracking' | 'current' | 'outdated' | 'unknown'

const conflictResolutionProvenanceHeadings = {
  beforeTracking:
    'Resolved before prompt tracking: the reviewer is the account recorded at the time, and file imports from then may name the importer',
  current: 'Resolved under the current prompts',
  outdated: 'Resolved under older prompts',
  unknown: 'Unknown whether this was resolved under the current prompts',
} satisfies Record<ConflictResolutionProvenanceState, string>

const conflictResolutionMatchStates = {false: 'outdated', null: 'unknown', true: 'current'} satisfies Record<
  string,
  ConflictResolutionProvenanceState
>

const getReviewerName = (resolution: ComparisonProjectConflictResolutionValue) => {
  return resolution.reviewer?.displayName?.trim() || resolution.reviewerDisplayName?.trim() || null
}

const formatSetAt = (setAt: Date | string | null) => {
  const date = setAt ? new Date(setAt) : null

  return date && !Number.isNaN(date.getTime()) ? format(date, 'yyyy-MM-dd HH:mm') : null
}

const getIsImportedResolution = (resolution: ComparisonProjectConflictResolutionValue) => {
  const origin = resolution.provenance?.origin

  return Boolean(origin && origin !== 'ui')
}

const getSetAtLabel = (resolution: ComparisonProjectConflictResolutionValue) => {
  const setAt = formatSetAt(resolution.setAt ?? resolution.provenance?.setAt ?? null)

  return setAt && getIsImportedResolution(resolution) ? `imported ${setAt}` : setAt
}

const getConflictResolutionProvenanceState = (
  resolution: ComparisonProjectConflictResolutionValue,
): ConflictResolutionProvenanceState => {
  return resolution.provenance === null
    ? 'beforeTracking'
    : conflictResolutionMatchStates[String(resolution.provenanceMatchesCurrent) as 'false' | 'null' | 'true']
}

export const getConflictResolutionProvenanceLabelParts = (
  resolution: ComparisonProjectConflictResolutionValue | null,
) => {
  const reviewerName = resolution ? getReviewerName(resolution) : null

  return {
    isBeforeTracking: Boolean(reviewerName && resolution?.provenance === null),
    reviewerName,
    setAt: resolution ? getSetAtLabel(resolution) : null,
  }
}

export const getConflictResolutionProvenanceTitle = (params: {
  currentJudgmentContext: ComparisonJudgmentContextSummary | null
  judgmentContext: ComparisonJudgmentContextSummary | null
  resolution: ComparisonProjectConflictResolutionValue
}) => {
  const contextLines = params.judgmentContext
    ? getComparisonJudgmentContextSummaryLines(params.judgmentContext, params.currentJudgmentContext)
    : []

  return [
    conflictResolutionProvenanceHeadings[getConflictResolutionProvenanceState(params.resolution)],
    ...contextLines,
  ].join('\n')
}

export const ComparisonProjectConflictResolutionProvenance = (
  props: ComparisonProjectConflictResolutionProvenanceProps,
) => {
  const labelParts = () => {
    return getConflictResolutionProvenanceLabelParts(props.resolution)
  }
  const hasLabel = () => {
    return Boolean(labelParts().reviewerName || labelParts().setAt)
  }
  const isOutdated = () => {
    return props.resolution?.provenanceMatchesCurrent === false
  }
  const title = () => {
    const resolution = props.resolution
    const contextId = resolution?.provenance?.contextId

    return resolution
      ? getConflictResolutionProvenanceTitle({
          currentJudgmentContext: props.currentJudgmentContext,
          judgmentContext: contextId ? (props.judgmentContextsById[contextId] ?? null) : null,
          resolution,
        })
      : undefined
  }

  return (
    <Show when={hasLabel() || isOutdated()}>
      <div class="mt-1 flex flex-wrap items-center gap-1" title={title()}>
        <Show when={hasLabel()}>
          <p class="text-[11px] text-gray-500">
            <Show when={labelParts().reviewerName}>
              {(reviewerName) => {
                return reviewerName()
              }}
            </Show>
            <Show when={labelParts().isBeforeTracking}>
              {' '}
              <span class="text-gray-400">(before tracking)</span>
            </Show>
            <Show when={labelParts().reviewerName && labelParts().setAt}>{' · '}</Show>
            <Show when={labelParts().setAt}>
              {(setAt) => {
                return setAt()
              }}
            </Show>
          </p>
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
