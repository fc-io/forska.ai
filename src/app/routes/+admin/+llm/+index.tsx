import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {format, isValid} from 'date-fns'
import {For, Show} from 'solid-js'

import {
  fetchLlmStatus,
  getLatestLlmStatusRowsByInstance,
  getLlmStatusRefetchInterval,
  llmStatusQueryKey,
  type LlmStatusRow,
} from '../../../../utils/llmStatusQuery'

const formatPercent = (value: number | null | undefined, fractionDigits = 0) => {
  const normalized = value === null || value === undefined ? null : value
  const scaled = normalized === null ? null : normalized > 1 ? normalized : normalized * 100
  return scaled === null ? '—' : `${scaled.toFixed(fractionDigits)}%`
}

const formatPresence = (value: number | null | undefined) => {
  return value === null || value === undefined ? '—' : 'present'
}

const formatQueueBreakdown = (row: LlmStatusRow) => {
  const parts: Array<[string, number | null | undefined]> = [
    ['Grammar', row.numGrammarQueueReqs],
    ['PrefillPrealloc', row.numPrefillPreallocQueueReqs],
    ['PrefillInflight', row.numPrefillInflightQueueReqs],
    ['DecodePrealloc', row.numDecodePreallocQueueReqs],
    ['DecodeTransfer', row.numDecodeTransferQueueReqs],
    ['OfflineBatch', row.numRunningReqsOfflineBatch],
  ]
  return parts
    .map(([label, value]) => {
      const display = value === null || value === undefined ? '—' : `${value}`
      return `${label}:${display}`
    })
    .join(' ')
}

const AdminLlm = () => {
  const statusQuery = useQuery(() => {
    return {
      queryKey: llmStatusQueryKey,
      queryFn: fetchLlmStatus,
      refetchInterval: (query) => {
        return getLlmStatusRefetchInterval(query.state.data?.rows ?? [])
      },
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    }
  })

  const rows = () => {
    return statusQuery.data?.rows ?? []
  }

  const latestRows = () => {
    return getLatestLlmStatusRowsByInstance(rows())
  }

  const formatTs = (value: Date | null | undefined) => {
    return !value ? '—' : isValid(value) ? format(value, 'yyyy-MM-dd HH:mm:ss') : '—'
  }

  const formatNumber = (value: number | null | undefined, fractionDigits = 2) => {
    return value === null || value === undefined ? '—' : value.toFixed(fractionDigits)
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">LLM Metrics (latest 50)</h1>
      </div>

      <Show when={statusQuery.isLoading}>
        <p class="text-gray-500">Loading LLM Metrics…</p>
      </Show>
      <Show when={statusQuery.isError}>
        <div class="p-4 rounded-md bg-red-50 border border-red-200">
          <p class="text-red-600">Failed to load LLM Metrics</p>
          <button
            onClick={() => {
              return void statusQuery.refetch()
            }}
            class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </Show>

      <Show when={!statusQuery.isLoading && !statusQuery.isError}>
        <Show when={latestRows().length > 0}>
          <div class="bg-white rounded-lg shadow mb-6">
            <div class="px-4 py-3 border-b border-gray-200">
              <h2 class="text-sm font-semibold text-gray-700">SGLang Metrics Presence (latest per instance)</h2>
            </div>
            <div class="overflow-x-auto">
              <table class="min-w-full divide-y divide-gray-200">
                <thead class="bg-gray-50">
                  <tr>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Instance
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Util</th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Cache Hit
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Grammar
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Prefill Prealloc
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Prefill Inflight
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Decode Prealloc
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Decode Transfer
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Offline Batch
                    </th>
                  </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200">
                  <For each={latestRows()}>
                    {(row) => {
                      return (
                        <tr class="hover:bg-gray-50">
                          <td class="px-4 py-2 whitespace-nowrap text-xs text-gray-600">{row.instanceId}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {formatPresence(row.utilization ?? undefined)}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {formatPresence(row.cacheHitRate ?? undefined)}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {formatPresence(row.numGrammarQueueReqs ?? undefined)}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {formatPresence(row.numPrefillPreallocQueueReqs ?? undefined)}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {formatPresence(row.numPrefillInflightQueueReqs ?? undefined)}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {formatPresence(row.numDecodePreallocQueueReqs ?? undefined)}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {formatPresence(row.numDecodeTransferQueueReqs ?? undefined)}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {formatPresence(row.numRunningReqsOfflineBatch ?? undefined)}
                          </td>
                        </tr>
                      )
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
        </Show>
        <div class="overflow-x-auto bg-white rounded-lg shadow">
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
              <tr>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Instance</th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Prefill TPS
                </th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Gen TPS</th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">RPS</th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Runtime Waiting
                </th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Runtime Running
                </th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  SGLang Util
                </th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Cache Hit %
                </th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  In-flight
                </th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Max In-flight
                </th>
                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Queue Breakdown
                </th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
              <For each={rows()}>
                {(row) => {
                  return (
                    <tr class="hover:bg-gray-50">
                      <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{formatTs(row.ts)}</td>
                      <td class="px-4 py-2 whitespace-nowrap text-xs text-gray-600">{row.instanceId}</td>
                      <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                        {formatNumber(row.prefillTps ?? undefined)}
                      </td>
                      <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                        {formatNumber(row.genTps ?? undefined)}
                      </td>
                      <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                        {formatNumber(row.rps ?? undefined)}
                      </td>
                      <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.numQueueReqs ?? 0}</td>
                      <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.numRunningReqs ?? 0}</td>
                      <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                        {formatPercent(row.utilization ?? undefined)}
                      </td>
                      <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                        {row.cacheHitRate === null || row.cacheHitRate === undefined
                          ? '—'
                          : `${(row.cacheHitRate * 100).toFixed(0)}%`}
                      </td>
                      <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.inFlight ?? 0}</td>
                      <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.maxInFlight ?? 0}</td>
                      <td class="px-4 py-2 text-xs text-gray-600">{formatQueueBreakdown(row)}</td>
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

export const Route = createFileRoute('/admin/llm/')({component: AdminLlm})
