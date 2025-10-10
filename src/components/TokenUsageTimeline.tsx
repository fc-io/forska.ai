import {type DateValue, fromDate} from '@internationalized/date'
import {useQuery} from '@tanstack/solid-query'
import {
  type ActiveElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  Tooltip,
} from 'chart.js'
import {format} from 'date-fns'
import {Bar} from 'solid-chartjs'
import {createEffect, createMemo, createSignal, onCleanup, onMount, Show, Suspense} from 'solid-js'

import {apiClient} from '../services/apiClient.ts'
import {TokenUsageTimelineDatePicker} from './TokenUsageTimeline/TokenUsageTimelineDatePicker.tsx'
import {
  getTokenUsageTimelineEndOfDay,
  getTokenUsageTimelinePickerValues,
  type TokenUsageTimelineDateRange,
} from './TokenUsageTimeline/TokenUsageTimelineDateRange.ts'

type TimeInterval = '1min' | '5min' | '15min' | '1h' | '24h' | '1w' | '1m'

type TokenTimelineData = {
  timestamp: string
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  totalRequests: number
  count: number
}

type UsageStat = {timestamp: string; totalTokens: number}

type TokenUsageTimelineProps = {projectId?: string; allJobs?: boolean}

export const TokenUsageTimeline = (props: TokenUsageTimelineProps) => {
  const [selectedInterval, setSelectedInterval] = createSignal<TimeInterval>('1min')
  const [customRange, setCustomRange] = createSignal<TokenUsageTimelineDateRange | null>(null)
  // Keep chart readiness local to this component instance
  const [chartReady, setChartReady] = createSignal(false)
  const [pendingPickerValues, setPendingPickerValues] = createSignal<DateValue[] | undefined>(undefined)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const hasCustomRange = createMemo(() => {
    return customRange() !== null
  })
  const maxSelectableDate = fromDate(getTokenUsageTimelineEndOfDay(new Date()), timeZone)

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
      // Avoid extra refetch on focus when data is fresh; still refetch if stale
      refetchOnWindowFocus: true,
      staleTime: 10_000,
      // TanStack Query v5 replacement for keepPreviousData
      placeholderData: (prev) => {
        return prev
      },
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

  const highestUsageStat = createMemo(() => {
    return (tokenData.data?.highestUsage ?? null) as UsageStat | null
  })

  const p90UsageStat = createMemo(() => {
    return (tokenData.data?.p90Usage ?? null) as UsageStat | null
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
    if (selectedInterval() === '1min') {
      return data.length > 1 ? data.slice(0, -1) : []
    }
    return data
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

  const chartData = createMemo(() => {
    const data = filteredTimelineData()
    if (data.length === 0) {
      return null
    }

    return {
      labels: data.map((d) => {
        const date = new Date(d.timestamp)
        return selectedInterval() === '1min' || selectedInterval() === '5min' || selectedInterval() === '15min'
          ? format(date, 'HH:mm')
          : selectedInterval() === '1h'
            ? format(date, 'MMM d HH:mm')
            : selectedInterval() === '1m'
              ? format(new Date(date.getFullYear(), date.getMonth(), 1), 'MMM yyyy')
              : format(date, 'MMM d')
      }),
      datasets: [
        {
          label: 'Prompt Tokens',
          data: data.map((d) => {
            return d.totalPromptTokens
          }),
          backgroundColor: 'rgb(59, 130, 246)',
          borderColor: 'rgb(59, 130, 246)',
          borderWidth: 0,
          barThickness:
            selectedInterval() === '1min'
              ? 3
              : selectedInterval() === '5min'
                ? 4
                : selectedInterval() === '15min'
                  ? 6
                  : 8,
        },
        {
          label: 'Completion Tokens',
          data: data.map((d) => {
            return d.totalCompletionTokens
          }),
          backgroundColor: 'rgb(147, 197, 253)',
          borderColor: 'rgb(147, 197, 253)',
          borderWidth: 0,
          barThickness:
            selectedInterval() === '1min'
              ? 3
              : selectedInterval() === '5min'
                ? 4
                : selectedInterval() === '15min'
                  ? 6
                  : 8,
        },
      ],
    }
  })

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {mode: 'index' as const, intersect: false},
    animation: {duration: 0.4},
    onClick: (_event: unknown, elements: ActiveElement[]) => {
      const element = elements?.[0]
      if (!element) {
        return
      }
      const currentInterval = selectedInterval()
      if (currentInterval === '1min') {
        return
      }
      const data = filteredTimelineData()
      const dataIndex = element.index
      if (dataIndex == null || !data[dataIndex]) {
        return
      }
      const drillDownInterval = lowerIntervalMap[currentInterval]
      if (!drillDownInterval) {
        return
      }
      const range = computeBucketRange({
        interval: currentInterval,
        timestamp: data[dataIndex].timestamp,
        index: dataIndex,
        total: data.length,
      })
      setCustomRange({start: new Date(range.start), end: new Date(range.end)})
      setSelectedInterval(drillDownInterval)
    },
    plugins: {
      legend: {
        display: true,
        position: 'top' as const,
        align: 'end' as const,
        labels: {boxWidth: 12, padding: 10, font: {size: 11}},
      },
      tooltip: {
        callbacks: {
          title: (tooltipItems: {dataIndex: number}[]) => {
            const idx = tooltipItems?.[0]?.dataIndex
            const data = filteredTimelineData()
            if (idx == null || !data[idx]) return ''
            const interval = selectedInterval()
            const range = computeBucketRange({interval, timestamp: data[idx].timestamp, index: idx, total: data.length})
            if (interval === '1m') {
              const startStr = format(range.start, 'MMM d')
              const endStr = format(range.end, 'MMM d HH:mm')
              return `${startStr} – ${endStr}`
            }
            const startStr = format(range.start, 'MMM d HH:mm')
            const endStr = format(range.end, 'MMM d HH:mm')
            return `${startStr} – ${endStr}`
          },
          label: (context: {dataset: {label?: string}; parsed: {y: number}}) => {
            const label = (context.dataset.label || '').replace(' Tokens', '')
            const value = context.parsed.y.toLocaleString()

            return `${label}: ${value}`
          },
          footer: (tooltipItems: {dataIndex: number; parsed: {y: number}}[]) => {
            const idx = tooltipItems?.[0]?.dataIndex
            const data = filteredTimelineData()
            if (idx == null || !data[idx]) return ''
            const total =
              data[idx].totalTokens
              ?? tooltipItems.reduce((sum, item) => {
                return sum + item.parsed.y
              }, 0)
            const requests = data[idx].totalRequests ?? 0
            return `Total: ${total.toLocaleString()}\nArticles Judged: ${requests.toLocaleString()}`
          },
        },
      },
    },
    scales: {
      x: {grid: {display: false}, ticks: {maxRotation: 0, autoSkip: true, maxTicksLimit: 20}, stacked: true},
      y: {
        beginAtZero: true,
        grid: {color: 'rgba(0, 0, 0, 0.05)'},
        ticks: {
          callback: (value: number) => {
            return value.toLocaleString()
          },
        },
        stacked: true,
      },
    },
  }

  onMount(() => {
    Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend)
    setChartReady(true)
  })

  return (
    <Suspense>
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div class="mb-6">
          <div class="flex justify-between items-center mb-4">
            <div>
            <div class="flex items-center gap-2">
              <h2 class="text-lg font-semibold text-gray-900">Token Usage Timeline</h2>
            </div>
            <div>
              <Show when={highestUsageStat()}>
                <div class="text-sm text-gray-600 mt-1">
                  <span class="font-medium">Highest per {intervalBucketLabel()}: </span>
                  <span>{highestUsageStat()?.totalTokens.toLocaleString()} tokens</span>
                  <span class="text-gray-400 ml-1">({intervalHistoryLabel()})</span>
                </div>
              </Show>
              <Show when={p90UsageStat()}>
                <div class="text-sm text-gray-600 mt-1">
                  <span class="font-medium">90th percentile per {intervalBucketLabel()}: </span>
                  <span>{p90UsageStat()?.totalTokens.toLocaleString()} tokens</span>
                  <span class="text-gray-400 ml-1">({intervalHistoryLabel()})</span>
                </div>
              </Show>
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

        <Show when={tokenData.isLoading}>
          <div class="h-64 flex items-center justify-center">
            <p class="text-gray-500">Loading token usage data...</p>
          </div>
        </Show>

        <Show when={tokenData.isError}>
          <div class="h-64 flex items-center justify-center">
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

        <div class="h-64">
          <Show when={chartReady() && chartData()}>
            <Bar data={chartData() || {labels: [], datasets: []}} options={chartOptions} />
          </Show>
        </div>

        <Show when={tokenData.data && (tokenData.data?.data as TokenTimelineData[])?.length === 0}>
          <div class="h-64 flex items-center justify-center">
            <p class="text-gray-500">No token usage data available for this period</p>
          </div>
        </Show>
      </div>
    </Suspense>
  )
}
