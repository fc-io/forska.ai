import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {For, Show, Suspense} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {fetchSession} from '../../../../services/fetchSession.ts'

type VllmStatusRow = {
  ts: string
  instanceId: string
  modelName: string
  vllmVersion: string | null
  gpuType: string | null
  gpuCount: number | null
  prefillTps: number | null
  genTps: number | null
  impliedRps: number | null
  numRequestsWaiting: number | null
  numRequestsRunning: number | null
  numRequestsSwapped: number | null
  gpuCacheUsagePerc: number | null
  inFlight: number | null
  maxInFlight: number | null
  lastAction: string | null
}

const fetchVllmStatus = async (): Promise<VllmStatusRow[]> => {
  const response = await apiClient.api.vllmstatus.get()
  if (response.error) {
    console.error('Error fetching vLLM status:', response.error)
    throw new Error('Failed to fetch vLLM status')
  }
  const entries = response.data?.data ?? []
  return entries.map((row: Record<string, unknown>) => {
    return {
      ts: typeof row.ts === 'string' ? row.ts : '',
      instanceId: typeof row.instanceId === 'string' ? row.instanceId : '',
      modelName: typeof row.modelName === 'string' ? row.modelName : '',
      vllmVersion: (row.vllmVersion as string | null) ?? null,
      gpuType: (row.gpuType as string | null) ?? null,
      gpuCount: (row.gpuCount as number | null) ?? null,
      prefillTps: (row.prefillTps as number | null) ?? null,
      genTps: (row.genTps as number | null) ?? null,
      impliedRps: (row.impliedRps as number | null) ?? null,
      numRequestsWaiting: (row.numRequestsWaiting as number | null) ?? null,
      numRequestsRunning: (row.numRequestsRunning as number | null) ?? null,
      numRequestsSwapped: (row.numRequestsSwapped as number | null) ?? null,
      gpuCacheUsagePerc: (row.gpuCacheUsagePerc as number | null) ?? null,
      inFlight: (row.inFlight as number | null) ?? null,
      maxInFlight: (row.maxInFlight as number | null) ?? null,
      lastAction: (row.lastAction as string | null) ?? null,
    }
  })
}

const AdminVllm = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const statusQuery = useQuery(() => {
    return {
      queryKey: ['vllmstatus', 'latest30'],
      queryFn: fetchVllmStatus,
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

  const formatTs = (value: Date | string | null | undefined) => {
    if (!value) {
      return '—'
    }
    const d = typeof value === 'string' ? new Date(value) : value
    return Number.isNaN(d.getTime()) ? '—' : format(d, 'yyyy-MM-dd HH:mm:ss')
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
              <p class="text-gray-500 mb-6">You need administrator privileges to view vLLM status.</p>
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
            <h1 class="text-2xl font-bold">vLLM Status (latest 30)</h1>
          </div>

          <Show when={statusQuery.isLoading}>
            <p class="text-gray-500">Loading vLLM status…</p>
          </Show>
          <Show when={statusQuery.isError}>
            <div class="p-4 rounded-md bg-red-50 border border-red-200">
              <p class="text-red-600">Failed to load vLLM status</p>
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
                    {/* <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Instance
                    </th> */}
                    {/* <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Model
                    </th> */}
                    {/* <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">vLLM</th> */}
                    {/* <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">GPU</th> */}
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Prefill TPS
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Gen TPS
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Implied RPS
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Waiting
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Running
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Swapped
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      GPU Cache %
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      In-flight
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Max In-flight
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Last Action
                    </th>
                  </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200">
                  <For each={rows()}>
                    {(row) => {
                      return (
                        <tr class="hover:bg-gray-50">
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{formatTs(row.ts)}</td>
                          {/* <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.instanceId}</td> */}
                          {/* <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.modelName}</td> */}
                          {/* <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.vllmVersion ?? '—'}</td> */}
                          {/* <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {row.gpuType ?? '—'}
                            <span class="text-gray-400">{row.gpuCount ? `×${row.gpuCount}` : ''}</span>
                          </td> */}
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {formatNumber(row.prefillTps ?? undefined)}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {formatNumber(row.genTps ?? undefined)}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {formatNumber(row.impliedRps ?? undefined)}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {row.numRequestsWaiting ?? 0}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {row.numRequestsRunning ?? 0}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {row.numRequestsSwapped ?? 0}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {row.gpuCacheUsagePerc === null || row.gpuCacheUsagePerc === undefined
                              ? '—'
                              : `${(row.gpuCacheUsagePerc * 100).toFixed(0)}%`}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.inFlight ?? 0}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.maxInFlight ?? 0}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.lastAction ?? '—'}</td>
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

export const Route = createFileRoute('/admin/vllm/')({component: AdminVllm})
