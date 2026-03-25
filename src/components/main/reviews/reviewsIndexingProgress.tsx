import {createEffect, createMemo, createSignal, onCleanup, Show} from 'solid-js'

import type {ReviewsWarningsData} from './reviewsWarningsQuery.ts'

type ReviewsIndexingSample = {
  pendingArticleRefreshCount: number
  pendingProjectRefreshCount: number
  recordedAt: number
}

type ReviewsIndexingProgressProps = {compact?: boolean; indexing: ReviewsWarningsData['indexing']}

const indexingSampleIntervalMs = 5_000
const indexingSpeedWindowMs = 15_000

const getProgressContainerClass = (compact: boolean) => {
  return compact ? 'mt-3 space-y-1 text-xs text-slate-600' : 'mt-3 space-y-1.5 text-xs text-slate-600'
}

const getCurrentSample = (
  pendingArticleRefreshCount: number,
  pendingProjectRefreshCount: number,
  recordedAt: number,
): ReviewsIndexingSample => {
  return {pendingArticleRefreshCount, pendingProjectRefreshCount, recordedAt}
}

const getRecentSamples = (history: ReviewsIndexingSample[], currentSample: ReviewsIndexingSample) => {
  return history.filter((sample) => {
    return sample.recordedAt >= currentSample.recordedAt - indexingSpeedWindowMs
  })
}

const appendHistorySample = (history: ReviewsIndexingSample[], currentSample: ReviewsIndexingSample) => {
  const recentSamples = getRecentSamples(history, currentSample)
  const previousSample = recentSamples[recentSamples.length - 1]

  return previousSample?.recordedAt === currentSample.recordedAt
    ? [...recentSamples.slice(0, -1), currentSample]
    : [...recentSamples, currentSample]
}

const getProcessedCountWithinWindow = (
  history: ReviewsIndexingSample[],
  getCount: (sample: ReviewsIndexingSample) => number,
) => {
  return history.slice(1).reduce((processedCount, currentSample, index) => {
    return processedCount + Math.max(0, getCount(history[index] ?? currentSample) - getCount(currentSample))
  }, 0)
}

const getElapsedMs = (history: ReviewsIndexingSample[]) => {
  const firstSample = history[0]
  const lastSample = history[history.length - 1]

  return !firstSample || !lastSample ? 0 : lastSample.recordedAt - firstSample.recordedAt
}

const getSpeedPerMinute = (history: ReviewsIndexingSample[], getCount: (sample: ReviewsIndexingSample) => number) => {
  const elapsedMs = getElapsedMs(history)

  return elapsedMs < indexingSampleIntervalMs
    ? null
    : (getProcessedCountWithinWindow(history, getCount) / elapsedMs) * 60_000
}

const getSpeedLabel = (speedPerMinute: number | null) => {
  return speedPerMinute === null ? 'measuring' : speedPerMinute < 1 ? '0/min' : `${Math.round(speedPerMinute)}/min`
}

const getRemainingLabel = (count: number) => {
  return count === 0 ? 'none queued' : count === 1 ? '1 left' : `${count} left`
}

const getLaneDescription = (count: number, speedLabel: string) => {
  return `${getRemainingLabel(count)}, ${speedLabel}`
}

export const ReviewsIndexingProgress = (props: ReviewsIndexingProgressProps) => {
  const [history, setHistory] = createSignal<ReviewsIndexingSample[]>([])

  createEffect(() => {
    const status = props.indexing.status
    const pendingArticleRefreshCount = props.indexing.pendingArticleRefreshCount
    const pendingProjectRefreshCount = props.indexing.pendingProjectRefreshCount

    if (status !== 'refreshing') {
      setHistory([])
      return
    }

    setHistory((currentHistory) => {
      return appendHistorySample(
        currentHistory,
        getCurrentSample(pendingArticleRefreshCount, pendingProjectRefreshCount, Date.now()),
      )
    })

    const intervalId = setInterval(() => {
      setHistory((currentHistory) => {
        return appendHistorySample(
          currentHistory,
          getCurrentSample(pendingArticleRefreshCount, pendingProjectRefreshCount, Date.now()),
        )
      })
    }, indexingSampleIntervalMs)

    onCleanup(() => {
      clearInterval(intervalId)
    })
  })

  const projectSpeedLabel = createMemo(() => {
    return getSpeedLabel(
      getSpeedPerMinute(history(), (sample) => {
        return sample.pendingProjectRefreshCount
      }),
    )
  })

  const articleSpeedLabel = createMemo(() => {
    return getSpeedLabel(
      getSpeedPerMinute(history(), (sample) => {
        return sample.pendingArticleRefreshCount
      }),
    )
  })

  return (
    <Show when={props.indexing.status === 'refreshing'}>
      <div class={getProgressContainerClass(props.compact ?? false)}>
        <p>
          <span class="font-medium text-slate-700">Project refreshes:</span>{' '}
          {getLaneDescription(props.indexing.pendingProjectRefreshCount, projectSpeedLabel())}
        </p>
        <p>
          <span class="font-medium text-slate-700">Article refreshes:</span>{' '}
          {getLaneDescription(props.indexing.pendingArticleRefreshCount, articleSpeedLabel())}
        </p>
      </div>
    </Show>
  )
}
