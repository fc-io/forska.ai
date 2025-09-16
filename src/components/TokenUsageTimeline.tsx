import {useQuery} from '@tanstack/solid-query'
import {BarController, BarElement, CategoryScale, Chart, Legend, LinearScale, Tooltip} from 'chart.js'
import {format} from 'date-fns'
import {Bar} from 'solid-chartjs'
import {createEffect, createMemo, createSignal, onCleanup, onMount, Show} from 'solid-js'

import {apiClient} from '../services/apiClient.ts'

type TimeInterval = '1min' | '5min' | '15min' | '1h' | '24h' | '1w' | '1m'

type TokenTimelineData = {
  timestamp: string
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  count: number
}

type TokenUsageTimelineProps = {projectId: string}

export const TokenUsageTimeline = (props: TokenUsageTimelineProps) => {
  const [selectedInterval, setSelectedInterval] = createSignal<TimeInterval>('24h')
  // Keep chart readiness local to this component instance
  const [chartReady, setChartReady] = createSignal(false)

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
    return {
      // Keep key stable for a given project + interval; time window advances via refetch
      queryKey: ['token-timeline', props.projectId, selectedInterval()],
      queryFn: async () => {
        const {start, end} = getDateRangeForInterval(selectedInterval())
        const response = await apiClient.api.tokens.timeline.post({
          projectId: props.projectId,
          interval: selectedInterval(),
          startDate: start.toISOString(),
          endDate: end.toISOString(),
        })

        if (!response.data || !response.data.success) {
          throw new Error('Failed to fetch token timeline')
        }

        return response.data.data
      },
      // Disable built-in polling; we schedule boundary-aligned refetches below
      refetchInterval: false,
      // Avoid extra refetch on focus when data is fresh; still refetch if stale
      refetchOnWindowFocus: true,
      staleTime: (() => {
        const map: Record<TimeInterval, number> = {
          '1min': 10_000,
          '5min': 15_000,
          '15min': 30_000,
          '1h': 60_000,
          '24h': 5 * 60_000,
          '1w': 10 * 60_000,
          '1m': 30 * 60_000,
        }
        return map[selectedInterval()]
      })(),
      // TanStack Query v5 replacement for keepPreviousData
      placeholderData: (prev) => {
        return prev
      },
    }
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
    const interval = selectedInterval()
    const now = new Date()

    const alignEnd = (d: Date) => {
      switch (interval) {
        case '1min':
          return (() => {
            const aligned = new Date(d)
            aligned.setSeconds(0, 0)
            return aligned
          })()
        case '5min':
          return (() => {
            const aligned = new Date(d)
            const m = aligned.getMinutes()
            aligned.setMinutes(Math.floor(m / 5) * 5, 0, 0)
            return aligned
          })()
        case '15min':
          return (() => {
            const aligned = new Date(d)
            const m = aligned.getMinutes()
            aligned.setMinutes(Math.floor(m / 15) * 15, 0, 0)
            return aligned
          })()
        case '1h': {
          const aligned = new Date(d)
          aligned.setMinutes(0, 0, 0)
          return aligned
        }
        case '24h': {
          const aligned = new Date(d)
          aligned.setHours(0, 0, 0, 0)
          return aligned
        }
        case '1w': {
          const aligned = new Date(d)
          aligned.setHours(0, 0, 0, 0)
          const day = aligned.getDay()
          const diffToMonday = (day + 6) % 7
          aligned.setDate(aligned.getDate() - diffToMonday)
          return aligned
        }
        case '1m': {
          const aligned = new Date(d)
          aligned.setDate(1)
          aligned.setHours(0, 0, 0, 0)
          return aligned
        }
      }
    }

    const currentAlignedEnd = alignEnd(now)

    // Compute next boundary by adding one interval to the aligned end
    const nextBoundary = (() => {
      const t = new Date(currentAlignedEnd)
      switch (interval) {
        case '1min':
          t.setMinutes(t.getMinutes() + 1)
          return t
        case '5min':
          t.setMinutes(t.getMinutes() + 5)
          return t
        case '15min':
          t.setMinutes(t.getMinutes() + 15)
          return t
        case '1h':
          t.setHours(t.getHours() + 1)
          return t
        case '24h':
          t.setDate(t.getDate() + 1)
          return t
        case '1w':
          t.setDate(t.getDate() + 7)
          return t
        case '1m':
          t.setMonth(t.getMonth() + 1)
          return t
      }
    })()

    const delay = Math.max(0, nextBoundary.getTime() - now.getTime() + 10) // slight buffer

    boundaryTimer = setTimeout(async () => {
      try {
        await tokenData.refetch()
      } finally {
        // Schedule the next boundary after this one
        scheduleBoundaryRefetch()
      }
    }, delay)
  }

  createEffect(() => {
    // Re-schedule when the selected interval changes
    selectedInterval()
    scheduleBoundaryRefetch()
  })

  onCleanup(() => {
    clearBoundaryTimer()
  })

  const chartData = createMemo(() => {
    const data = tokenData.data
    if (!data || data.length === 0) {
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
            const data = tokenData.data as TokenTimelineData[] | undefined
            if (idx == null || !data || !data[idx]) return ''

            const bucketTs = new Date(data[idx].timestamp)
            const nowTs = new Date()

            if (selectedInterval() === '1m') {
              // Calendar month boundaries; clamp end to now for current month
              const monthStart = new Date(bucketTs.getFullYear(), bucketTs.getMonth(), 1, 0, 0, 0, 0)
              const nominalMonthEnd = new Date(bucketTs.getFullYear(), bucketTs.getMonth() + 1, 0, 23, 59, 59, 999)
              const isCurrentMonth =
                monthStart.getMonth() === nowTs.getMonth() && monthStart.getFullYear() === nowTs.getFullYear()
              const monthEnd = isCurrentMonth ? nowTs : nominalMonthEnd
              const startStr = format(monthStart, 'MMM d')
              const endStr = format(monthEnd, 'MMM d HH:mm')
              return `${startStr} – ${endStr}`
            }

            const intervalMs: Record<Exclude<TimeInterval, '1m'>, number> = {
              '1min': 60 * 1000,
              '5min': 5 * 60 * 1000,
              '15min': 15 * 60 * 1000,
              '1h': 60 * 60 * 1000,
              '24h': 24 * 60 * 60 * 1000,
              '1w': 7 * 24 * 60 * 60 * 1000,
            }
            const nominalEnd = new Date(
              bucketTs.getTime() + intervalMs[selectedInterval() as Exclude<TimeInterval, '1m'>],
            )
            const isLastBucket = idx === (data?.length ?? 0) - 1
            const end = isLastBucket && nominalEnd > nowTs ? nowTs : nominalEnd
            const startStr = format(bucketTs, 'MMM d HH:mm')
            const endStr = format(end, 'MMM d HH:mm')

            return `${startStr} – ${endStr}`
          },
          label: (context: {dataset: {label?: string}; parsed: {y: number}}) => {
            const label = (context.dataset.label || '').replace(' Tokens', '')
            const value = context.parsed.y.toLocaleString()

            return `${label}: ${value}`
          },
          footer: (tooltipItems: {dataIndex: number; parsed: {y: number}}[]) => {
            const idx = tooltipItems?.[0]?.dataIndex
            const data = tokenData.data as TokenTimelineData[] | undefined
            if (idx == null || !data || !data[idx]) return ''
            const total =
              data[idx].totalTokens
              ?? tooltipItems.reduce((sum, item) => {
                return sum + item.parsed.y
              }, 0)
            return `Total: ${total.toLocaleString()}`
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
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div class="mb-6">
        <div class="flex justify-between items-center mb-4">
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-lg font-semibold text-gray-900">Token Usage Timeline</h2>
            </div>
            <p class="text-sm text-gray-500 mt-1">
              <Show when={selectedInterval() === '1min'}>Last 20 minutes</Show>
              <Show when={selectedInterval() === '5min'}>Last 2 hours</Show>
              <Show when={selectedInterval() === '15min'}>Last 16 hours</Show>
              <Show when={selectedInterval() === '1h'}>Last 24 hours</Show>
              <Show when={selectedInterval() === '24h'}>Last 30 days</Show>
              <Show when={selectedInterval() === '1w'}>Last 30 weeks</Show>
              <Show when={selectedInterval() === '1m'}>Last 24 months</Show>
            </p>
          </div>

          <div class="flex gap-2">
            <select
              value={selectedInterval()}
              onChange={(e) => {
                const newInterval = e.target.value as TimeInterval
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

        <Show when={tokenData.data && (tokenData.data as TokenTimelineData[]).length === 0}>
          <div class="h-64 flex items-center justify-center">
            <p class="text-gray-500">No token usage data available for this period</p>
          </div>
        </Show>
      </div>
    </div>
  )
}
