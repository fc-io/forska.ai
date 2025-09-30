import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {formatDate} from 'date-fns'
import {createSignal, For, Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {fetchSession} from '../../../../services/fetchSession.ts'

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
      ownerId: entry.ownerId,
      ownerName: entry.ownerName ?? null,
      ownerEmail: entry.ownerEmail ?? null,
      accessCount: entry.accessCount ?? 0,
      lastImportAt: entry.lastImportAt ? String(entry.lastImportAt) : null,
      itemsAfterLastImport: entry.itemsAfterLastImport ?? 0,
      importRoute: entry.importRoute ?? null,
    }
  })
}

const formatImportTimestamp = (value: string | null) => {
  return value ? formatDate(new Date(value), 'yyyy-MM-dd HH:mm') : 'Never imported'
}

const AdminDataSources = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

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
  const [selectedFilter, setSelectedFilter] = createSignal<'all' | 'owned' | 'shared'>('all')

  const currentUserId = () => {
    return sessionQuery.data?.user?.id ?? ''
  }

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const dataSources = () => {
    return dataSourcesQuery.data ?? []
  }

  const filteredDataSources = () => {
    const list = dataSources()
    const term = searchTerm().toLowerCase()
    const userId = currentUserId()

    return list.filter((entry) => {
      const matchesSearch =
        term === ''
        || entry.title.toLowerCase().includes(term)
        || (entry.description?.toLowerCase().includes(term) ?? false)
        || (entry.ownerName?.toLowerCase().includes(term) ?? false)

      const matchesFilter =
        selectedFilter() === 'all'
        || (selectedFilter() === 'owned' && entry.ownerId === userId)
        || (selectedFilter() === 'shared' && Number(entry.accessCount) > 1)

      return matchesSearch && matchesFilter
    })
  }

  const ownedCount = () => {
    const userId = currentUserId()
    return dataSources().filter((entry) => {
      return entry.ownerId === userId
    }).length
  }

  const sharedCount = () => {
    return dataSources().filter((entry) => {
      return Number(entry.accessCount) > 1
    }).length
  }

  const totalAccessGrants = () => {
    return dataSources().reduce((sum, entry) => {
      return sum + Number(entry.accessCount)
    }, 0)
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <Show
        when={!sessionQuery.isLoading}
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
              <p class="text-gray-500 mb-6">You need administrator privileges to view data sources.</p>
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
            <h1 class="text-2xl font-bold">Data Sources</h1>
            <button class="px-4 py-2 bg-gray-100 text-gray-400 rounded-md cursor-not-allowed" disabled>
              Add Data Source
            </button>
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
                <div>
                  <select
                    value={selectedFilter()}
                    onChange={(event) => {
                      return setSelectedFilter(event.currentTarget.value as 'all' | 'owned' | 'shared')
                    }}
                    class="px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="all">All Sources</option>
                    <option value="owned">Owned by Me</option>
                    <option value="shared">Shared Access</option>
                  </select>
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
                  <span class="font-semibold text-blue-600">{ownedCount()}</span> owned by you
                </span>
                <span>
                  <span class="font-semibold text-purple-600">{sharedCount()}</span> shared
                </span>
                <span>
                  <span class="font-semibold text-green-600">{totalAccessGrants()}</span> access grants
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
                      <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Title
                      </th>
                      <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Owner
                      </th>
                      <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Created At
                      </th>
                      <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Access Grants
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
                              <div>
                                <div class="font-medium text-gray-900">{entry.ownerName || 'Unknown owner'}</div>
                                <Show when={entry.ownerEmail}>
                                  <div class="text-sm text-gray-500">{entry.ownerEmail}</div>
                                </Show>
                              </div>
                            </td>
                            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {entry.createdAt ? formatDate(new Date(entry.createdAt), 'yyyy-MM-dd') : 'Unknown'}
                            </td>
                            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              <span class="inline-flex items-center px-2 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-medium">
                                {entry.accessCount}
                              </span>
                            </td>
                            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              <div class="space-y-1">
                                <div class="text-sm text-gray-500">
                                  <span class="font-medium text-gray-700">Last Import:</span>{' '}
                                  {formatImportTimestamp(entry.lastImportAt)}
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
                                <Show when={entry.importRoute}>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      alert('importing')
                                    }}
                                    class="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                                  >
                                    New Import
                                  </button>
                                </Show>
                                <Link
                                  to="/admin/datasources/$id/edit"
                                  params={{id: entry.id}}
                                  class="px-3 py-1.5 rounded-md border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                                >
                                  Edit
                                </Link>
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
        </Show>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/datasources/')({component: AdminDataSources})
