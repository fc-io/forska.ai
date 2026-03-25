import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {format, formatDistanceToNow, isValid, parseISO} from 'date-fns'
import {For, Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'

type AppendMetrics = {
  averageRowsPerSecond: number | null
  averageRowsPerSecondAttempted: number | null
  batchesCompleted: number
  batchesStarted: number
  laneCount: number
  lastDurationMs: number | null
  lastInsertedRows: number | null
  lastInsertedRowsPerSecond: number | null
  lastSkippedRows: number | null
  lastStartedAt: string | null
  maxQueueDepth: number
  maxQueueDepthByLane: number[]
  queueDepth: number
  queueDepthByLane: number[]
  rowsAttempted: number
  rowsInserted: number
  rowsSkipped: number
  totalDurationMs: number
}

const duckdbAppendMetricsQueryKey = ['admin', 'duckdb-append-metrics'] as const

const fetchDuckdbAppendMetrics = async (): Promise<AppendMetrics> => {
  const response = await apiClient.api.admin['duckdb-append-metrics'].get()

  if (response.error || !response.data) {
    throw new Error('Failed to fetch DuckDB append metrics')
  }

  return response.data as AppendMetrics
}

const formatNumber = (value: number | null | undefined) => {
  return value === null || value === undefined ? '—' : value.toLocaleString('en-US')
}

const formatDecimal = (value: number | null | undefined) => {
  return value === null || value === undefined ? '—' : value.toFixed(2)
}

const formatTimestamp = (value: string | null | undefined) => {
  if (!value) {
    return '—'
  }

  const parsed = parseISO(value)
  return isValid(parsed) ? format(parsed, 'yyyy-MM-dd HH:mm:ss') : '—'
}

const formatAgo = (value: string | null | undefined) => {
  if (!value) {
    return '—'
  }

  const parsed = parseISO(value)
  return isValid(parsed) ? `${formatDistanceToNow(parsed)} ago` : '—'
}

const MetricCard = (props: {label: string; value: string; tone?: 'neutral' | 'success' | 'warning'}) => {
  const toneClass = () => {
    return props.tone === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : props.tone === 'warning'
        ? 'border-amber-200 bg-amber-50 text-amber-900'
        : 'border-stone-200 bg-white text-stone-900'
  }

  return (
    <div class={`rounded-2xl border px-4 py-4 shadow-sm ${toneClass()}`}>
      <div class="text-xs font-semibold uppercase tracking-wide opacity-70">{props.label}</div>
      <div class="mt-2 text-2xl font-semibold">{props.value}</div>
    </div>
  )
}

const AdminDuckdbAppendMetrics = () => {
  const appendMetricsQuery = useQuery(() => {
    return {
      queryFn: fetchDuckdbAppendMetrics,
      queryKey: duckdbAppendMetricsQueryKey,
      refetchInterval: 5_000,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
    }
  })

  const metrics = () => {
    return appendMetricsQuery.data
  }

  return (
    <div class="min-h-screen bg-stone-50 p-6 mx-auto">
      <div class="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold text-stone-900">DuckDB Append Metrics</h1>
          <p class="mt-1 text-sm text-stone-500">
            Live queue depth and append throughput for the judgment import append lanes.
          </p>
        </div>
        <Link
          to="/admin/jobs"
          class="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-100"
        >
          Back to Jobs
        </Link>
      </div>

      <Show when={appendMetricsQuery.isLoading}>
        <div class="rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-500 shadow-sm">
          Loading append metrics…
        </div>
      </Show>

      <Show when={appendMetricsQuery.isError}>
        <div class="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-700 shadow-sm">
          <div class="font-semibold">Failed to load append metrics</div>
          <div class="mt-2 text-sm">{appendMetricsQuery.error?.message ?? ''}</div>
          <button
            class="mt-4 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            onClick={() => {
              return void appendMetricsQuery.refetch()
            }}
          >
            Retry
          </button>
        </div>
      </Show>

      <Show when={!appendMetricsQuery.isLoading && !appendMetricsQuery.isError && metrics()}>
        {(appendMetrics) => {
          return (
            <div class="space-y-6">
              <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Lane Count" value={formatNumber(appendMetrics().laneCount)} />
                <MetricCard
                  label="Queue Depth"
                  value={formatNumber(appendMetrics().queueDepth)}
                  tone={appendMetrics().queueDepth > 0 ? 'warning' : 'success'}
                />
                <MetricCard label="Peak Queue Depth" value={formatNumber(appendMetrics().maxQueueDepth)} />
                <MetricCard label="Rows Inserted" value={formatNumber(appendMetrics().rowsInserted)} tone="success" />
                <MetricCard label="Rows Attempted" value={formatNumber(appendMetrics().rowsAttempted)} />
                <MetricCard label="Rows Skipped" value={formatNumber(appendMetrics().rowsSkipped)} />
                <MetricCard label="Avg Inserted Rows/sec" value={formatDecimal(appendMetrics().averageRowsPerSecond)} />
                <MetricCard
                  label="Avg Attempted Rows/sec"
                  value={formatDecimal(appendMetrics().averageRowsPerSecondAttempted)}
                />
              </div>

              <div class="grid gap-6 xl:grid-cols-[2fr_1fr]">
                <div class="rounded-2xl border border-stone-200 bg-white shadow-sm">
                  <div class="border-b border-stone-200 px-6 py-4">
                    <div class="text-lg font-semibold text-stone-900">Per-Lane Queue Pressure</div>
                    <div class="mt-1 text-sm text-stone-500">
                      Current queue depth and peak queue depth for each append lane.
                    </div>
                  </div>
                  <div class="overflow-x-auto">
                    <table class="min-w-full divide-y divide-stone-200">
                      <thead class="bg-stone-50">
                        <tr>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Lane
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Queue Depth
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Peak Depth
                          </th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-stone-100 bg-white">
                        <For each={appendMetrics().queueDepthByLane}>
                          {(queueDepth, laneIndex) => {
                            return (
                              <tr>
                                <td class="px-4 py-3 text-sm font-medium text-stone-900">Lane {laneIndex() + 1}</td>
                                <td class="px-4 py-3 text-sm text-stone-700">{formatNumber(queueDepth)}</td>
                                <td class="px-4 py-3 text-sm text-stone-700">
                                  {formatNumber(appendMetrics().maxQueueDepthByLane[laneIndex()] ?? 0)}
                                </td>
                              </tr>
                            )
                          }}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div class="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
                  <div class="text-lg font-semibold text-stone-900">Last Batch</div>
                  <div class="mt-4 space-y-4 text-sm text-stone-600">
                    <div>
                      <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">Started</div>
                      <div class="mt-1 font-medium text-stone-900">
                        {formatTimestamp(appendMetrics().lastStartedAt)}
                      </div>
                      <div class="mt-1 text-xs text-stone-500">{formatAgo(appendMetrics().lastStartedAt)}</div>
                    </div>
                    <div>
                      <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">Duration</div>
                      <div class="mt-1 font-medium text-stone-900">
                        {formatNumber(appendMetrics().lastDurationMs)} ms
                      </div>
                    </div>
                    <div>
                      <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">Inserted / Skipped</div>
                      <div class="mt-1 font-medium text-stone-900">
                        {formatNumber(appendMetrics().lastInsertedRows)} /{' '}
                        {formatNumber(appendMetrics().lastSkippedRows)}
                      </div>
                    </div>
                    <div>
                      <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                        Last Inserted Rows/sec
                      </div>
                      <div class="mt-1 font-medium text-stone-900">
                        {formatDecimal(appendMetrics().lastInsertedRowsPerSecond)}
                      </div>
                    </div>
                    <div>
                      <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                        Batches Started / Completed
                      </div>
                      <div class="mt-1 font-medium text-stone-900">
                        {formatNumber(appendMetrics().batchesStarted)} /{' '}
                        {formatNumber(appendMetrics().batchesCompleted)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        }}
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/duckdb-append/')({component: AdminDuckdbAppendMetrics})
