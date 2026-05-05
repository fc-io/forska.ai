import {type DateValue, fromDate} from '@internationalized/date'
import {useQuery} from '@tanstack/solid-query'
import {format} from 'date-fns'
import {type Accessor, createEffect, createMemo, createSignal, For, onCleanup, Show} from 'solid-js'

import {apiClient} from '../services/apiClient.ts'
import {TokenUsageTimelineDatePicker} from './TokenUsageTimeline/TokenUsageTimelineDatePicker.tsx'
import {
  getTokenUsageTimelineEndOfDay,
  getTokenUsageTimelinePickerValues,
  type TokenUsageTimelineDateRange,
} from './TokenUsageTimeline/TokenUsageTimelineDateRange.ts'

export type TimeInterval = '1min' | '5min' | '15min' | '1h' | '24h' | '1w' | '1m'

export type TokenTimelineData = {
  timestamp: string
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  totalRequests: number
  totalSuccessPromptTokens?: number
  totalSuccessCompletionTokens?: number
  totalSuccessTokens?: number
  totalFailedTokens?: number
  count: number
}

type UsageStat = {timestamp: string; totalTokens: number}

type TokenUsageTimelineProps = {projectId?: string; allJobs?: boolean}

type TokenTimelineBucket = {
  completionTokens: number
  failedTokens: number
  label: string
  promptTokens: number
  timestamp: string
  totalRequests: number
  totalTokens: number
}

type TokenTimelineTooltip = {bucket: TokenTimelineBucket; title: string; x: number; y: number}

const timelineChartDimensions = {bottom: 34, height: 256, left: 78, right: 16, top: 24, width: 1000} as const

const tokenAxisFormatter = new Intl.NumberFormat('en-US', {maximumFractionDigits: 1, notation: 'compact'})
const niceTokenCeilingMultipliers = [1, 1.25, 1.5, 2, 2.5, 5, 10] as const

const timelinePlotWidth = timelineChartDimensions.width - timelineChartDimensions.left - timelineChartDimensions.right
const timelinePlotHeight = timelineChartDimensions.height - timelineChartDimensions.top - timelineChartDimensions.bottom
const timelineChartBottom = timelineChartDimensions.height - timelineChartDimensions.bottom

const getAlignedSvgStrokePosition = (value: number) => {
  return Math.round(value) + 0.5
}

const getAlignedSvgBarPosition = (value: number) => {
  return Math.round(value)
}

const getAlignedSvgBarSize = (value: number) => {
  return value > 0 ? Math.max(1, Math.round(value)) : 0
}

const getTimelineBucketTokenSplit = (bucket: TokenTimelineData) => {
  const successPrompt = bucket.totalSuccessPromptTokens ?? 0
  const successCompletion = bucket.totalSuccessCompletionTokens ?? 0
  const failedTokens = bucket.totalFailedTokens ?? 0
  const hasNewSplits = successPrompt + successCompletion + failedTokens > 0

  return hasNewSplits
    ? {completionTokens: successCompletion, failedTokens, promptTokens: successPrompt}
    : {
        completionTokens: bucket.totalCompletionTokens ?? 0,
        failedTokens: 0,
        promptTokens: bucket.totalPromptTokens ?? 0,
      }
}

const getTimelineBucketLabel = (params: {interval: TimeInterval; timestamp: string}) => {
  const date = new Date(params.timestamp)
  return params.interval === '1min' || params.interval === '5min' || params.interval === '15min'
    ? format(date, 'HH:mm')
    : params.interval === '1h'
      ? format(date, 'MMM d HH:mm')
      : params.interval === '1m'
        ? format(new Date(date.getFullYear(), date.getMonth(), 1), 'MMM yyyy')
        : format(date, 'MMM d')
}

const getTimelineBuckets = (params: {data: TokenTimelineData[]; interval: TimeInterval}) => {
  return params.data.map((bucket) => {
    const split = getTimelineBucketTokenSplit(bucket)

    return {
      ...split,
      label: getTimelineBucketLabel({interval: params.interval, timestamp: bucket.timestamp}),
      timestamp: bucket.timestamp,
      totalRequests: bucket.totalRequests ?? 0,
      totalTokens: bucket.totalTokens ?? split.promptTokens + split.completionTokens + split.failedTokens,
    }
  })
}

const getNiceTokenCeiling = (value: number) => {
  if (value <= 0) {
    return 1
  }

  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalizedValue = value / magnitude
  const multiplier = niceTokenCeilingMultipliers.find((candidate) => {
    return normalizedValue <= candidate
  })

  return (multiplier ?? 10) * magnitude
}

const getTimelineY = (value: number, maxValue: number) => {
  return timelineChartBottom - (value / maxValue) * timelinePlotHeight
}

const getTimelineRenderBuckets = (params: {buckets: TokenTimelineBucket[]; maxValue: number}) => {
  const slotWidth = params.buckets.length > 0 ? timelinePlotWidth / params.buckets.length : timelinePlotWidth
  const barWidth = getAlignedSvgBarSize(Math.max(3, Math.min(34, slotWidth * 0.58)))

  return params.buckets.map((bucket, index) => {
    const promptHeight = getAlignedSvgBarSize((bucket.promptTokens / params.maxValue) * timelinePlotHeight)
    const completionHeight = getAlignedSvgBarSize((bucket.completionTokens / params.maxValue) * timelinePlotHeight)
    const failedHeight = getAlignedSvgBarSize((bucket.failedTokens / params.maxValue) * timelinePlotHeight)
    const promptY = timelineChartBottom - promptHeight
    const completionY = promptY - completionHeight
    const failedY = completionY - failedHeight
    const x = getAlignedSvgBarPosition(timelineChartDimensions.left + index * slotWidth + (slotWidth - barWidth) / 2)

    return {...bucket, barWidth, completionHeight, completionY, failedHeight, failedY, promptHeight, promptY, x}
  })
}

const getTimelineYTicks = (maxValue: number) => {
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = maxValue * ratio
    return {
      label: tokenAxisFormatter.format(value),
      value,
      y: getAlignedSvgStrokePosition(getTimelineY(value, maxValue)),
    }
  })
}

const shouldShowTimelineXLabel = (params: {index: number; total: number}) => {
  const step = Math.max(1, Math.ceil(params.total / 8))
  return params.index === 0 || params.index === params.total - 1 || params.index % step === 0
}

const getMinuteBucketStart = (date: Date) => {
  const bucketStart = new Date(date)
  bucketStart.setSeconds(0, 0)
  return bucketStart
}

export const getTokenTimelineDisplayData = ({
  data,
  interval,
  now = new Date(),
}: {
  data: TokenTimelineData[]
  interval: TimeInterval
  now?: Date
}) => {
  const trailingBucket = data.at(-1)
  const currentMinuteStart = getMinuteBucketStart(now).getTime()
  const trailingBucketTime = trailingBucket ? new Date(trailingBucket.timestamp).getTime() : null
  const shouldDropTrailingBucket =
    interval === '1min' && trailingBucket
      ? trailingBucketTime !== null && trailingBucketTime >= currentMinuteStart
      : false

  return shouldDropTrailingBucket ? data.slice(0, -1) : data
}

type TokenUsageTimelineStatsProps = {
  allJobs: boolean
  intervalBucketLabel: Accessor<string>
  intervalHistoryLabel: Accessor<string>
  interval: Accessor<TimeInterval>
  projectId: string | undefined
}

const TokenUsageTimelineStats = (props: TokenUsageTimelineStatsProps) => {
  const tokenStats = useQuery(() => {
    return {
      queryKey: ['token-timeline-stats', props.allJobs ? 'all-jobs' : props.projectId, props.interval()],
      enabled: Boolean(props.allJobs || props.projectId),
      queryFn: async () => {
        const response = props.allJobs
          ? await apiClient.api.tokens.timelineAllJobsStats.post({interval: props.interval()})
          : await apiClient.api.tokens.timelineStats.post({
              projectId: props.projectId as string,
              interval: props.interval(),
            })

        if (!response.data || !response.data.success) {
          throw new Error('Failed to fetch token timeline stats')
        }

        return response.data
      },
      refetchInterval: false,
      staleTime: 5 * 60 * 1000,
      placeholderData: (prev) => {
        return prev
      },
      suspense: false,
    }
  })

  const highestUsageStat = createMemo(() => {
    return (tokenStats.data?.highestUsage ?? null) as UsageStat | null
  })

  const p90UsageStat = createMemo(() => {
    return (tokenStats.data?.p90Usage ?? null) as UsageStat | null
  })

  return (
    <>
      <Show when={tokenStats.isLoading}>
        <div class="text-sm text-gray-400 mt-1">Loading usage stats...</div>
      </Show>
      <Show when={tokenStats.isError}>
        <div class="text-sm text-red-600 mt-1">Failed to load usage stats</div>
      </Show>
      <Show when={highestUsageStat()}>
        <div class="text-sm text-gray-600 mt-1">
          <span class="font-medium">Highest per {props.intervalBucketLabel()}: </span>
          <span>{highestUsageStat()?.totalTokens.toLocaleString()} tokens</span>
          <span class="text-gray-400 ml-1">({props.intervalHistoryLabel()})</span>
        </div>
      </Show>
      <Show when={p90UsageStat()}>
        <div class="text-sm text-gray-600 mt-1">
          <span class="font-medium">90th percentile per {props.intervalBucketLabel()}: </span>
          <span>{p90UsageStat()?.totalTokens.toLocaleString()} tokens</span>
          <span class="text-gray-400 ml-1">({props.intervalHistoryLabel()})</span>
        </div>
      </Show>
    </>
  )
}

export const TokenUsageTimeline = (props: TokenUsageTimelineProps) => {
  const [selectedInterval, setSelectedInterval] = createSignal<TimeInterval>('1min')
  const [customRange, setCustomRange] = createSignal<TokenUsageTimelineDateRange | null>(null)
  const [pendingPickerValues, setPendingPickerValues] = createSignal<DateValue[] | undefined>(undefined)
  const [tooltip, setTooltip] = createSignal<TokenTimelineTooltip | null>(null)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  let timelineChartContainer: HTMLDivElement | undefined
  const hasCustomRange = createMemo(() => {
    return customRange() !== null
  })
  const maxSelectableDate = fromDate(getTokenUsageTimelineEndOfDay(new Date()), timeZone)
  const timelineTitle = createMemo(() => {
    return props.allJobs ? 'Token Usage Timeline' : 'Project Token Usage Timeline'
  })

  const lowerIntervalMap: Record<Exclude<TimeInterval, '1min'>, TimeInterval> = {
    '5min': '1min',
    '15min': '5min',
    '1h': '15min',
    '24h': '1h',
    '1w': '24h',
    '1m': '1w',
  }

  const intervalDurations: Record<Exclude<TimeInterval, '1m'>, number> = {
    '1min': 60 * 1000,
    '5min': 5 * 60 * 1000,
    '15min': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '1w': 7 * 24 * 60 * 60 * 1000,
  }

  const clearCustomRange = (params: {
    setCustomRange: (range: TokenUsageTimelineDateRange | null) => void
    setPendingPickerValues: (values: DateValue[] | undefined) => void
  }) => {
    params.setCustomRange(null)
    params.setPendingPickerValues(undefined)
  }

  const getDateRangeForInterval = (interval: TimeInterval) => {
    const now = new Date()

    // Helper to get local start-of-day for N days ago
    const startOfNDaysAgo = (daysAgo: number) => {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - daysAgo)
      return d
    }

    // Helper to align time to nearest interval boundary
    const alignToInterval = (date: Date, minutes: number) => {
      const aligned = new Date(date)
      const currentMinutes = aligned.getMinutes()
      const alignedMinutes = Math.floor(currentMinutes / minutes) * minutes
      aligned.setMinutes(alignedMinutes, 0, 0)
      return aligned
    }

    const alignToHour = (date: Date) => {
      const d = new Date(date)
      d.setMinutes(0, 0, 0)
      return d
    }

    const startOfWeekMonday = (date: Date) => {
      const d = new Date(date)
      d.setHours(0, 0, 0, 0)
      // getDay: 0=Sun,1=Mon,...
      const day = d.getDay()
      const diffToMonday = (day + 6) % 7 // 0 if Monday
      d.setDate(d.getDate() - diffToMonday)
      return d
    }

    const startOfMonth = (date: Date) => {
      const d = new Date(date)
      d.setDate(1)
      d.setHours(0, 0, 0, 0)
      return d
    }

    switch (interval) {
      case '1min': {
        // Last 20 minutes (20 buckets), include current minute so far
        const currentBucketStart = alignToInterval(now, 1)
        return {start: new Date(currentBucketStart.getTime() - 19 * 60 * 1000), end: now}
      }
      case '5min': {
        // Last 2 hours (24 buckets of 5 minutes), include current 5-min bucket so far
        const currentBucketStart = alignToInterval(now, 5)
        return {start: new Date(currentBucketStart.getTime() - 23 * 5 * 60 * 1000), end: now}
      }
      case '15min': {
        // Last 16 hours (64 buckets of 15 minutes), include current 15-min bucket so far
        const currentBucketStart = alignToInterval(now, 15)
        return {start: new Date(currentBucketStart.getTime() - 63 * 15 * 60 * 1000), end: now}
      }
      case '1h': {
        // Last 24 hours (24 buckets of 1 hour), include current hour so far
        const currentBucketStart = alignToHour(now)
        return {start: new Date(currentBucketStart.getTime() - 23 * 60 * 60 * 1000), end: now}
      }
      case '24h': {
        // Last 30 days (30 buckets), include today so far
        return {start: startOfNDaysAgo(29), end: now}
      }
      case '1w': {
        // Last 30 weeks (30 buckets), include current week so far (Monday-aligned)
        const startOfThisWeek = startOfWeekMonday(now)
        return {start: new Date(startOfThisWeek.getTime() - 29 * 7 * 24 * 60 * 60 * 1000), end: now}
      }
      case '1m': {
        // Last 24 months (24 buckets), include current month so far
        const start = startOfMonth(now)
        start.setMonth(start.getMonth() - 23)
        return {start, end: now}
      }
      default: {
        return {start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now}
      }
    }
  }

  // Compute date range at fetch time to avoid stale windows

  const tokenData = useQuery(() => {
    const range = customRange()
    return {
      // Keep key stable for a given project + interval; time window advances via refetch
      queryKey: [
        'token-timeline',
        props.allJobs ? 'all-jobs' : props.projectId,
        selectedInterval(),
        range ? range.start.toISOString() : null,
        range ? range.end.toISOString() : null,
      ],
      queryFn: async () => {
        const activeRange = range ?? getDateRangeForInterval(selectedInterval())
        const response = props.allJobs
          ? await apiClient.api.tokens.timelineAllJobs.post({
              interval: selectedInterval(),
              startDate: activeRange.start.toISOString(),
              endDate: activeRange.end.toISOString(),
            })
          : await apiClient.api.tokens.timeline.post({
              projectId: props.projectId as string,
              interval: selectedInterval(),
              startDate: activeRange.start.toISOString(),
              endDate: activeRange.end.toISOString(),
            })

        if (!response.data || !response.data.success) {
          throw new Error('Failed to fetch token timeline')
        }

        return response.data
      },
      // Disable built-in polling; we schedule boundary-aligned refetches below
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
      // TanStack Query v5 replacement for keepPreviousData
      placeholderData: (prev) => {
        return prev
      },
      suspense: false,
    }
  })

  const intervalBucketLabel = createMemo(() => {
    const interval = selectedInterval()
    return interval === '1m' ? 'month' : interval === '1w' ? 'week' : interval
  })

  const intervalHistoryLabel = createMemo(() => {
    const interval = selectedInterval()
    return interval === '1w' ? 'last 30 weeks' : interval === '1m' ? 'last 24 months' : 'last 30 days'
  })

  const activeRange = createMemo(() => {
    const range = customRange()
    if (range) {
      return {start: new Date(range.start), end: new Date(range.end)}
    }
    const interval = selectedInterval()
    return getDateRangeForInterval(interval)
  })

  const datePickerRange = createMemo(() => {
    return getTokenUsageTimelinePickerValues({range: activeRange(), timeZone})
  })

  const pickerValue = createMemo(() => {
    const pending = pendingPickerValues()
    if (pending && pending.length > 0) {
      return pending
    }
    if (hasCustomRange()) {
      return datePickerRange()
    }
    return undefined
  })

  const formattedActiveRange = createMemo(() => {
    const range = activeRange()
    if (!range) {
      return ''
    }
    const start = format(range.start, 'MMM d, yyyy HH:mm')
    const end = format(range.end, 'MMM d, yyyy HH:mm')
    return `${start} – ${end}`
  })

  // Boundary-aligned refetching to sync with system clock
  let boundaryTimer: ReturnType<typeof setTimeout> | undefined

  const clearBoundaryTimer = () => {
    if (boundaryTimer) {
      clearTimeout(boundaryTimer)
      boundaryTimer = undefined
    }
  }

  const scheduleBoundaryRefetch = () => {
    clearBoundaryTimer()
    const now = new Date()

    // Always align to the next minute boundary for fetching
    const alignedToMinute = new Date(now)
    alignedToMinute.setSeconds(0, 0)

    // Calculate the next minute boundary
    const nextMinuteBoundary = new Date(alignedToMinute)
    nextMinuteBoundary.setMinutes(nextMinuteBoundary.getMinutes() + 1)

    // Calculate delay until next minute with slight buffer
    const delay = Math.max(0, nextMinuteBoundary.getTime() - now.getTime() + 10)

    boundaryTimer = setTimeout(() => {
      void tokenData.refetch()
      // Schedule the next boundary after this one
      scheduleBoundaryRefetch()
    }, delay)
  }

  createEffect(() => {
    const range = customRange()
    const pending = pendingPickerValues()
    if (range && pending && pending.length === 2) {
      setPendingPickerValues(undefined)
    }
  })

  createEffect(() => {
    const range = customRange()
    selectedInterval()
    clearBoundaryTimer()
    if (!range) {
      scheduleBoundaryRefetch()
    }
  })

  onCleanup(() => {
    clearBoundaryTimer()
  })

  const filteredTimelineData = createMemo(() => {
    const responseData = tokenData.data
    const data = responseData?.data as TokenTimelineData[] | undefined
    if (!data || data.length === 0) {
      return []
    }
    return getTokenTimelineDisplayData({data, interval: selectedInterval()})
  })

  const computeBucketRange = (params: {interval: TimeInterval; timestamp: string; index: number; total: number}) => {
    const now = new Date()
    if (params.interval === '1m') {
      const bucketTs = new Date(params.timestamp)
      const monthStart = new Date(bucketTs.getFullYear(), bucketTs.getMonth(), 1, 0, 0, 0, 0)
      const nextMonthStart = new Date(bucketTs.getFullYear(), bucketTs.getMonth() + 1, 1, 0, 0, 0, 0)
      const monthEnd = nextMonthStart > now ? now : nextMonthStart
      return {start: monthStart, end: monthEnd}
    }
    const bucketStart = new Date(params.timestamp)
    const duration = intervalDurations[params.interval]
    const nominalEnd = new Date(bucketStart.getTime() + duration)
    const isLastBucket = params.index === params.total - 1
    const bucketEnd = isLastBucket && nominalEnd > now ? now : nominalEnd
    return {start: bucketStart, end: bucketEnd}
  }

  const timelineBuckets = createMemo(() => {
    return getTimelineBuckets({data: filteredTimelineData(), interval: selectedInterval()})
  })

  const timelineMaxValue = createMemo(() => {
    const maxBucketValue = timelineBuckets().reduce((maxValue, bucket) => {
      return Math.max(maxValue, bucket.promptTokens + bucket.completionTokens + bucket.failedTokens)
    }, 0)

    return getNiceTokenCeiling(maxBucketValue)
  })

  const timelineRenderBuckets = createMemo(() => {
    return getTimelineRenderBuckets({buckets: timelineBuckets(), maxValue: timelineMaxValue()})
  })

  const timelineYTicks = createMemo(() => {
    return getTimelineYTicks(timelineMaxValue())
  })

  const hasTimelineData = createMemo(() => {
    return timelineBuckets().length > 0
  })

  const hasFailedTokens = createMemo(() => {
    return timelineBuckets().some((bucket) => {
      return bucket.failedTokens > 0
    })
  })

  const handleBucketClick = (bucket: TokenTimelineBucket, index: number) => {
    const currentInterval = selectedInterval()

    if (currentInterval === '1min') {
      return
    }

    const drillDownInterval = lowerIntervalMap[currentInterval]

    const range = computeBucketRange({
      index,
      interval: currentInterval,
      timestamp: bucket.timestamp,
      total: timelineBuckets().length,
    })
    setCustomRange({start: new Date(range.start), end: new Date(range.end)})
    setSelectedInterval(drillDownInterval)
  }

  const getBucketTooltipTitle = (bucket: TokenTimelineBucket, index: number) => {
    const interval = selectedInterval()
    const range = computeBucketRange({interval, timestamp: bucket.timestamp, index, total: timelineBuckets().length})
    if (interval === '1m') {
      const startStr = format(range.start, 'MMM d')
      const endStr = format(range.end, 'MMM d HH:mm')
      return `${startStr} – ${endStr}`
    }
    const startStr = format(range.start, 'MMM d HH:mm')
    const endStr = format(range.end, 'MMM d HH:mm')
    return `${startStr} – ${endStr}`
  }

  const getTooltipPosition = (event: PointerEvent) => {
    const containerRect = timelineChartContainer?.getBoundingClientRect()
    if (!containerRect) {
      return null
    }

    const x = Math.min(Math.max(event.clientX - containerRect.left, 128), containerRect.width - 128)
    const y = Math.max(event.clientY - containerRect.top, 24)

    return {x, y}
  }

  const showBucketTooltip = (bucket: TokenTimelineBucket, index: number, event: PointerEvent) => {
    const position = getTooltipPosition(event)
    if (!position) {
      return
    }

    setTooltip({bucket, title: getBucketTooltipTitle(bucket, index), x: position.x, y: position.y})
  }

  return (
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div class="mb-6">
        <div class="flex justify-between items-center mb-4">
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-lg font-semibold text-gray-900">{timelineTitle()}</h2>
            </div>
            <div>
              <TokenUsageTimelineStats
                allJobs={Boolean(props.allJobs)}
                interval={selectedInterval}
                intervalBucketLabel={intervalBucketLabel}
                intervalHistoryLabel={intervalHistoryLabel}
                projectId={props.projectId}
              />
            </div>
          </div>
        </div>

        <div class="flex flex-col items-end gap-2">
          <Show when={formattedActiveRange()}>
            <p class="text-xs text-gray-500">{formattedActiveRange()}</p>
          </Show>
          <div class="flex items-center gap-2">
            <TokenUsageTimelineDatePicker
              hasCustomRange={hasCustomRange}
              maxSelectableDate={maxSelectableDate}
              onPendingChange={setPendingPickerValues}
              onRangeCommit={setCustomRange}
              onReset={() => {
                clearCustomRange({setCustomRange, setPendingPickerValues})
              }}
              pickerValue={pickerValue}
              timeZone={timeZone}
            />
            <select
              value={selectedInterval()}
              onChange={(e) => {
                const newInterval = e.target.value as TimeInterval
                setCustomRange(null)
                setPendingPickerValues(undefined)
                return setSelectedInterval(newInterval)
              }}
              class="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="1min">1 minute</option>
              <option value="5min">5 minutes</option>
              <option value="15min">15 minutes</option>
              <option value="1h">1 hour</option>
              <option value="24h">24 hours</option>
              <option value="1w">1 week</option>
              <option value="1m">1 month</option>
            </select>
          </div>
        </div>
      </div>

      <div
        ref={(element) => {
          timelineChartContainer = element
        }}
        class="relative h-64"
      >
        <Show when={hasTimelineData() && !tokenData.isError}>
          <>
            <div class="absolute right-3 top-0 z-10 flex items-center gap-3 text-xs text-gray-600">
              <span class="inline-flex items-center gap-1">
                <span class="h-2.5 w-2.5 rounded-sm bg-blue-500" /> Prompt Tokens
              </span>
              <span class="inline-flex items-center gap-1">
                <span class="h-2.5 w-2.5 rounded-sm bg-blue-300" /> Completion Tokens
              </span>
              <Show when={hasFailedTokens()}>
                <span class="inline-flex items-center gap-1">
                  <span class="h-2.5 w-2.5 rounded-sm bg-red-500" /> Failed Tokens
                </span>
              </Show>
            </div>
            <svg
              aria-label="Token usage timeline"
              class="h-full w-full"
              onPointerLeave={() => {
                setTooltip(null)
              }}
              role="img"
              viewBox={`0 0 ${timelineChartDimensions.width} ${timelineChartDimensions.height}`}
            >
              <For each={timelineYTicks()}>
                {(tick) => {
                  return (
                    <g>
                      <line
                        shape-rendering="crispEdges"
                        stroke="rgba(0, 0, 0, 0.06)"
                        vector-effect="non-scaling-stroke"
                        x1={timelineChartDimensions.left}
                        x2={timelineChartDimensions.width - timelineChartDimensions.right}
                        y1={tick.y}
                        y2={tick.y}
                      />
                      <text
                        class="fill-gray-500 text-[11px]"
                        dominant-baseline="middle"
                        text-anchor="end"
                        x={timelineChartDimensions.left - 10}
                        y={tick.y}
                      >
                        {tick.label}
                      </text>
                    </g>
                  )
                }}
              </For>
              <line
                shape-rendering="crispEdges"
                stroke="rgba(0, 0, 0, 0.14)"
                vector-effect="non-scaling-stroke"
                x1={timelineChartDimensions.left}
                x2={timelineChartDimensions.width - timelineChartDimensions.right}
                y1={getAlignedSvgStrokePosition(timelineChartBottom)}
                y2={getAlignedSvgStrokePosition(timelineChartBottom)}
              />
              <For each={timelineRenderBuckets()}>
                {(bucket, index) => {
                  return (
                    <g
                      class={selectedInterval() === '1min' ? 'cursor-default' : 'cursor-pointer'}
                      onClick={() => {
                        return handleBucketClick(bucket, index())
                      }}
                      onPointerMove={(event) => {
                        return showBucketTooltip(bucket, index(), event)
                      }}
                    >
                      <rect
                        fill="rgb(59, 130, 246)"
                        height={bucket.promptHeight}
                        shape-rendering="crispEdges"
                        width={bucket.barWidth}
                        x={bucket.x}
                        y={bucket.promptY}
                      />
                      <rect
                        fill="rgb(147, 197, 253)"
                        height={bucket.completionHeight}
                        shape-rendering="crispEdges"
                        width={bucket.barWidth}
                        x={bucket.x}
                        y={bucket.completionY}
                      />
                      <Show when={bucket.failedHeight > 0}>
                        <rect
                          fill="rgb(239, 68, 68)"
                          height={bucket.failedHeight}
                          shape-rendering="crispEdges"
                          width={bucket.barWidth}
                          x={bucket.x}
                          y={bucket.failedY}
                        />
                      </Show>
                      <Show when={shouldShowTimelineXLabel({index: index(), total: timelineRenderBuckets().length})}>
                        <text
                          class="fill-gray-500 text-[11px]"
                          text-anchor="middle"
                          x={bucket.x + bucket.barWidth / 2}
                          y={timelineChartDimensions.height - 10}
                        >
                          {bucket.label}
                        </text>
                      </Show>
                    </g>
                  )
                }}
              </For>
            </svg>
            <Show when={tooltip()}>
              {(currentTooltip) => {
                return (
                  <div
                    class="pointer-events-none absolute z-20 min-w-56 rounded-md bg-gray-950/90 px-3 py-2 text-xs text-white shadow-xl ring-1 ring-black/10 backdrop-blur-sm"
                    style={{
                      left: `${currentTooltip().x}px`,
                      top: `${currentTooltip().y}px`,
                      transform: 'translate(-50%, calc(-100% - 12px))',
                    }}
                  >
                    <div class="mb-2 font-semibold leading-tight text-white">{currentTooltip().title}</div>
                    <div class="space-y-1 text-gray-100">
                      <div class="flex items-center justify-between gap-5">
                        <span class="inline-flex items-center gap-2">
                          <span class="h-2.5 w-2.5 rounded-sm bg-blue-500" /> Prompt
                        </span>
                        <span class="font-medium tabular-nums">
                          {currentTooltip().bucket.promptTokens.toLocaleString()}
                        </span>
                      </div>
                      <div class="flex items-center justify-between gap-5">
                        <span class="inline-flex items-center gap-2">
                          <span class="h-2.5 w-2.5 rounded-sm bg-blue-300" /> Completion
                        </span>
                        <span class="font-medium tabular-nums">
                          {currentTooltip().bucket.completionTokens.toLocaleString()}
                        </span>
                      </div>
                      <Show when={currentTooltip().bucket.failedTokens > 0}>
                        <div class="flex items-center justify-between gap-5">
                          <span class="inline-flex items-center gap-2">
                            <span class="h-2.5 w-2.5 rounded-sm bg-red-500" /> Failed
                          </span>
                          <span class="font-medium tabular-nums">
                            {currentTooltip().bucket.failedTokens.toLocaleString()}
                          </span>
                        </div>
                      </Show>
                    </div>
                    <div class="mt-2 border-t border-white/20 pt-2 leading-5 text-gray-100">
                      <div>Total: {currentTooltip().bucket.totalTokens.toLocaleString()}</div>
                      <div>Prompts Judged: {currentTooltip().bucket.totalRequests.toLocaleString()}</div>
                    </div>
                  </div>
                )
              }}
            </Show>
          </>
        </Show>

        <Show when={tokenData.isLoading && !hasTimelineData()}>
          <div class="absolute inset-0 flex items-center justify-center">
            <p class="text-gray-500">Loading token usage data...</p>
          </div>
        </Show>

        <Show when={tokenData.isError}>
          <div class="absolute inset-0 flex items-center justify-center bg-white/80">
            <div class="text-center">
              <p class="text-red-600 mb-2">Failed to load token usage data</p>
              <button
                onClick={() => {
                  return void tokenData.refetch()
                }}
                class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm"
              >
                Retry
              </button>
            </div>
          </div>
        </Show>

        <Show
          when={
            !tokenData.isLoading
            && !tokenData.isError
            && tokenData.data
            && (tokenData.data?.data as TokenTimelineData[])?.length === 0
          }
        >
          <div class="absolute inset-0 flex items-center justify-center">
            <p class="text-gray-500">No token usage data available for this period</p>
          </div>
        </Show>
      </div>
    </div>
  )
}
