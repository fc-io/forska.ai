import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {formatDate} from 'date-fns'
import {createSignal, For, Show} from 'solid-js'

import {Button} from '../../../../../components/ui/button'
import {apiClient} from '../../../../../services/apiClient.ts'

type StructuredFileConfig = {
  assetPath: string
  boundaryDisplayPath: string
  boundaryPointer: string
  format: 'json' | 'xml'
  sourceFileName: string
}

const formatImportTimestamp = (value: string | null) => {
  return value ? formatDate(new Date(value), 'yyyy-MM-dd HH:mm') : 'Never imported'
}

const fetchArchivedDataSources = async () => {
  const response = await apiClient.api.datasources.archived.get()

  if (response.error) {
    console.error('Error fetching archived data sources:', response.error)
    throw new Error('Failed to fetch archived data sources')
  }

  const entries = response.data?.data ?? []

  return entries.map((entry) => {
    return {
      id: entry.id,
      title: entry.title,
      description: entry.description ?? null,
      createdAt: String(entry.createdAt),
      updatedAt: String(entry.updatedAt),
      dateFrom: entry.dateFrom ? String(entry.dateFrom) : null,
      dateTo: entry.dateTo ? String(entry.dateTo) : null,
      lastImportAt: entry.lastImportAt ? String(entry.lastImportAt) : null,
      itemsAfterLastImport: entry.itemsAfterLastImport ?? 0,
      importRoute: entry.importRoute ?? null,
      structuredFileConfig: (entry.structuredFileConfig ?? null) as StructuredFileConfig | null,
    }
  })
}

const restoreDataSource = async (id: string) => {
  const response = await apiClient.api.datasources({id}).patch({archived: false})
  if (response.error) {
    throw new Error('Failed to restore data source')
  }
  return response.data
}

const ArchivedDataSources = () => {
  const queryClient = useQueryClient()
  const archivedQuery = useQuery(() => {
    return {queryKey: ['datasources', 'archived'], queryFn: fetchArchivedDataSources}
  })
  const [pendingRestoreId, setPendingRestoreId] = createSignal<string | null>(null)

  const archivedDataSources = () => {
    return archivedQuery.data ?? []
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <div class="flex items-center gap-4">
          <Button as={Link} to="/admin/datasources" variant="outline" size="sm">
            ← Back to Data Sources
          </Button>
          <h1 class="text-2xl font-bold">Archived Data Sources</h1>
        </div>
      </div>

      <Show when={archivedQuery.isLoading}>
        <p class="text-muted-foreground">Loading archived data sources...</p>
      </Show>

      <Show when={archivedQuery.isError}>
        <div class="p-4 rounded-md bg-red-50 border border-red-200">
          <p class="text-red-600">Failed to load archived data sources</p>
          <button
            onClick={() => {
              return void archivedQuery.refetch()
            }}
            class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </Show>

      <Show when={!archivedQuery.isLoading && !archivedQuery.isError && archivedDataSources().length === 0}>
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <h3 class="text-lg font-medium text-gray-900 mb-2">No archived data sources</h3>
          <p class="text-sm text-gray-500">Data sources you archive will appear here.</p>
        </div>
      </Show>

      <Show when={archivedDataSources().length > 0}>
        <div class="overflow-x-auto bg-white rounded-lg shadow">
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
              <tr>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Title</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Created At
                </th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Import Details
                </th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
              <For each={archivedDataSources()}>
                {(entry) => {
                  return (
                    <tr class="hover:bg-gray-50">
                      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        <div>
                          <div class="font-medium text-gray-900">{entry.title}</div>
                          <Show when={entry.description}>
                            <div class="text-sm text-gray-500">{entry.description}</div>
                          </Show>
                        </div>
                      </td>
                      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {entry.createdAt ? formatDate(new Date(entry.createdAt), 'yyyy-MM-dd') : 'Unknown'}
                      </td>
                      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        <div class="space-y-1">
                          <div class="text-sm text-gray-500">
                            <span class="font-medium text-gray-700">Last Import:</span>{' '}
                            {formatImportTimestamp(entry.lastImportAt)}
                          </div>
                          <div class="text-sm text-gray-500">
                            <span class="font-medium text-gray-700">Date From:</span>{' '}
                            {entry.dateFrom ? formatDate(new Date(entry.dateFrom), 'yyyy-MM-dd HH:mm xxx') : 'Not set'}
                          </div>
                          <div class="text-sm text-gray-500">
                            <span class="font-medium text-gray-700">Date To:</span>{' '}
                            {entry.dateTo ? formatDate(new Date(entry.dateTo), 'yyyy-MM-dd HH:mm xxx') : 'Not set'}
                          </div>
                          <div class="text-sm text-gray-500">
                            <span class="font-medium text-gray-700">Items After Import:</span>{' '}
                            {entry.itemsAfterLastImport.toLocaleString()}
                          </div>
                          <Show when={!entry.structuredFileConfig}>
                            <div class="text-sm text-gray-500">
                              <span class="font-medium text-gray-700">Route:</span>{' '}
                              <span class="font-mono">{entry.importRoute ?? 'Not configured'}</span>
                            </div>
                          </Show>
                        </div>
                      </td>
                      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        <button
                          type="button"
                          disabled={pendingRestoreId() === entry.id}
                          onClick={() => {
                            if (!confirm('Restore this data source?')) {
                              return
                            }
                            setPendingRestoreId(entry.id)
                            void restoreDataSource(entry.id).then(
                              () => {
                                setPendingRestoreId(null)
                                void queryClient.invalidateQueries({queryKey: ['datasources']})
                                void queryClient.invalidateQueries({queryKey: ['datasources', 'archived']})
                              },
                              (error) => {
                                console.error('Failed to restore data source', error)
                                setPendingRestoreId(null)
                                alert('Failed to restore data source')
                              },
                            )
                          }}
                          class="px-3 py-1.5 rounded-md border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:opacity-50"
                        >
                          {pendingRestoreId() === entry.id ? 'Restoring...' : 'Restore'}
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
  )
}

export const Route = createFileRoute('/admin/datasources/archived/')({component: ArchivedDataSources})
