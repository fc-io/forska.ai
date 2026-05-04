import {Show} from 'solid-js'

import type {ReviewsWarningsData} from './reviewsWarningsQuery.ts'

type ReviewsIndexingProgressProps = {compact?: boolean; indexing: ReviewsWarningsData['indexing']}

const largeRebuildPhaseOrder = [
  'project_scope_article',
  'judgment_fact',
  'prompt_answer_fact',
  'review_answer_dictionary',
  'review_article_filter_member',
  'review_article_rollup',
  'review_article_serving',
] as const

const getProgressContainerClass = (compact: boolean) => {
  return compact ? 'mt-3 space-y-1 text-xs text-slate-600' : 'mt-3 space-y-1.5 text-xs text-slate-600'
}

const getSpeedLabel = (speedPerMinute: number | null) => {
  return speedPerMinute === null ? '0/min' : speedPerMinute < 1 ? '0/min' : `${Math.round(speedPerMinute)}/min`
}

const getLargeRebuildSpeedLabel = (speedPerMinute: number | null) => {
  return speedPerMinute === null ? 'measuring throughput' : getSpeedLabel(speedPerMinute)
}

const getCountLabel = (count: number) => {
  return count.toLocaleString()
}

const getLaneDescription = (processingCount: number, queuedCount: number, speedPerMinute: number | null) => {
  return `processing ${processingCount}, queued ${queuedCount}, ${getSpeedLabel(speedPerMinute)}`
}

const getLargeRebuildArticleProgressLabel = (indexing: ReviewsWarningsData['indexing']) => {
  const progress = indexing.largeRebuild?.progress

  return progress === null || progress === undefined || progress.remainingCurrentPhaseArticleCount === null
    ? null
    : `remaining ${getCountLabel(progress.remainingCurrentPhaseArticleCount)} of ${getCountLabel(progress.scopeArticleCount)} in this phase, ${getLargeRebuildSpeedLabel(progress.rowsPerMinute)}`
}

const getDirtyArticleAckLabel = (indexing: ReviewsWarningsData['indexing']) => {
  return indexing.largeRebuild === null || indexing.pendingArticleRefreshCount === 0
    ? null
    : `${getCountLabel(indexing.pendingArticleRefreshCount)} waiting until the staged rebuild finalizes`
}

const getLargeRebuildPhaseLabel = (indexing: ReviewsWarningsData['indexing']) => {
  const rebuildPhase = indexing.largeRebuild?.rebuildPhase
  const phaseIndex = largeRebuildPhaseOrder.indexOf(rebuildPhase as (typeof largeRebuildPhaseOrder)[number])

  return rebuildPhase === null || rebuildPhase === undefined
    ? null
    : phaseIndex === -1
      ? `current phase ${rebuildPhase}`
      : `current phase ${phaseIndex + 1} of ${largeRebuildPhaseOrder.length} (${rebuildPhase})`
}

const getLargeRebuildPhaseNoteLabel = (indexing: ReviewsWarningsData['indexing']) => {
  return indexing.largeRebuild === null
    ? null
    : 'Article counts are per phase and reset when the rebuild advances; this is not a full restart.'
}

const getLargeRebuildCursorLabel = (indexing: ReviewsWarningsData['indexing']) => {
  const cursorArticleId = indexing.largeRebuild?.cursorArticleId

  return cursorArticleId === null || cursorArticleId === undefined ? null : `resuming from article ${cursorArticleId}`
}

const getLargeRebuildFailureLabel = (indexing: ReviewsWarningsData['indexing']) => {
  const lastError = indexing.largeRebuild?.lastError

  return lastError === null || lastError === undefined ? null : `last error: ${lastError}`
}

const getDirtyMaterializationLabel = (indexing: ReviewsWarningsData['indexing']) => {
  const materialization = indexing.dirtyMaterialization

  return materialization === undefined || materialization.incompleteCount === 0
    ? null
    : `${getCountLabel(materialization.incompleteCount)} project-wide dirty ${materialization.incompleteCount === 1 ? 'snapshot' : 'snapshots'} pending`
}

const getQuarantineBarrierLabel = (indexing: ReviewsWarningsData['indexing']) => {
  return (indexing.freshness?.unresolvedQuarantineBarrierCount ?? 0) === 0
    ? null
    : `${getCountLabel(indexing.freshness?.unresolvedQuarantineBarrierCount ?? 0)} quarantined article ${indexing.freshness?.unresolvedQuarantineBarrierCount === 1 ? 'barrier' : 'barriers'} blocking freshness`
}

const getCleanupLabel = (indexing: ReviewsWarningsData['indexing']) => {
  const cleanupCount = indexing.cleanup?.inFlightGenerationCleanupCount ?? 0

  return cleanupCount === 0
    ? null
    : `${getCountLabel(cleanupCount)} old-generation cleanup ${cleanupCount === 1 ? 'job' : 'jobs'} running`
}

const getIndexingStatusLabel = (indexing: ReviewsWarningsData['indexing']) => {
  return indexing.progressState === 'processing'
    ? `${indexing.activeWorkCount} ${indexing.activeWorkCount === 1 ? 'refresh job' : 'refresh jobs'} actively processing`
    : indexing.progressState === 'queued'
      ? 'queued for the maintenance worker'
      : indexing.progressState === 'blocked' && indexing.blockedReason === 'paused_by_policy'
        ? 'cooling down after memory pressure'
        : indexing.progressState === 'blocked'
          ? 'waiting for maintenance worker'
          : indexing.progressState === 'stalled'
            ? 'stalled with no active processing'
            : indexing.progressState === 'failed'
              ? 'failed'
              : 'completed'
}

const shouldShowIndexingProgress = (indexing: ReviewsWarningsData['indexing']) => {
  return (
    indexing.status === 'refreshing'
    || indexing.status === 'blocked'
    || (indexing.status === 'failed' && getLargeRebuildFailureLabel(indexing) !== null)
  )
}

export const ReviewsIndexingProgress = (props: ReviewsIndexingProgressProps) => {
  return (
    <Show when={shouldShowIndexingProgress(props.indexing)}>
      <div class={getProgressContainerClass(props.compact ?? false)}>
        <p>
          <span class="font-medium text-slate-700">Status:</span> {getIndexingStatusLabel(props.indexing)}
        </p>
        <p>
          <span class="font-medium text-slate-700">Project refreshes:</span>{' '}
          {getLaneDescription(
            props.indexing.inFlightProjectRefreshCount,
            props.indexing.queuedProjectRefreshCount,
            props.indexing.projectRefreshesPerMinute,
          )}
        </p>
        <Show
          when={props.indexing.largeRebuild === null}
          fallback={
            <>
              <Show when={getLargeRebuildArticleProgressLabel(props.indexing)}>
                {(progressLabel) => {
                  return (
                    <p>
                      <span class="font-medium text-slate-700">Current phase articles:</span> {progressLabel()}
                    </p>
                  )
                }}
              </Show>
              <Show when={getDirtyArticleAckLabel(props.indexing)}>
                {(ackLabel) => {
                  return (
                    <p>
                      <span class="font-medium text-slate-700">Dirty article ACKs:</span> {ackLabel()}
                    </p>
                  )
                }}
              </Show>
            </>
          }
        >
          <p>
            <span class="font-medium text-slate-700">Article refreshes:</span>{' '}
            {getLaneDescription(
              props.indexing.inFlightArticleRefreshCount,
              props.indexing.queuedArticleRefreshCount,
              props.indexing.articleRefreshesPerMinute,
            )}
          </p>
        </Show>
        <Show when={getLargeRebuildPhaseLabel(props.indexing)}>
          {(phaseLabel) => {
            return (
              <p>
                <span class="font-medium text-slate-700">Large rebuild:</span> {phaseLabel()}
              </p>
            )
          }}
        </Show>
        <Show when={getDirtyMaterializationLabel(props.indexing)}>
          {(materializationLabel) => {
            return (
              <p>
                <span class="font-medium text-slate-700">Dirty materialization:</span> {materializationLabel()}
              </p>
            )
          }}
        </Show>
        <Show when={getQuarantineBarrierLabel(props.indexing)}>
          {(quarantineLabel) => {
            return (
              <p>
                <span class="font-medium text-slate-700">Quarantine:</span> {quarantineLabel()}
              </p>
            )
          }}
        </Show>
        <Show when={getCleanupLabel(props.indexing)}>
          {(cleanupLabel) => {
            return (
              <p>
                <span class="font-medium text-slate-700">Cleanup:</span> {cleanupLabel()}
              </p>
            )
          }}
        </Show>
        <Show when={getLargeRebuildPhaseNoteLabel(props.indexing)}>
          {(phaseNoteLabel) => {
            return (
              <p>
                <span class="font-medium text-slate-700">Phase note:</span> {phaseNoteLabel()}
              </p>
            )
          }}
        </Show>
        <Show when={getLargeRebuildCursorLabel(props.indexing)}>
          {(cursorLabel) => {
            return (
              <p>
                <span class="font-medium text-slate-700">Cursor:</span> {cursorLabel()}
              </p>
            )
          }}
        </Show>
        <Show when={props.indexing.status === 'failed' ? getLargeRebuildFailureLabel(props.indexing) : null}>
          {(failureLabel) => {
            return (
              <p>
                <span class="font-medium text-slate-700">Large rebuild failure:</span> {failureLabel()}
              </p>
            )
          }}
        </Show>
      </div>
    </Show>
  )
}
