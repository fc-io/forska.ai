import {useQuery} from '@tanstack/solid-query'
import {BarController, BarElement, CategoryScale, Chart, Legend, LinearScale, Tooltip} from 'chart.js'
import {format} from 'date-fns'
import {Bar} from 'solid-chartjs'
import {createMemo, createSignal, onMount, Show} from 'solid-js'

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

    switch (interval) {
      case '1min': {
        // Last 10 minutes, aligned to 1-minute boundaries
        const end = alignToInterval(now, 1)
        return {start: new Date(end.getTime() - 10 * 60 * 1000), end}
      }
      case '5min': {
        // Last 1 hour, aligned to 5-minute boundaries
        const end = alignToInterval(now, 5)
        return {start: new Date(end.getTime() - 60 * 60 * 1000), end}
      }
      case '15min': {
        // Last 8 hours, aligned to 15-minute boundaries
        const end = alignToInterval(now, 15)
        return {start: new Date(end.getTime() - 8 * 60 * 60 * 1000), end}
      }
      case '1h': {
        // Last 24 hours
        return {start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now}
      }
      case '24h': {
        // For daily buckets, show the last 30 days, aligned to local midnight
        return {start: startOfNDaysAgo(29), end: now}
      }
      case '1w': {
        // Last 30 weeks
        return {start: new Date(now.getTime() - 30 * 7 * 24 * 60 * 60 * 1000), end: now}
      }
      case '1m': {
        // Last 24 months
        const d = new Date()
        d.setMonth(d.getMonth() - 24)
        return {start: d, end: now}
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
      refetchInterval: (() => {
        const map: Record<TimeInterval, number> = {
          '1min': 10_000, // refresh very fast for 1 minute windows
          '5min': 15_000, // refresh faster for short windows
          '15min': 30_000,
          '1h': 60_000,
          '24h': 5 * 60_000,
          '1w': 10 * 60_000,
          '1m': 30 * 60_000,
        }
        return map[selectedInterval()]
      })(),
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
            console.log('tooltipItems!!!')
            const idx = tooltipItems?.[0]?.dataIndex
            const data = tokenData.data as TokenTimelineData[] | undefined
            if (idx == null || !data || !data[idx]) return ''

            const start = new Date(data[idx].timestamp)
            const intervalMs: Record<TimeInterval, number> = {
              '1min': 60 * 1000,
              '5min': 5 * 60 * 1000,
              '15min': 15 * 60 * 1000,
              '1h': 60 * 60 * 1000,
              '24h': 24 * 60 * 60 * 1000,
              '1w': 7 * 24 * 60 * 60 * 1000,
              '1m': 30 * 24 * 60 * 60 * 1000,
            }
            const end = new Date(start.getTime() + intervalMs[selectedInterval()])
            const startStr = format(start, 'MMM d HH:mm')
            const endStr = format(end, 'MMM d HH:mm')

            return `${startStr} – ${endStr}`
          },
          label: (context: {dataset: {label?: string}; parsed: {y: number}}) => {
            const label = (context.dataset.label || '').replace(' Tokens', '')
            const value = context.parsed.y.toLocaleString()

            return `${label}: ${value}`
          },
          footer: (tooltipItems: {dataIndex: number; parsed: {y: number}}[]) => {
            console.log('footer!!!')

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
              <Show when={selectedInterval() === '1min'}>Last 10 minutes</Show>
              <Show when={selectedInterval() === '5min'}>Last hour</Show>
              <Show when={selectedInterval() === '15min'}>Last 8 hours</Show>
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
