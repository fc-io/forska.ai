import {Show} from 'solid-js'

import {
  getArticleRefreshLabel,
  getCleanupLabel,
  getDirtyArticleAckLabel,
  getDirtyMaterializationLabel,
  getIndexingStatusLabel,
  getLargeRebuildArticleProgressLabel,
  getLargeRebuildCursorLabel,
  getLargeRebuildFailureLabel,
  getLargeRebuildPhaseLabel,
  getLargeRebuildPhaseNoteLabel,
  getProgressContainerClass,
  getProjectRefreshLabel,
  getQuarantineBarrierLabel,
  shouldShowIndexingProgress,
} from './reviewsIndexingProgress/reviewsIndexingProgressLabels.ts'
import type {ReviewsWarningsData} from './reviewsWarningsQuery.ts'

type ReviewsIndexingProgressProps = {compact?: boolean; indexing: ReviewsWarningsData['indexing']}

export const ReviewsIndexingProgress = (props: ReviewsIndexingProgressProps) => {
  return (
    <Show when={shouldShowIndexingProgress(props.indexing)}>
      <div class={getProgressContainerClass(props.compact ?? false)}>
        <p>
          <span class="font-medium text-slate-700">Status:</span> {getIndexingStatusLabel(props.indexing)}
        </p>
        <p>
          <span class="font-medium text-slate-700">Project refreshes:</span> {getProjectRefreshLabel(props.indexing)}
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
            <span class="font-medium text-slate-700">Article refreshes:</span> {getArticleRefreshLabel(props.indexing)}
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
