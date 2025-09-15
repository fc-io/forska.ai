import {Tooltip} from '@ark-ui/solid'
import {useQuery} from '@tanstack/solid-query'
import {format} from 'date-fns'
import {Bar} from 'solid-chartjs'
import {createMemo, createSignal, onMount, Show} from 'solid-js'

import {apiClient} from '../services/apiClient.ts'

type TimeInterval = '5min' | '15min' | '1h' | '24h' | '1w' | '1m'

type TokenTimelineData = {
  timestamp: string
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  count: number
}

type TokenUsageTimelineProps = {projectId: string}

const intervalLabels: Record<TimeInterval, string> = {
  '5min': '5 minutes',
  '15min': '15 minutes',
  '1h': '1 hour',
  '24h': '24 hours',
  '1w': '1 week',
  '1m': '1 month',
}

export const TokenUsageTimeline = (props: TokenUsageTimelineProps) => {
  const [selectedInterval, setSelectedInterval] = createSignal<TimeInterval>('24h')

  const getDateRangeForInterval = (interval: TimeInterval) => {
    const now = new Date()

    // Helper to get local start-of-day for N days ago
    const startOfNDaysAgo = (daysAgo: number) => {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - daysAgo)
      return d
    }

    switch (interval) {
      case '24h': {
        // For daily buckets, show the last 30 days, aligned to local midnight
        return {start: startOfNDaysAgo(29), end: now}
      }
      case '5min':
      case '15min':
      case '1h': {
        const ranges = {'5min': 5 * 60 * 1000, '15min': 15 * 60 * 1000, '1h': 60 * 60 * 1000}
        return {start: new Date(now.getTime() - ranges[interval]), end: now}
      }
      case '1w': {
        return {start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now}
      }
      case '1m':
      default: {
        return {start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now}
      }
    }
  }

  const [dateRange, setDateRange] = createSignal(getDateRangeForInterval(selectedInterval()))

  const tokenData = useQuery(() => {
    return {
      queryKey: ['token-timeline', props.projectId, selectedInterval(), dateRange().start, dateRange().end],
      queryFn: async () => {
        const response = await apiClient.api.tokens.timeline.post({
          projectId: props.projectId,
          interval: selectedInterval(),
          startDate: dateRange().start.toISOString(),
          endDate: dateRange().end.toISOString(),
        })

        if (!response.data || !response.data.success) {
          throw new Error('Failed to fetch token timeline')
        }

        return response.data.data
      },
      refetchInterval: 30000, // Refresh every 30 seconds
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
        return selectedInterval() === '5min' || selectedInterval() === '15min'
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
          barThickness: selectedInterval() === '5min' ? 4 : selectedInterval() === '15min' ? 6 : 8,
        },
        {
          label: 'Completion Tokens',
          data: data.map((d) => {
            return d.totalCompletionTokens
          }),
          backgroundColor: 'rgb(147, 197, 253)',
          borderColor: 'rgb(147, 197, 253)',
          borderWidth: 0,
          barThickness: selectedInterval() === '5min' ? 4 : selectedInterval() === '15min' ? 6 : 8,
        },
      ],
    }
  })

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {mode: 'index' as const, intersect: false},
    animation: {duration: 0},
    plugins: {
      legend: {
        display: true,
        position: 'top' as const,
        align: 'end' as const,
        labels: {boxWidth: 12, padding: 10, font: {size: 11}},
      },
      tooltip: {
        callbacks: {
          label: (context: {dataset: {label?: string}; parsed: {y: number}}) => {
            const label = context.dataset.label || ''
            const value = context.parsed.y.toLocaleString()
            return `${label}: ${value}`
          },
          footer: (tooltipItems: {parsed: {y: number}}[]) => {
            const total = tooltipItems.reduce((sum, item) => {
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
    void import('chart.js/auto')
  })

  return (
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div class="mb-6">
        <div class="flex justify-between items-center mb-4">
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-lg font-semibold text-gray-900">Token Usage Timeline</h2>
              <Tooltip.Root>
                <Tooltip.Trigger
                  aria-label="About this chart"
                  class="inline-flex items-center justify-center text-gray-400 hover:text-gray-600 focus-visible:outline-none"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="size-4"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 17v-4" />
                    <path d="M12 8h.01" />
                    <title>About</title>
                  </svg>
                </Tooltip.Trigger>
                <Tooltip.Positioner>
                  <Tooltip.Content class="z-50 max-w-xs rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 shadow-md">
                    <div class="font-medium text-gray-900 mb-1">How to read</div>
                    <p>
                      Aggregated by {intervalLabels[selectedInterval()]}. Stacked bars show prompt and completion
                      tokens. Hover a bar for exact values and total. Times use your local timezone.
                    </p>
                  </Tooltip.Content>
                </Tooltip.Positioner>
              </Tooltip.Root>
            </div>
            <p class="text-sm text-gray-500 mt-1">
              {selectedInterval() === '24h'
                ? 'Showing daily token usage for the last 30 days'
                : `Showing token usage for the last ${intervalLabels[selectedInterval()]}`}
            </p>
          </div>

          <div class="flex gap-2">
            <select
              value={selectedInterval()}
              onChange={(e) => {
                const newInterval = e.target.value as TimeInterval
                setSelectedInterval(newInterval)
                return setDateRange(getDateRangeForInterval(newInterval))
              }}
              class="px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
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

        <Show when={chartData()}>
          <div class="h-64">
            <Bar data={chartData() || {labels: [], datasets: []}} options={chartOptions} />
          </div>
        </Show>

        <Show when={tokenData.data && (tokenData.data as TokenTimelineData[]).length === 0}>
          <div class="h-64 flex items-center justify-center">
            <p class="text-gray-500">No token usage data available for this period</p>
          </div>
        </Show>
      </div>
    </div>
  )
}
