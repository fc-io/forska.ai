import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {For, Show, Suspense} from 'solid-js'

import {apiClient} from '../../../../services/apiClient'
import {fetchSession} from '../../../../services/fetchSession'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse'

type ParquetFileInfo = {key: string; year: string | null; month: string | null; filename: string}

type ParquetStats = {
  totalFiles: number
  totalSizeBytes: number
  bucket: string
  endpoint: string
  files: ParquetFileInfo[]
  partitions: {year: string; month: string; count: number}[]
}

type ParquetStatsResponse = {data: ParquetStats}

const AdminParquet = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const parquetQuery = useQuery(() => {
    return {
      queryKey: ['parquet', 'stats'],
      queryFn: async () => {
        const response = await apiClient.api.parquet.stats.get()
        const result = handleApiResponse<ParquetStatsResponse>(response, 'Failed to load parquet stats')
        return result.data
      },
      staleTime: 1000 * 30,
      refetchOnWindowFocus: true,
    }
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const stats = () => {
    return parquetQuery.data
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
            <h1 class="text-2xl font-bold">Parquet Files</h1>
            <button
              onClick={() => {
                return void parquetQuery.refetch()
              }}
              class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm"
            >
              Refresh
            </button>
          </div>

          <Show when={parquetQuery.isLoading}>
            <p class="text-gray-500">Loading parquet stats…</p>
          </Show>
          <Show when={parquetQuery.isError}>
            <div class="p-4 rounded-md bg-red-50 border border-red-200">
              <p class="text-red-600">Failed to load parquet stats</p>
              <p class="text-sm text-red-500 mt-1">
                Make sure SeaweedFS is running and S3 environment variables are configured.
              </p>
              <button
                onClick={() => {
                  return void parquetQuery.refetch()
                }}
                class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Retry
              </button>
            </div>
          </Show>

          <Show when={!parquetQuery.isLoading && !parquetQuery.isError && stats()}>
            {/* Summary Cards */}
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div class="bg-white rounded-lg shadow p-4">
                <div class="text-sm text-gray-500">Total Parquet Files</div>
                <div class="text-3xl font-bold text-gray-900">{stats()?.totalFiles.toLocaleString()}</div>
              </div>
              <div class="bg-white rounded-lg shadow p-4">
                <div class="text-sm text-gray-500">S3 Bucket</div>
                <div class="text-lg font-semibold text-gray-900">{stats()?.bucket}</div>
              </div>
              <div class="bg-white rounded-lg shadow p-4">
                <div class="text-sm text-gray-500">S3 Endpoint</div>
                <div class="text-lg font-semibold text-gray-900 truncate">{stats()?.endpoint}</div>
              </div>
            </div>

            {/* Partitions Table */}
            <div class="mb-6">
              <h2 class="text-lg font-semibold mb-2">Partitions</h2>
              <Show
                when={(stats()?.partitions.length ?? 0) > 0}
                fallback={
                  <div class="bg-white rounded-lg shadow p-4 text-gray-500">
                    No parquet files found. Run the backfill script to create some.
                  </div>
                }
              >
                <div class="overflow-x-auto bg-white rounded-lg shadow">
                  <table class="min-w-full divide-y divide-gray-200">
                    <thead class="bg-gray-50">
                      <tr>
                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Year
                        </th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Month
                        </th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Files
                        </th>
                      </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-200">
                      <For each={stats()?.partitions}>
                        {(partition) => {
                          return (
                            <tr class="hover:bg-gray-50">
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{partition.year}</td>
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{partition.month}</td>
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900 font-semibold">
                                {partition.count.toLocaleString()}
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

            {/* Recent Files Table */}
            <div>
              <h2 class="text-lg font-semibold mb-2">Recent Files (up to 100)</h2>
              <Show
                when={(stats()?.files.length ?? 0) > 0}
                fallback={<div class="bg-white rounded-lg shadow p-4 text-gray-500">No files found.</div>}
              >
                <div class="overflow-x-auto bg-white rounded-lg shadow max-h-96 overflow-y-auto">
                  <table class="min-w-full divide-y divide-gray-200">
                    <thead class="bg-gray-50 sticky top-0">
                      <tr>
                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Filename
                        </th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Year
                        </th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Month
                        </th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Full Path
                        </th>
                      </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-200">
                      <For each={stats()?.files}>
                        {(file) => {
                          return (
                            <tr class="hover:bg-gray-50">
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900 font-mono">
                                {file.filename}
                              </td>
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{file.year ?? '—'}</td>
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-gray-900">{file.month ?? '—'}</td>
                              <td class="px-4 py-2 whitespace-nowrap text-xs text-gray-500 font-mono">{file.key}</td>
                            </tr>
                          )
                        }}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/parquet/')({component: AdminParquet})
