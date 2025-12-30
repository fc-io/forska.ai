import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createSignal, For, Show, Suspense} from 'solid-js'

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

type DeleteResponse = {data: {deleted: string | string[]; count?: number; message?: string} | null; error?: string}

const AdminParquet = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  // Removed dual-write status query as it's too slow for UI

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

  // Confirmation modal state
  const [deleteModal, setDeleteModal] = createSignal<{
    type: 'file' | 'partition' | 'all' | null
    target?: {key?: string; year?: string; month?: string; count?: number}
  }>({type: null})

  // Delete file mutation
  const deleteFileMutation = createMutation(() => {
    return {
      mutationFn: async (key: string) => {
        const response = await apiClient.api.parquet.file.delete({key})
        return handleApiResponse<DeleteResponse>(response, 'Failed to delete file')
      },
      onSuccess: () => {
        setDeleteModal({type: null})
        void parquetQuery.refetch()
      },
    }
  })

  // Delete partition mutation
  const deletePartitionMutation = createMutation(() => {
    return {
      mutationFn: async ({year, month}: {year: string; month: string}) => {
        const response = await apiClient.api.parquet.partition.delete({year, month})
        return handleApiResponse<DeleteResponse>(response, 'Failed to delete partition')
      },
      onSuccess: () => {
        setDeleteModal({type: null})
        void parquetQuery.refetch()
      },
    }
  })

  // Delete all mutation
  const deleteAllMutation = createMutation(() => {
    return {
      mutationFn: async () => {
        const response = await apiClient.api.parquet.all.delete()
        return handleApiResponse<DeleteResponse>(response, 'Failed to delete all files')
      },
      onSuccess: () => {
        setDeleteModal({type: null})
        void parquetQuery.refetch()
      },
    }
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const stats = () => {
    return parquetQuery.data
  }

  const isDeleting = () => {
    return deleteFileMutation.isPending || deletePartitionMutation.isPending || deleteAllMutation.isPending
  }

  const handleConfirmDelete = () => {
    const modal = deleteModal()
    if (!modal.type) return

    if (modal.type === 'file' && modal.target?.key) {
      deleteFileMutation.mutate(modal.target.key)
    } else if (modal.type === 'partition' && modal.target?.year && modal.target.month) {
      deletePartitionMutation.mutate({year: modal.target.year, month: modal.target.month})
    } else if (modal.type === 'all') {
      deleteAllMutation.mutate()
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      {/* Confirmation Modal */}
      <Show when={deleteModal().type}>
        <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div class="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 class="text-lg font-semibold text-gray-900 mb-2">Confirm Delete</h3>
            <div class="text-gray-600 mb-4">
              <Show when={deleteModal().type === 'file'}>
                <p>Are you sure you want to delete this file?</p>
                <p class="mt-2 font-mono text-sm bg-gray-100 p-2 rounded break-all">{deleteModal().target?.key}</p>
              </Show>
              <Show when={deleteModal().type === 'partition'}>
                <p>
                  Are you sure you want to delete <strong>all files</strong> in this partition?
                </p>
                <p class="mt-2">
                  <span class="font-semibold">
                    Year: {deleteModal().target?.year}, Month: {deleteModal().target?.month}
                  </span>
                </p>
                <p class="mt-1 text-sm text-red-600">This will delete {deleteModal().target?.count} file(s).</p>
              </Show>
              <Show when={deleteModal().type === 'all'}>
                <p class="text-red-600 font-semibold">⚠️ DANGER: This will delete ALL parquet files!</p>
                <p class="mt-2">
                  Total files to delete: <strong>{stats()?.totalFiles}</strong>
                </p>
                <p class="mt-1 text-sm">This action cannot be undone. You will need to run the backfill again.</p>
              </Show>
            </div>
            <div class="flex gap-3 justify-end">
              <button
                onClick={() => {
                  return setDeleteModal({type: null})
                }}
                disabled={isDeleting()}
                class="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={isDeleting()}
                class="px-4 py-2 text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
              >
                <Show when={isDeleting()}>
                  <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle
                      class="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      stroke-width="4"
                      fill="none"
                    />
                    <path
                      class="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                </Show>
                {isDeleting() ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      </Show>

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
            <Show when={(stats()?.totalFiles ?? 0) > 0}>
              <div class="flex gap-2">
                <button
                  onClick={() => {
                    return Promise.all([parquetQuery.refetch()])
                  }}
                  class="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 text-sm flex items-center gap-2"
                >
                  <svg
                    class={`h-4 w-4 ${parquetQuery.isFetching ? 'animate-spin' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  Refresh
                </button>
                <button
                  onClick={() => {
                    return setDeleteModal({type: 'all'})
                  }}
                  class="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 text-sm"
                >
                  Delete All Files
                </button>
              </div>
            </Show>
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
                        <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Actions
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
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-right">
                                <button
                                  onClick={() => {
                                    return setDeleteModal({
                                      type: 'partition',
                                      target: {year: partition.year, month: partition.month, count: partition.count},
                                    })
                                  }}
                                  class="text-red-600 hover:text-red-800 font-medium"
                                >
                                  Delete
                                </button>
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
                        <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Actions
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
                              <td class="px-4 py-2 whitespace-nowrap text-sm text-right">
                                <button
                                  onClick={() => {
                                    return setDeleteModal({type: 'file', target: {key: file.key}})
                                  }}
                                  class="text-red-600 hover:text-red-800 font-medium"
                                >
                                  Delete
                                </button>
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
          </Show>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/parquet/')({component: AdminParquet})
