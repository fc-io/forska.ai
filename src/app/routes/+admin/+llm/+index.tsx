import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {format, fromUnixTime, isValid, parseISO} from 'date-fns'
import {For, Show, Suspense} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {fetchSession} from '../../../../services/fetchSession.ts'

const normalizeTimestamp = (value: unknown): Date | null => {
  if (value instanceof Date) return isValid(value) ? new Date(value.getTime()) : null
  if (typeof value === 'string') {
    const parsed = parseISO(value)
    return isValid(parsed) ? parsed : null
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const parsed = value > 1_000_000_000_000 ? new Date(value) : fromUnixTime(value)
    return isValid(parsed) ? parsed : null
  }
  return null
}

type LlmStatusRow = {
  ts: Date | null
  instanceId: string
  modelName: string
  engineVersion: string | null
  prefillTps: number | null
  genTps: number | null
  rps: number | null
  numQueueReqs: number | null
  numRunningReqs: number | null
  cacheHitRate: number | null
  inFlight: number | null
  maxInFlight: number | null
}

const fetchLlmStatus = async (): Promise<LlmStatusRow[]> => {
  const response = await apiClient.api.llmstatus.get()
  if (response.error) throw new Error('Failed to fetch LLM status')
  const entries = response.data?.data ?? []
  return entries.map((row: Record<string, unknown>) => {
    return {
      ts: normalizeTimestamp(row.ts),
      instanceId: typeof row.instanceId === 'string' ? row.instanceId : '',
      modelName: typeof row.modelName === 'string' ? row.modelName : '',
      engineVersion: (row.engineVersion as string | null) ?? null,
      prefillTps: (row.prefillTps as number | null) ?? null,
      genTps: (row.genTps as number | null) ?? null,
      rps: (row.rps as number | null) ?? null,
      numQueueReqs: (row.numQueueReqs as number | null) ?? null,
      numRunningReqs: (row.numRunningReqs as number | null) ?? null,
      cacheHitRate: (row.cacheHitRate as number | null) ?? null,
      inFlight: (row.inFlight as number | null) ?? null,
      maxInFlight: (row.maxInFlight as number | null) ?? null,
    }
  })
}

const AdminLlm = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const statusQuery = useQuery(() => {
    return {
      queryKey: ['llmstatus', 'latest30'],
      queryFn: fetchLlmStatus,
      refetchInterval: 2 * 1000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    }
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const rows = () => {
    return statusQuery.data ?? []
  }

  const formatTs = (value: Date | null | undefined) => {
    return !value ? '—' : isValid(value) ? format(value, 'yyyy-MM-dd HH:mm:ss') : '—'
  }

  const formatNumber = (value: number | null | undefined, fractionDigits = 2) => {
    return value === null || value === undefined ? '—' : value.toFixed(fractionDigits)
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <Suspense
        fallback={
          <div class="flex items-center justify-center h-64">
            <div class="flex items-center space-x-2">
              <svg class="animate-spin h-6 w-6 text-blue-600" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
                <path
                  class="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span class="text-gray-600">Checking permissions...</span>
            </div>
          </div>
        }
      >
        <Show
          when={isAdmin()}
          fallback={
            <div class="bg-white border border-gray-200 rounded-lg shadow-sm max-w-xl mx-auto p-10 text-center">
              <h1 class="text-2xl font-semibold text-gray-900 mb-2">Administrator Access Required</h1>
              <p class="text-gray-500 mb-6">You need administrator privileges to view LLM Metrics.</p>
              <Link
                to="/"
                class="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Go back home
              </Link>
            </div>
          }
        >
          <div class="flex justify-between items-center mb-6">
            <h1 class="text-2xl font-bold">LLM Metrics (latest 30)</h1>
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
            <div class="overflow-x-auto bg-white rounded-lg shadow">
              <table class="min-w-full divide-y divide-gray-200">
                <thead class="bg-gray-50">
                  <tr>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Instance
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Prefill TPS
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Gen TPS
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">RPS</th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Waiting
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Running
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
                            {row.cacheHitRate === null || row.cacheHitRate === undefined
                              ? '—'
                              : `${(row.cacheHitRate * 100).toFixed(0)}%`}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.inFlight ?? 0}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.maxInFlight ?? 0}</td>
                        </tr>
                      )
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/llm/')({component: AdminLlm})
