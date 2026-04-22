import {Show} from 'solid-js'

import type {ReviewsWarningsData} from './reviewsWarningsQuery.ts'

type ReviewsIndexingProgressProps = {compact?: boolean; indexing: ReviewsWarningsData['indexing']}

const getProgressContainerClass = (compact: boolean) => {
  return compact ? 'mt-3 space-y-1 text-xs text-slate-600' : 'mt-3 space-y-1.5 text-xs text-slate-600'
}

const getSpeedLabel = (speedPerMinute: number | null) => {
  return speedPerMinute === null ? '0/min' : speedPerMinute < 1 ? '0/min' : `${Math.round(speedPerMinute)}/min`
}

const getLaneDescription = (processingCount: number, queuedCount: number, speedPerMinute: number | null) => {
  return `processing ${processingCount}, queued ${queuedCount}, ${getSpeedLabel(speedPerMinute)}`
}

const getLargeRebuildPhaseLabel = (indexing: ReviewsWarningsData['indexing']) => {
  const rebuildPhase = indexing.largeRebuild?.rebuildPhase

  return rebuildPhase === null || rebuildPhase === undefined ? null : `phase ${rebuildPhase}`
}

const getLargeRebuildCursorLabel = (indexing: ReviewsWarningsData['indexing']) => {
  const cursorArticleId = indexing.largeRebuild?.cursorArticleId

  return cursorArticleId === null || cursorArticleId === undefined ? null : `resuming from article ${cursorArticleId}`
}

const getLargeRebuildFailureLabel = (indexing: ReviewsWarningsData['indexing']) => {
  const lastError = indexing.largeRebuild?.lastError

  return lastError === null || lastError === undefined ? null : `last error: ${lastError}`
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
        <p>
          <span class="font-medium text-slate-700">Article refreshes:</span>{' '}
          {getLaneDescription(
            props.indexing.inFlightArticleRefreshCount,
            props.indexing.queuedArticleRefreshCount,
            props.indexing.articleRefreshesPerMinute,
          )}
        </p>
        <Show when={getLargeRebuildPhaseLabel(props.indexing)}>
          {(phaseLabel) => {
            return (
              <p>
                <span class="font-medium text-slate-700">Large rebuild:</span> {phaseLabel()}
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
