import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {format, formatDistanceToNow, isValid} from 'date-fns'
import {For, Show} from 'solid-js'

import {
  fetchWriterConnections,
  type WriterConnectionRow,
  writerConnectionsQueryKey,
  type WriterWarningRow,
} from '../../../../utils/writerConnectionsQuery.ts'

const formatTs = (value: Date | null) => {
  return value && isValid(value) ? format(value, 'yyyy-MM-dd HH:mm:ss') : '—'
}

const formatAgo = (value: Date | null) => {
  return value && isValid(value) ? `${formatDistanceToNow(value)} ago` : '—'
}

const getWriterConnectionStatusLabel = (row: WriterConnectionRow) => {
  return row.isCurrentProcess ? 'writer' : row.isStale ? 'stale' : 'connected'
}

const getWriterConnectionStatusClass = (row: WriterConnectionRow) => {
  return row.isCurrentProcess
    ? 'bg-emerald-100 text-emerald-700'
    : row.isStale
      ? 'bg-amber-100 text-amber-700'
      : 'bg-blue-100 text-blue-700'
}

const getWriterConnectionLastRoute = (row: WriterConnectionRow) => {
  return row.lastRequestPath ?? '—'
}

const getWriterTakeoverEventLabel = (event: 'acquired' | 'released') => {
  return event === 'acquired' ? 'Writer acquired' : 'Writer released'
}

const getWriterTakeoverEventClass = (event: 'acquired' | 'released') => {
  return event === 'acquired' ? 'bg-emerald-100 text-emerald-700' : 'bg-stone-200 text-stone-700'
}

const getWriterWarningClass = (warning: WriterWarningRow) => {
  return warning.severity === 'error'
    ? 'border-red-200 bg-red-50 text-red-800'
    : 'border-amber-200 bg-amber-50 text-amber-800'
}

const getWriterWarningLabel = (warning: WriterWarningRow) => {
  return warning.kind === 'write-failure'
    ? 'Operation error'
    : warning.kind === 'writer-disabled'
      ? 'Writer disabled'
      : 'Writer unavailable'
}

const WriterConnectionSummaryCard = (props: {label: string; value: string}) => {
  return (
    <div class="rounded-xl border border-stone-200 bg-white px-4 py-4 shadow-sm">
      <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">{props.label}</div>
      <div class="mt-2 text-sm font-medium text-stone-900 break-all">{props.value}</div>
    </div>
  )
}

const AdminWriterConnections = () => {
  const writerConnectionsQuery = useQuery(() => {
    return {
      queryKey: writerConnectionsQueryKey,
      queryFn: fetchWriterConnections,
      refetchInterval: 10_000,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
      suspense: false,
    }
  })

  const writer = () => {
    return writerConnectionsQuery.data?.writer ?? null
  }

  const followers = () => {
    return writerConnectionsQuery.data?.followers ?? []
  }

  const history = () => {
    return writerConnectionsQuery.data?.history ?? []
  }

  const warnings = () => {
    return writerConnectionsQuery.data?.warnings ?? []
  }

  return (
    <div class="min-h-screen bg-stone-50 p-6 mx-auto">
      <div class="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold text-stone-900">Writer Connections</h1>
          <p class="mt-1 text-sm text-stone-500">Writer process and follower API processes currently observed.</p>
        </div>
      </div>

      <Show when={writerConnectionsQuery.isLoading}>
        <p class="text-stone-500">Loading writer connections…</p>
      </Show>

      <Show when={writerConnectionsQuery.isError}>
        <div class="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">
          <div class="font-medium">Failed to load writer connections</div>
          <div class="mt-2 text-sm">
            The current writer may be unavailable. {writerConnectionsQuery.error?.message ?? ''}
          </div>
          <button
            class="mt-3 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            onClick={() => {
              return void writerConnectionsQuery.refetch()
            }}
          >
            Retry
          </button>
        </div>
      </Show>

      <Show when={!writerConnectionsQuery.isLoading && !writerConnectionsQuery.isError && warnings().length > 0}>
        <div class="space-y-3 mb-6">
          <For each={warnings()}>
            {(warning) => {
              return (
                <div class={`rounded-xl border px-4 py-4 shadow-sm ${getWriterWarningClass(warning)}`}>
                  <div class="text-xs font-semibold uppercase tracking-wide">{getWriterWarningLabel(warning)}</div>
                  <div class="mt-2 text-sm font-medium">{warning.message}</div>
                  <div class="mt-2 text-xs opacity-80">
                    {formatTs(warning.at)} ({formatAgo(warning.at)})
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>

      <Show when={!writerConnectionsQuery.isLoading && !writerConnectionsQuery.isError && writer()}>
        {(writerRow) => {
          return (
            <div class="space-y-6">
              <div class="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
                <div class="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div class="text-sm font-semibold uppercase tracking-wide text-stone-500">Current Writer</div>
                    <div class="mt-2 text-xl font-semibold text-stone-900">
                      {writerRow().hostname}:{writerRow().apiServerPort}
                    </div>
                    <div class="mt-2 text-sm text-stone-500">PID {writerRow().pid}</div>
                  </div>
                  <div
                    class={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${getWriterConnectionStatusClass(writerRow())}`}
                  >
                    {getWriterConnectionStatusLabel(writerRow())}
                  </div>
                </div>
                <div class="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <WriterConnectionSummaryCard
                    label="Started"
                    value={`${formatTs(writerRow().startedAt)} (${formatAgo(writerRow().startedAt)})`}
                  />
                  <WriterConnectionSummaryCard
                    label="Last Seen"
                    value={`${formatTs(writerRow().lastSeenAt)} (${formatAgo(writerRow().lastSeenAt)})`}
                  />
                  <WriterConnectionSummaryCard label="Role" value={writerRow().serverRole} />
                  <WriterConnectionSummaryCard label="Writer URL" value={writerRow().writerUrl ?? '—'} />
                </div>
              </div>

              <div class="rounded-2xl border border-stone-200 bg-white shadow-sm">
                <div class="border-b border-stone-200 px-6 py-4">
                  <div class="text-lg font-semibold text-stone-900">Follower Processes</div>
                  <div class="mt-1 text-sm text-stone-500">
                    API processes forwarding requests or heartbeats to the writer.
                  </div>
                </div>

                <Show
                  when={followers().length > 0}
                  fallback={<div class="px-6 py-8 text-sm text-stone-500">No follower processes observed yet.</div>}
                >
                  <div class="overflow-x-auto">
                    <table class="min-w-full divide-y divide-stone-200">
                      <thead class="bg-stone-50">
                        <tr>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Status
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Host
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Port
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            PID
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Role
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Last Seen
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Heartbeat
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Proxy Count
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Last Route
                          </th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-stone-200 bg-white">
                        <For each={followers()}>
                          {(row) => {
                            return (
                              <tr class="hover:bg-stone-50">
                                <td class="px-4 py-3">
                                  <span
                                    class={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${getWriterConnectionStatusClass(row)}`}
                                  >
                                    {getWriterConnectionStatusLabel(row)}
                                  </span>
                                </td>
                                <td class="px-4 py-3 text-sm text-stone-900">{row.hostname}</td>
                                <td class="px-4 py-3 text-sm text-stone-900">{row.apiServerPort}</td>
                                <td class="px-4 py-3 text-sm text-stone-900">{row.pid}</td>
                                <td class="px-4 py-3 text-sm text-stone-900">{row.serverRole}</td>
                                <td class="px-4 py-3 text-sm text-stone-900">
                                  <div>{formatTs(row.lastSeenAt)}</div>
                                  <div class="text-xs text-stone-500">{formatAgo(row.lastSeenAt)}</div>
                                </td>
                                <td class="px-4 py-3 text-sm text-stone-900">{formatTs(row.lastHeartbeatAt)}</td>
                                <td class="px-4 py-3 text-sm text-stone-900">{row.proxyCount}</td>
                                <td class="px-4 py-3 text-xs text-stone-600">{getWriterConnectionLastRoute(row)}</td>
                              </tr>
                            )
                          }}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>

              <div class="rounded-2xl border border-stone-200 bg-white shadow-sm">
                <div class="border-b border-stone-200 px-6 py-4">
                  <div class="text-lg font-semibold text-stone-900">Takeover History</div>
                  <div class="mt-1 text-sm text-stone-500">
                    Recent writer acquire/release events for this DuckDB file.
                  </div>
                </div>

                <Show
                  when={history().length > 0}
                  fallback={<div class="px-6 py-8 text-sm text-stone-500">No takeover events recorded yet.</div>}
                >
                  <div class="overflow-x-auto">
                    <table class="min-w-full divide-y divide-stone-200">
                      <thead class="bg-stone-50">
                        <tr>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Event
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Time
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Host
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Port
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            PID
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Role
                          </th>
                          <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Lease
                          </th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-stone-200 bg-white">
                        <For each={history()}>
                          {(event) => {
                            return (
                              <tr class="hover:bg-stone-50">
                                <td class="px-4 py-3">
                                  <span
                                    class={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${getWriterTakeoverEventClass(event.event)}`}
                                  >
                                    {getWriterTakeoverEventLabel(event.event)}
                                  </span>
                                </td>
                                <td class="px-4 py-3 text-sm text-stone-900">
                                  <div>{formatTs(event.at)}</div>
                                  <div class="text-xs text-stone-500">{formatAgo(event.at)}</div>
                                </td>
                                <td class="px-4 py-3 text-sm text-stone-900">{event.hostname}</td>
                                <td class="px-4 py-3 text-sm text-stone-900">{event.apiServerPort}</td>
                                <td class="px-4 py-3 text-sm text-stone-900">{event.pid}</td>
                                <td class="px-4 py-3 text-sm text-stone-900">{event.serverRole}</td>
                                <td class="px-4 py-3 text-xs text-stone-600">{event.leaseId}</td>
                              </tr>
                            )
                          }}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>
            </div>
          )
        }}
      </Show>

      <Show
        when={
          !writerConnectionsQuery.isLoading && !writerConnectionsQuery.isError && !writer() && warnings().length > 0
        }
      >
        <div class="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm text-sm text-stone-600">
          No active writer is attached to this server.
        </div>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/writer-connections/')({component: AdminWriterConnections})
