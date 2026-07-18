import {Show} from 'solid-js'

import type {ComparisonProjectServingProgress as ComparisonProjectServingProgressData} from '../../../../../services/comparisonProjectsService.ts'

const phaseLabels: Record<NonNullable<ComparisonProjectServingProgressData['phase']>, string> = {
  cleanup: 'cleaning up old comparison generations',
  prompt_cells: 'materializing prompt comparison cells',
  promoting: 'promoting the readable generation',
  queued: 'queued for comparison materialization',
  ready: 'materialization complete',
  rollups: 'building comparison rows and filters',
  summary_cells: 'materializing summary comparison cells',
}

const formatProgressTimestamp = (value: Date | string | null) => {
  const parsed = value ? new Date(value) : null

  return parsed === null || Number.isNaN(parsed.getTime())
    ? null
    : new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(parsed)
}

const getTimestampSuffix = (label: string, value: Date | string | null) => {
  const formatted = formatProgressTimestamp(value)

  return formatted === null ? null : `${label} ${formatted}`
}

const getCountLabel = (count: number) => {
  return count.toLocaleString()
}

const getProgressCountLabel = (count: number, total: number | null, noun: string, unknownTotalLabel: string) => {
  const countLabel = getCountLabel(count)

  return total === null
    ? `${countLabel} ${noun} (${unknownTotalLabel})`
    : `${countLabel} / ${getCountLabel(total)} ${noun}`
}

const joinLabelParts = (parts: Array<string | null>) => {
  return parts
    .filter((part): part is string => {
      return part !== null
    })
    .join(', ')
}

const getPhaseLabel = (progress: ComparisonProjectServingProgressData) => {
  return progress.phase === null ? 'waiting for materialization to start' : phaseLabels[progress.phase]
}

const getStagedRowsLabel = (progress: ComparisonProjectServingProgressData) => {
  const label = joinLabelParts([
    getProgressCountLabel(
      progress.stagedArticleCount,
      progress.totalArticleCount,
      'articles',
      'total known after rollups',
    ),
    getProgressCountLabel(
      progress.stagedCellCount,
      progress.totalCellCount,
      'cells',
      'total known after cell materialization',
    ),
    progress.stagedFilterMemberCount > 0
      ? `${getCountLabel(progress.stagedFilterMemberCount)} filter memberships`
      : null,
    progress.stagedFilterStatsCount > 0 ? `${getCountLabel(progress.stagedFilterStatsCount)} filter totals` : null,
  ])

  return label
}

const getTimingLabel = (progress: ComparisonProjectServingProgressData) => {
  const startedAt = getTimestampSuffix('started', progress.startedAt)
  const phaseStartedAt = getTimestampSuffix('phase started', progress.phaseStartedAt)
  const lastProgressedAt = getTimestampSuffix('last progress', progress.lastProgressedAt)

  return joinLabelParts([startedAt, phaseStartedAt, lastProgressedAt])
}

const shouldShowProgress = (progress: ComparisonProjectServingProgressData, showWaiting: boolean) => {
  return (
    showWaiting
    || progress.phase !== null
    || progress.startedAt !== null
    || progress.lastProgressedAt !== null
    || progress.lastError !== null
    || progress.stagedArticleCount > 0
    || progress.stagedCellCount > 0
  )
}

export const ComparisonProjectServingProgress = (props: {
  progress: ComparisonProjectServingProgressData
  showWaiting?: boolean
}) => {
  return (
    <Show when={shouldShowProgress(props.progress, props.showWaiting ?? false)}>
      <div class="mt-3 space-y-1.5 text-xs text-slate-600">
        <p>
          Staged rows belong to the new, inactive generation. Cells are built first, then article rows and filters; the
          existing generation stays readable until promotion. The exact cell total appears after cell materialization
          because empty or missing answers do not create cells.
        </p>
        <p>
          <span class="font-medium text-slate-700">Materialization:</span> {getPhaseLabel(props.progress)}
        </p>
        <p>
          <span class="font-medium text-slate-700">Staged rows:</span> {getStagedRowsLabel(props.progress)}
        </p>
        <Show when={getTimingLabel(props.progress)}>
          {(timingLabel) => {
            return (
              <p>
                <span class="font-medium text-slate-700">Timing:</span> {timingLabel()}
              </p>
            )
          }}
        </Show>
        <Show when={props.progress.lastError}>
          {(lastError) => {
            return (
              <p>
                <span class="font-medium text-slate-700">Last error:</span> {lastError()}
              </p>
            )
          }}
        </Show>
      </div>
    </Show>
  )
}
