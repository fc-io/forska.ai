import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {For, Show, Suspense} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {fetchSession} from '../../../../services/fetchSession.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'

const fetchConversionStats = async () => {
  const response = await apiClient.api.articles['conversion-stats'].get()
  return handleApiResponse(response, 'Failed to load conversion stats')
}

type ConversionStats = Awaited<ReturnType<typeof fetchConversionStats>>
type ConversionStatusRow = ConversionStats['byStatus'][number]

const getStatusBadgeClass = (status: string) => {
  switch (status) {
    case 'success':
      return 'bg-green-100 text-green-800'
    case 'failed':
      return 'bg-red-100 text-red-800'
    case 'pending':
      return 'bg-yellow-100 text-yellow-800'
    case 'not_started':
      return 'bg-gray-100 text-gray-800'
    default:
      return 'bg-gray-100 text-gray-800'
  }
}

const formatStatusLabel = (status: string) => {
  return status
    .split(/[-_]/)
    .filter((part) => {
      return part.length > 0
    })
    .map((part) => {
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

const getStatusCount = (rows: ConversionStatusRow[] | undefined, status: string) => {
  return rows?.find((row) => row.status === status)?.count ?? 0
}

const sortStatusRows = (rows: ConversionStatusRow[]) => {
  return [...rows].sort((a, b) => {
    return b.count !== a.count ? b.count - a.count : a.status.localeCompare(b.status)
  })
}

const formatCount = (value: number) => {
  return value.toLocaleString('en-US')
}

const AdminPdfConversions = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const statsQuery = useQuery(() => {
    return {
      queryKey: ['articles', 'conversion-stats'],
      queryFn: fetchConversionStats,
      staleTime: 1000 * 30,
      refetchOnWindowFocus: true,
    }
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const rows = () => {
    return statsQuery.data?.byStatus ?? []
  }

  const sortedRows = () => {
    return sortStatusRows(rows())
  }

  const total = () => {
    return statsQuery.data?.total ?? 0
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
            <h1 class="text-2xl font-bold">PDF → MD/HTML Conversions</h1>
          </div>

          <Show when={statsQuery.isLoading}>
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
              <p class="text-gray-500 text-center">Loading conversion stats...</p>
            </div>
          </Show>

          <Show when={statsQuery.isError}>
            <div class="p-4 rounded-md bg-red-50 border border-red-200">
              <p class="text-red-600">Failed to load conversion stats</p>
              <button
                onClick={() => {
                  return void statsQuery.refetch()
                }}
                class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Retry
              </button>
            </div>
          </Show>

          <Show when={!statsQuery.isLoading && !statsQuery.isError}>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                <div class="text-sm text-gray-500">Total PDFs</div>
                <div class="mt-1 text-2xl font-bold text-gray-900">{formatCount(total())}</div>
              </div>
              <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                <div class="text-sm text-gray-500">Success</div>
                <div class="mt-1 text-2xl font-bold text-green-700">{formatCount(getStatusCount(rows(), 'success'))}</div>
              </div>
              <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                <div class="text-sm text-gray-500">Pending</div>
                <div class="mt-1 text-2xl font-bold text-yellow-700">
                  {formatCount(getStatusCount(rows(), 'pending'))}
                </div>
              </div>
              <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                <div class="text-sm text-gray-500">Failed</div>
                <div class="mt-1 text-2xl font-bold text-red-700">{formatCount(getStatusCount(rows(), 'failed'))}</div>
              </div>
            </div>

            <div class="overflow-x-auto bg-white rounded-lg shadow">
              <table class="min-w-full divide-y divide-gray-200">
                <thead class="bg-gray-50">
                  <tr>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Count
                    </th>
                  </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200">
                  <For each={sortedRows()}>
                    {(row) => {
                      return (
                        <tr class="hover:bg-gray-50">
                          <td class="px-6 py-4">
                            <span class={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusBadgeClass(row.status)}`}>
                              {formatStatusLabel(row.status)}
                            </span>
                          </td>
                          <td class="px-6 py-4 text-right text-sm text-gray-700 tabular-nums">
                            {formatCount(row.count)}
                          </td>
                        </tr>
                      )
                    }}
                  </For>
                  <Show when={sortedRows().length === 0}>
                    <tr>
                      <td colspan="2" class="px-6 py-8 text-center text-gray-500">
                        No conversion data found
                      </td>
                    </tr>
                  </Show>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/pdf-conversions/')({component: AdminPdfConversions})

