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

export const ReviewsIndexingProgress = (props: ReviewsIndexingProgressProps) => {
  return (
    <Show when={props.indexing.status === 'refreshing'}>
      <div class={getProgressContainerClass(props.compact ?? false)}>
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
      </div>
    </Show>
  )
}
