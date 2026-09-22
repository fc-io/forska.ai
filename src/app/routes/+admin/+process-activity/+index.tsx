import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {format, formatDistanceToNow, isValid, parseISO} from 'date-fns'
import {For, Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'

type ProcessActivityStatus = 'completed' | 'failed' | 'idle' | 'running' | 'skipped'
type ProcessActivityDetails = Record<string, unknown>
type ProcessActivityTimestamp = Date | string

type ProcessActivityRecord = {
  category: string
  details: ProcessActivityDetails
  durationMs: number | null
  finishedAt: ProcessActivityTimestamp | null
  id: string
  label: string
  startedAt: ProcessActivityTimestamp
  status: ProcessActivityStatus
  updatedAt: ProcessActivityTimestamp
}

type ProcessActivityResponse = {activity: {active: ProcessActivityRecord[]; recent: ProcessActivityRecord[]}}

const processActivityQueryKey = ['admin', 'process-activity'] as const

const fetchProcessActivity = async (): Promise<ProcessActivityResponse> => {
  const response = await apiClient.api.admin['process-activity'].get({query: {limit: '80'}})

  if (response.error || !response.data?.data) {
    throw new Error('Failed to fetch process activity')
  }

  return response.data.data as ProcessActivityResponse
}

const parseTimestamp = (value: ProcessActivityTimestamp | null | undefined) => {
  if (!value) {
    return null
  }

  if (value instanceof Date) {
    return isValid(value) ? value : null
  }

  const parsed = parseISO(value)
  return isValid(parsed) ? parsed : null
}

const formatTimestamp = (value: ProcessActivityTimestamp | null | undefined) => {
  const parsed = parseTimestamp(value)
  return parsed === null ? '-' : format(parsed, 'yyyy-MM-dd HH:mm:ss')
}

const formatAgo = (value: ProcessActivityTimestamp | null | undefined) => {
  const parsed = parseTimestamp(value)
  return parsed === null ? '-' : `${formatDistanceToNow(parsed)} ago`
}

const formatDuration = (value: number | null | undefined) => {
  if (value === null || value === undefined) {
    return '-'
  }

  if (value < 1_000) {
    return `${value} ms`
  }

  const seconds = value / 1_000
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`
  }

  return `${(seconds / 60).toFixed(1)} min`
}

const formatDetails = (details: ProcessActivityDetails) => {
  const entries = Object.entries(details).filter(([, value]) => {
    return value !== null && value !== undefined
  })

  if (entries.length === 0) {
    return '-'
  }

  return JSON.stringify(Object.fromEntries(entries), null, 2)
}

const getStatusClass = (status: ProcessActivityStatus) => {
  return status === 'running'
    ? 'bg-blue-100 text-blue-700 ring-blue-200'
    : status === 'completed'
      ? 'bg-emerald-100 text-emerald-700 ring-emerald-200'
      : status === 'failed'
        ? 'bg-red-100 text-red-700 ring-red-200'
        : status === 'skipped'
          ? 'bg-amber-100 text-amber-700 ring-amber-200'
          : 'bg-stone-100 text-stone-700 ring-stone-200'
}

const StatusBadge = (props: {status: ProcessActivityStatus}) => {
  return (
    <span class={`rounded-full px-2 py-1 text-xs font-semibold ring-1 ring-inset ${getStatusClass(props.status)}`}>
      {props.status}
    </span>
  )
}

const ActivityTable = (props: {emptyLabel: string; rows: ProcessActivityRecord[]; title: string}) => {
  return (
    <div class="rounded-lg border border-stone-200 bg-white shadow-sm">
      <div class="border-b border-stone-200 px-6 py-4">
        <div class="text-lg font-semibold text-stone-900">{props.title}</div>
      </div>
      <Show
        when={props.rows.length > 0}
        fallback={<div class="px-6 py-8 text-sm text-stone-500">{props.emptyLabel}</div>}
      >
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-stone-200">
            <thead class="bg-stone-50">
              <tr>
                <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">Status</th>
                <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">Work</th>
                <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                  Category
                </th>
                <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                  Updated
                </th>
                <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                  Duration
                </th>
                <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                  Details
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-stone-100 bg-white">
              <For each={props.rows}>
                {(row) => {
                  return (
                    <tr class="align-top hover:bg-stone-50">
                      <td class="px-4 py-3">
                        <StatusBadge status={row.status} />
                      </td>
                      <td class="px-4 py-3">
                        <div class="text-sm font-medium text-stone-900">{row.label}</div>
                        <div class="mt-1 font-mono text-xs text-stone-500">{row.id}</div>
                      </td>
                      <td class="px-4 py-3 text-sm text-stone-700">{row.category}</td>
                      <td class="px-4 py-3 text-sm text-stone-700">
                        <div>{formatTimestamp(row.updatedAt)}</div>
                        <div class="mt-1 text-xs text-stone-500">{formatAgo(row.updatedAt)}</div>
                      </td>
                      <td class="px-4 py-3 text-sm text-stone-700">{formatDuration(row.durationMs)}</td>
                      <td class="max-w-xl px-4 py-3">
                        <pre class="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-stone-50 p-3 text-xs leading-5 text-stone-700">
                          {formatDetails(row.details)}
                        </pre>
                      </td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  )
}

const AdminProcessActivity = () => {
  const processActivityQuery = useQuery(() => {
    return {
      queryFn: fetchProcessActivity,
      queryKey: processActivityQueryKey,
      refetchInterval: 5_000,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
      suspense: false,
    }
  })

  const data = () => {
    return processActivityQuery.data
  }

  return (
    <div class="min-h-screen bg-stone-50 p-6 mx-auto">
      <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold text-stone-900">Process Activity</h1>
          <p class="mt-1 max-w-3xl text-sm text-stone-500">
            In-memory activity for the currently served backend process. Split runtime requests show the DuckDB owner
            process.
          </p>
        </div>
        <Link
          to="/admin/duckdb-owner-connections"
          class="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-100"
        >
          Owner Status
        </Link>
      </div>

      <Show when={processActivityQuery.isLoading}>
        <div class="rounded-lg border border-stone-200 bg-white p-6 text-sm text-stone-500 shadow-sm">
          Loading process activity...
        </div>
      </Show>

      <Show when={processActivityQuery.isError}>
        <div class="rounded-lg border border-red-200 bg-red-50 p-6 text-red-700 shadow-sm">
          <div class="font-semibold">Failed to load process activity</div>
          <div class="mt-2 text-sm">{processActivityQuery.error?.message ?? ''}</div>
          <button
            class="mt-4 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            onClick={() => {
              return void processActivityQuery.refetch()
            }}
          >
            Retry
          </button>
        </div>
      </Show>

      <Show when={!processActivityQuery.isLoading && !processActivityQuery.isError && data()}>
        {(activityData) => {
          const activeRows = () => {
            return activityData().activity.active
          }
          const recentRows = () => {
            return activityData().activity.recent
          }

          return (
            <div class="space-y-6">
              <ActivityTable
                emptyLabel="No active in-memory work is recorded."
                rows={activeRows()}
                title="Current Work"
              />
              <ActivityTable
                emptyLabel="No recent activity has been recorded yet."
                rows={recentRows()}
                title="Recent Activity"
              />
            </div>
          )
        }}
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/process-activity/')({component: AdminProcessActivity})
