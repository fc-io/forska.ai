import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {For, Show, Suspense} from 'solid-js'
import {format, isValid} from 'date-fns'

import {apiClient} from '../../../../services/apiClient.ts'
import {fetchSession} from '../../../../services/fetchSession.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'

type ModelRow = {
  id: string
  name: string
  provider: string | null
  modelName: string | null
  baseURL: string | null
  workerUrls: string[] | null
  version: string | null
  apiKeyVariable: string | null
  createdAt?: string | Date
}

type ModelsResponse = {data: ModelRow[]}

type GpuInfo = {
  GPU_NNODES: number
  GPU_GPUS_PER_NODE: number
  GPU_SHAPE: string | null | undefined
  GPU_TOTAL_GPUS: number
  TP_SIZE: number
  DP_SIZE: number
  SGLANG_MAX_RUNNING_REQUESTS: number
  WORKER_URLS: string[]
  SGLANG_MODEL: string | null | undefined
}
type GpuInfoResponse = {data: GpuInfo}

type LargestTokenUseRow = {
  id: string
  createdAt?: string | Date | null
  updatedAt?: string | Date | null
  judgmentsJobId?: string | null
  requests: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  duration?: number | null
}
type LargestPerRequestResponse = {data: LargestTokenUseRow[]}

const AdminModels = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const modelsQuery = useQuery(() => {
    return {
      queryKey: ['models', 'admin-list'],
      queryFn: async () => {
        const response = await apiClient.api.models.get()
        const result = handleApiResponse<ModelsResponse>(response, 'Failed to load models')
        return result.data ?? []
      },
      staleTime: 1000 * 60 * 5,
      refetchOnWindowFocus: true,
    }
  })

  const gpuInfoQuery = useQuery(() => {
    return {
      queryKey: ['models', 'gpu-info'],
      queryFn: async () => {
        const response = await apiClient.api.models['gpu-info'].get()
        const result = handleApiResponse<GpuInfoResponse>(response, 'Failed to load GPU info')
        return result.data
      },
      staleTime: 1000 * 30,
      refetchOnWindowFocus: true,
    }
  })

  const largestRequestQuery = useQuery(() => {
    return {
      queryKey: ['tokens', 'largest-per-request'],
      queryFn: async () => {
        const response = await apiClient.api.tokens['largest-per-request'].get()
        const result = handleApiResponse<LargestPerRequestResponse>(
          response,
          'Failed to load largest token per request',
        )
        return result.data ?? []
      },
      staleTime: 1000 * 60 * 5,
      refetchOnWindowFocus: true,
    }
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const rows = () => {
    return modelsQuery.data ?? []
  }

  const formatWorkerUrls = (urls: string[] | null | undefined) => {
    if (!urls || urls.length === 0) {
      return '—'
    }
    return urls.join(', ')
  }

  const formatDate = (value?: string | Date | null) => {
    if (!value) return '—'
    const d = typeof value === 'string' ? new Date(value) : value
    return isValid(d) ? format(d, 'yyyy-MM-dd HH:mm:ss') : '—'
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
            <div class="max-w-xl mx-auto text-center py-12">
              <h2 class="text-xl font-semibold text-gray-900">Unauthorized</h2>
              <p class="mt-2 text-gray-600">You need admin access to view this page.</p>
              <Link to="/" class="mt-4 inline-block text-blue-600 hover:underline">
                Go back home
              </Link>
            </div>
          }
        >
          <div class="flex justify-between items-center mb-6">
            <h1 class="text-2xl font-bold">Models</h1>
          </div>

          <Show when={modelsQuery.isLoading}>
            <p class="text-gray-500">Loading models…</p>
          </Show>
          <Show when={modelsQuery.isError}>
            <div class="p-4 rounded-md bg-red-50 border border-red-200">
              <p class="text-red-600">Failed to load models</p>
              <button
                onClick={() => {
                  return void modelsQuery.refetch()
                }}
                class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Retry
              </button>
            </div>
          </Show>

          <Show when={!modelsQuery.isLoading && !modelsQuery.isError}>
            <div class="overflow-x-auto bg-white rounded-lg shadow">
              <table class="min-w-full divide-y divide-gray-200">
                <thead class="bg-gray-50">
                  <tr>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Provider
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Model
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Base URL
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Worker URLs
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Version
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      API Key Var
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ID</th>
                  </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200">
                  <For each={rows()}>
                    {(m) => {
                      return (
                        <tr class="hover:bg-gray-50">
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{m.name}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{m.provider ?? '—'}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{m.modelName ?? '—'}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{m.baseURL ?? '—'}</td>
                          <td class="px-4 py-2 whitespace-pre-wrap text-sm text-gray-900 max-w-xs break-words">
                            {formatWorkerUrls(m.workerUrls)}
                          </td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{m.version ?? '—'}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{m.apiKeyVariable ?? '—'}</td>
                          <td class="px-4 py-2 whitespace-nowrap text-xs text-gray-500">{m.id}</td>
                        </tr>
                      )
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>

          <div class="mt-6">
            <h2 class="text-lg font-semibold mb-2">Top 5 Largest Tokens per Request</h2>
            <Show when={largestRequestQuery.isLoading}>
              <p class="text-gray-500">Loading…</p>
            </Show>
            <Show when={largestRequestQuery.isError}>
              <div class="p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
                Failed to load largest token per request
              </div>
            </Show>
            <Show when={!largestRequestQuery.isLoading && !largestRequestQuery.isError}>
              <div class="overflow-x-auto bg-white rounded-lg shadow">
                <table class="min-w-full divide-y divide-gray-200">
                  <thead class="bg-gray-50">
                    <tr>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ID</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Updated</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Judgments Job ID</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Requests</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Prompt</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Completion</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Total</th>
                      <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Duration (ms)</th>
                    </tr>
                  </thead>
                  <tbody class="bg-white divide-y divide-gray-200">
                    <Show
                      when={(largestRequestQuery.data?.length ?? 0) > 0}
                      fallback={<tr><td class="px-4 py-2 text-sm text-gray-600" colspan="9">No data</td></tr>}
                    >
                      <For each={largestRequestQuery.data}>
                        {(row) => {
                          return (
                            <tr class="hover:bg-gray-50">
                              <td class="px-4 py-2 whitespace-nowrap text-xs text-gray-500 break-all">{row.id}</td>
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{formatDate(row.createdAt)}</td>
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{formatDate(row.updatedAt)}</td>
                              <td class="px-4 py-2 whitespace-pre-wrap text-sm text-gray-900 break-words">{row.judgmentsJobId ?? '—'}</td>
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.requests}</td>
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.totalPromptTokens}</td>
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.totalCompletionTokens}</td>
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900 font-semibold">{row.totalTokens}</td>
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{row.duration ?? '—'}</td>
                            </tr>
                          )
                        }}
                      </For>
                    </Show>
                  </tbody>
                </table>
              </div>
            </Show>
          </div>

          {/* GPU / Engine Info (moved below table) */}
          <div class="mt-6">
            <h2 class="text-lg font-semibold mb-2">GPU / Engine Info</h2>
            <Show when={gpuInfoQuery.isLoading}>
              <p class="text-gray-500">Loading GPU info…</p>
            </Show>
            <Show when={gpuInfoQuery.isError}>
              <div class="p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700">
                Failed to load GPU info
              </div>
            </Show>
            <Show when={!gpuInfoQuery.isLoading && !gpuInfoQuery.isError && gpuInfoQuery.data}>
              <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 bg-white rounded-lg shadow p-4">
                <div>
                  <div class="text-xs text-gray-500">Nodes</div>
                  <div class="text-sm text-gray-900">{gpuInfoQuery.data?.GPU_NNODES}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500">GPUs per node</div>
                  <div class="text-sm text-gray-900">{gpuInfoQuery.data?.GPU_GPUS_PER_NODE}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500">Total GPUs</div>
                  <div class="text-sm text-gray-900">{gpuInfoQuery.data?.GPU_TOTAL_GPUS}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500">Shape</div>
                  <div class="text-sm text-gray-900">{gpuInfoQuery.data?.GPU_SHAPE ?? '—'}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500">TP size</div>
                  <div class="text-sm text-gray-900">{gpuInfoQuery.data?.TP_SIZE}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500">DP size</div>
                  <div class="text-sm text-gray-900">{gpuInfoQuery.data?.DP_SIZE}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500">SGLANG max running requests</div>
                  <div class="text-sm text-gray-900">{gpuInfoQuery.data?.SGLANG_MAX_RUNNING_REQUESTS}</div>
                </div>
                <div class="md:col-span-2 xl:col-span-3">
                  <div class="text-xs text-gray-500">Worker URLs</div>
                  <div class="text-sm text-gray-900 whitespace-pre-wrap break-words">
                    {gpuInfoQuery.data?.WORKER_URLS?.length ? gpuInfoQuery.data?.WORKER_URLS.join(', ') : '—'}
                  </div>
                </div>
                <div class="xl:col-span-3">
                  <div class="text-xs text-gray-500">Running SGLANG model</div>
                  <div class="text-sm text-gray-900">{gpuInfoQuery.data?.SGLANG_MODEL ?? '—'}</div>
                </div>
              </div>
            </Show>
          </div>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/models/')({component: AdminModels})
