import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {formatDate} from 'date-fns'
import {createSignal, For, Show} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {apiClient} from '../../../../services/apiClient.ts'

const fetchDataSources = async () => {
  const response = await apiClient.api.datasources.get()

  if (response.error) {
    console.error('Error fetching data sources:', response.error)
    throw new Error('Failed to fetch data sources')
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
    }
  })
}

const formatImportTimestamp = (value: string | null) => {
  return value ? formatDate(new Date(value), 'yyyy-MM-dd HH:mm') : 'Never imported'
}

const archiveDataSource = async (id: string) => {
  const response = await apiClient.api.datasources({id}).delete()
  if (response.error) {
    throw new Error('Failed to archive data source')
  }
  return response.data
}

const AdminDataSources = () => {
  const queryClient = useQueryClient()

  const dataSourcesQuery = useQuery(() => {
    return {
      queryKey: ['datasources'],
      queryFn: fetchDataSources,
      refetchInterval: 30 * 1000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    }
  })

  const [searchTerm, setSearchTerm] = createSignal('')
  const [pendingArchiveId, setPendingArchiveId] = createSignal<string | null>(null)

  const dataSources = () => {
    return dataSourcesQuery.data ?? []
  }

  const filteredDataSources = () => {
    const list = dataSources()
    const term = searchTerm().toLowerCase()

    return list
      .filter((entry) => {
        const matchesSearch =
          term === ''
          || entry.title.toLowerCase().includes(term)
          || (entry.description?.toLowerCase().includes(term) ?? false)

        return matchesSearch
      })
      .sort((a, b) => {
        return a.title.localeCompare(b.title)
      })
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">Data Sources</h1>
        <div class="flex gap-2">
          <Button as={Link} to="/admin/datasources/archived" variant="outline" size="sm">
            Archived
          </Button>
          <Link
            to="/admin/datasources/create"
            class="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Add Data Source
          </Link>
        </div>
      </div>

      <div class="space-y-4">
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div class="flex gap-4 items-center">
            <div class="flex-1">
              <input
                type="text"
                placeholder="Search data sources..."
                value={searchTerm()}
                onInput={(event) => {
                  return setSearchTerm(event.currentTarget.value)
                }}
                class="w-full px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        <Show when={dataSourcesQuery.isLoading}>
          <p class="text-muted-foreground">Loading data sources...</p>
        </Show>

        <Show when={dataSourcesQuery.isError}>
          <div class="p-4 rounded-md bg-red-50 border border-red-200">
            <p class="text-red-600">Failed to load data sources</p>
            <button
              onClick={() => {
                return void dataSourcesQuery.refetch()
              }}
              class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Retry
            </button>
          </div>
        </Show>

        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div class="flex gap-6 text-sm text-gray-600">
            <span>
              <span class="font-semibold text-gray-900">{dataSources().length}</span> total
            </span>
            <span>
              <span class="font-semibold text-blue-600">{filteredDataSources().length}</span> shown
            </span>
          </div>
        </div>

        <Show when={!dataSourcesQuery.isLoading && !dataSourcesQuery.isError && filteredDataSources().length === 0}>
          <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
            <h3 class="text-lg font-medium text-gray-900 mb-2">No data sources found</h3>
            <p class="text-sm text-gray-500">Try adjusting your filters or creating a new data source.</p>
          </div>
        </Show>

        <Show when={filteredDataSources().length > 0}>
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
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <For each={filteredDataSources()}>
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
                              {entry.dateFrom
                                ? formatDate(new Date(entry.dateFrom), 'yyyy-MM-dd HH:mm xxx')
                                : 'Not set'}
                            </div>
                            <div class="text-sm text-gray-500">
                              <span class="font-medium text-gray-700">Date To:</span>{' '}
                              {entry.dateTo ? formatDate(new Date(entry.dateTo), 'yyyy-MM-dd HH:mm xxx') : 'Not set'}
                            </div>
                            <div class="text-sm text-gray-500">
                              <span class="font-medium text-gray-700">Items After Import:</span>{' '}
                              {entry.itemsAfterLastImport.toLocaleString()}
                            </div>
                            <div class="text-sm text-gray-500">
                              <span class="font-medium text-gray-700">Route:</span>{' '}
                              <span class="font-mono">{entry.importRoute ?? 'Not configured'}</span>
                            </div>
                          </div>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          <div class="flex items-center gap-3">
                            <Link
                              to="/admin/datasources/$id/edit"
                              params={{id: entry.id}}
                              class="px-3 py-1.5 rounded-md border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                            >
                              Edit
                            </Link>
                            <Show when={entry.importRoute}>
                              <button
                                type="button"
                                onClick={() => {
                                  if (entry.importRoute?.startsWith('fhir:')) {
                                    void apiClient.api.datasources.import['fhir-ehr-patients']
                                      .post({id: entry.id})
                                      .then((response) => {
                                        if (response.error || !response.data?.success) {
                                          console.error('Failed to start import', response.error)
                                          alert('Failed to start import')
                                          return
                                        }
                                        void dataSourcesQuery.refetch()
                                      })
                                    return
                                  }
                                  if (entry.importRoute === '/api/datasources/import/arxiv') {
                                    void apiClient.api.datasources.import.arxiv
                                      .post({id: entry.id})
                                      .then((response) => {
                                        if (response.error || !response.data?.success) {
                                          console.error('Failed to start import', response.error)
                                          alert('Failed to start import')
                                          return
                                        }
                                        void dataSourcesQuery.refetch()
                                      })
                                    return
                                  }
                                  if (entry.importRoute === '/api/datasources/import/biorxiv') {
                                    void apiClient.api.datasources.import.biorxiv
                                      .post({id: entry.id})
                                      .then((response) => {
                                        if (response.error || !response.data?.success) {
                                          console.error('Failed to start import', response.error)
                                          alert('Failed to start import')
                                          return
                                        }
                                        void dataSourcesQuery.refetch()
                                      })
                                    return
                                  }
                                  if (entry.importRoute === '/api/datasources/import/medrxiv') {
                                    void apiClient.api.datasources.import.medrxiv
                                      .post({id: entry.id})
                                      .then((response) => {
                                        if (response.error || !response.data?.success) {
                                          console.error('Failed to start import', response.error)
                                          alert('Failed to start import')
                                          return
                                        }
                                        void dataSourcesQuery.refetch()
                                      })
                                    return
                                  }
                                  if (entry.importRoute === '/api/datasources/import/pubmed') {
                                    void apiClient.api.datasources.import.pubmed
                                      .post({id: entry.id})
                                      .then((response) => {
                                        if (response.error || !response.data?.success) {
                                          console.error('Failed to start import', response.error)
                                          alert('Failed to start import')
                                          return
                                        }
                                        void dataSourcesQuery.refetch()
                                      })
                                    return
                                  }
                                  if (entry.importRoute === '/api/datasources/import/europe-pmc-ppr') {
                                    void apiClient.api.datasources.import['europe-pmc-ppr']
                                      .post({id: entry.id})
                                      .then((response) => {
                                        if (response.error || !response.data?.success) {
                                          console.error('Failed to start import', response.error)
                                          alert('Failed to start import')
                                          return
                                        }
                                        void dataSourcesQuery.refetch()
                                      })
                                    return
                                  }
                                  alert(`Unknown import route: ${entry.importRoute}`)
                                }}
                                class="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                              >
                                New Import
                              </button>
                            </Show>
                            <button
                              type="button"
                              disabled={pendingArchiveId() === entry.id}
                              onClick={() => {
                                if (!confirm('Archive this data source?')) {
                                  return
                                }
                                setPendingArchiveId(entry.id)
                                void archiveDataSource(entry.id).then(
                                  () => {
                                    setPendingArchiveId(null)
                                    void queryClient.invalidateQueries({queryKey: ['datasources']})
                                  },
                                  (error) => {
                                    console.error('Failed to archive data source', error)
                                    setPendingArchiveId(null)
                                    alert('Failed to archive data source')
                                  },
                                )
                              }}
                              class="px-3 py-1.5 rounded-md border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:opacity-50"
                            >
                              {pendingArchiveId() === entry.id ? 'Archiving...' : 'Archive'}
                            </button>
                          </div>
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
    </div>
  )
}

export const Route = createFileRoute('/admin/datasources/')({component: AdminDataSources})
