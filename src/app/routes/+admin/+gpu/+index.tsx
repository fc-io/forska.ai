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

type NvidiaSmiRow = {
  ts: Date | null
  hostname: string
  gpuIndex: number
  gpuUuid: string | null
  gpuName: string | null
  temperatureGpu: number | null
  utilizationGpu: number | null
  utilizationMemory: number | null
  memoryTotalMiB: number | null
  memoryUsedMiB: number | null
  powerDrawWatts: number | null
  powerLimitWatts: number | null
  fanSpeed: number | null
  pstate: string | null
}

const fetchNvidiaSmi = async (): Promise<NvidiaSmiRow[]> => {
  const response = await apiClient.api.nvidiasmi.get()
  if (response.error) throw new Error('Failed to fetch NVIDIA SMI')
  const entries = response.data?.data ?? []
  return entries.map((row: Record<string, unknown>) => {
    return {
      ts: normalizeTimestamp(row.ts),
      hostname: typeof row.hostname === 'string' ? row.hostname : '',
      gpuIndex: typeof row.gpuIndex === 'number' ? row.gpuIndex : 0,
      gpuUuid: (row.gpuUuid as string | null) ?? null,
      gpuName: (row.gpuName as string | null) ?? null,
      temperatureGpu: (row.temperatureGpu as number | null) ?? null,
      utilizationGpu: (row.utilizationGpu as number | null) ?? null,
      utilizationMemory: (row.utilizationMemory as number | null) ?? null,
      memoryTotalMiB: (row.memoryTotalMiB as number | null) ?? null,
      memoryUsedMiB: (row.memoryUsedMiB as number | null) ?? null,
      powerDrawWatts: (row.powerDrawWatts as number | null) ?? null,
      powerLimitWatts: (row.powerLimitWatts as number | null) ?? null,
      fanSpeed: (row.fanSpeed as number | null) ?? null,
      pstate: (row.pstate as string | null) ?? null,
    }
  })
}

const AdminGpu = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const nvidiaSmiQuery = useQuery(() => {
    return {
      queryKey: ['nvidiasmi', 'latest30'],
      queryFn: fetchNvidiaSmi,
      refetchInterval: 10 * 1000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    }
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const rows = () => {
    return nvidiaSmiQuery.data ?? []
  }

  const formatTs = (value: Date | null | undefined) => {
    return !value ? '—' : isValid(value) ? format(value, 'yyyy-MM-dd HH:mm:ss') : '—'
  }

  const formatInt = (value: number | null | undefined) => {
    return value === null || value === undefined ? '—' : `${Math.trunc(value)}`
  }

  const formatPower = (value: number | null | undefined) => {
    return value === null || value === undefined ? '—' : value.toFixed(1)
  }

  const formatMemory = (used: number | null | undefined, total: number | null | undefined) => {
    return used === null || used === undefined || total === null || total === undefined ? '—' : `${used} / ${total}`
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
              <p class="text-gray-500 mb-6">You need administrator privileges to view GPU Metrics.</p>
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
            <h1 class="text-2xl font-bold">GPU Metrics (latest 30)</h1>
          </div>

          <Show when={nvidiaSmiQuery.isLoading}>
            <p class="text-gray-500">Loading GPU Metrics…</p>
          </Show>
          <Show when={nvidiaSmiQuery.isError}>
            <div class="p-4 rounded-md bg-red-50 border border-red-200">
              <p class="text-red-600">Failed to load GPU Metrics</p>
              <button
                onClick={() => {
                  return void nvidiaSmiQuery.refetch()
                }}
                class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Retry
              </button>
            </div>
          </Show>

          <Show when={!nvidiaSmiQuery.isLoading && !nvidiaSmiQuery.isError}>
            <div class="overflow-x-auto bg-white rounded-lg shadow">
              <table class="min-w-full divide-y divide-gray-200">
                <thead class="bg-gray-50">
                  <tr>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Host</th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">GPU</th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Temp</th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Util</th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Mem Util
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      VRAM (MiB)
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Power (W)
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Fan</th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      PState
                    </th>
                  </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200">
                  <For each={rows()}>
                    {(row) => {
                      return (
                        <tr class="hover:bg-gray-50">
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{formatTs(row.ts)}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-xs text-gray-600">{row.hostname}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{formatInt(row.gpuIndex)}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-xs text-gray-600">{row.gpuName ?? '—'}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {row.temperatureGpu === null || row.temperatureGpu === undefined
                              ? '—'
                              : `${row.temperatureGpu}°C`}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {row.utilizationGpu === null || row.utilizationGpu === undefined
                              ? '—'
                              : `${row.utilizationGpu}%`}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {row.utilizationMemory === null || row.utilizationMemory === undefined
                              ? '—'
                              : `${row.utilizationMemory}%`}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {formatMemory(row.memoryUsedMiB ?? undefined, row.memoryTotalMiB ?? undefined)}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {row.powerLimitWatts === null || row.powerLimitWatts === undefined
                              ? formatPower(row.powerDrawWatts ?? undefined)
                              : `${formatPower(row.powerDrawWatts ?? undefined)} / ${formatPower(row.powerLimitWatts ?? undefined)}`}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">
                            {row.fanSpeed === null || row.fanSpeed === undefined ? '—' : `${row.fanSpeed}%`}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.pstate ?? '—'}</td>
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

export const Route = createFileRoute('/admin/gpu/')({component: AdminGpu})
