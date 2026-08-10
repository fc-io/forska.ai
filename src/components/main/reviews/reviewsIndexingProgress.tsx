import {Show} from 'solid-js'

import {
  getArticleRefreshLabel,
  getCleanupLabel,
  getIndexingStatusLabel,
  getProgressContainerClass,
  getProjectRefreshLabel,
  getSearchCoverageLabel,
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
          <span class="font-medium text-slate-700">Review page:</span> {getProjectRefreshLabel(props.indexing)}
        </p>
        <p>
          <span class="font-medium text-slate-700">Details:</span> {getArticleRefreshLabel(props.indexing)}
        </p>
        <p>
          <span class="font-medium text-slate-700">Search:</span> {getSearchCoverageLabel(props.indexing)}
        </p>
        <Show when={getCleanupLabel(props.indexing)}>
          {(cleanupLabel) => {
            return (
              <p>
                <span class="font-medium text-slate-700">Cleanup:</span> {cleanupLabel()}
              </p>
            )
          }}
        </Show>
      </div>
    </Show>
  )
}
