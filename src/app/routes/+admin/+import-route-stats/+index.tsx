import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createMemo, For, Show, Suspense} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'

type ImportRouteYearCount = {year: number; count: number}

type ImportRouteStats = {
  importRoute: string | null
  importRouteName: string | null
  total: number
  years: ImportRouteYearCount[]
}

const formatImportRoute = (value: string | null): string => {
  const trimmed = value?.trim() ?? ''
  return trimmed ? trimmed : '(none)'
}

const formatCount = (value: number | null | undefined): string => {
  return value === null || value === undefined ? '0' : value.toLocaleString()
}

const fetchImportRouteStats = async (): Promise<ImportRouteStats[]> => {
  const response = await apiClient.api.admin['import-route-stats'].get()
  if (response.error) throw new Error('Failed to fetch import route stats')
  if (!response.data) throw new Error('Failed to fetch import route stats')
  return response.data.data
}

const AdminImportRouteStats = () => {
  const statsQuery = useQuery(() => {
    return {
      queryKey: ['admin', 'import-route-stats'],
      queryFn: fetchImportRouteStats,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 0,
    }
  })

  const routeStats = createMemo(() => {
    return statsQuery.data ?? []
  })

  const totalArticles = createMemo(() => {
    return (statsQuery.data ?? []).reduce((sum, row) => {
      return sum + row.total
    }, 0)
  })

  return (
    <div class="min-h-screen bg-gray-50 py-6">
      <div class="max-w-6xl mx-auto px-6">
        <div class="mb-6 flex items-start justify-between gap-4">
          <div class="flex flex-col gap-1">
            <h1 class="text-2xl font-bold text-gray-900">Articles by Import Route</h1>
            <div class="text-sm text-gray-600">
              Counts are grouped by year from article date (fallback: import date).
            </div>
          </div>
          <div class="text-sm text-gray-700">
            Total articles: <span class="font-semibold text-gray-900">{formatCount(totalArticles())}</span>
          </div>
        </div>

        <Suspense
          fallback={
            <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
              <div class="h-5 w-48 animate-pulse rounded bg-gray-200" />
              <div class="mt-4 h-4 w-80 animate-pulse rounded bg-gray-200" />
            </div>
          }
        >
          <Show when={statsQuery.isLoading}>
            <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
              <div class="h-5 w-48 animate-pulse rounded bg-gray-200" />
              <div class="mt-4 h-4 w-80 animate-pulse rounded bg-gray-200" />
            </div>
          </Show>

          <Show when={statsQuery.isError}>
            <div class="rounded-md border border-red-200 bg-red-50 p-4">
              <div class="text-red-700">Failed to load import route stats.</div>
              <button
                class="mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                onClick={() => {
                  return void statsQuery.refetch()
                }}
              >
                Retry
              </button>
            </div>
          </Show>

          <Show when={!statsQuery.isLoading && !statsQuery.isError}>
            <div class="flex flex-col gap-4">
              <For each={routeStats()}>
                {(row) => {
                  const routeText = formatImportRoute(row.importRoute)
                  const name = row.importRouteName?.trim() ?? ''
                  const displayName = name ? name : routeText
                  const showRouteHint = Boolean(name) && name !== routeText
                  return (
                    <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
                      <div class="border-b border-gray-200 bg-gray-50 px-4 py-3">
                        <div class="text-sm font-semibold text-gray-900">{displayName}</div>
                        <Show when={showRouteHint}>
                          <div class="text-xs text-gray-600 font-mono break-all">{routeText}</div>
                        </Show>
                      </div>

                      <table class="min-w-full divide-y divide-gray-200">
                        <thead class="bg-white">
                          <tr>
                            <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                              Year
                            </th>
                            <th class="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                              Count
                            </th>
                          </tr>
                        </thead>
                        <tbody class="divide-y divide-gray-100">
                          <For each={row.years}>
                            {(yearRow) => {
                              return (
                                <tr>
                                  <td class="px-4 py-2 text-sm text-gray-700">
                                    <Link
                                      to="/admin/import-route-stats/$year"
                                      params={{year: String(yearRow.year)}}
                                      class="text-blue-600 hover:text-blue-800 hover:underline"
                                    >
                                      {yearRow.year}
                                    </Link>
                                  </td>
                                  <td class="px-4 py-2 text-right text-sm text-gray-900">
                                    {formatCount(yearRow.count)}
                                  </td>
                                </tr>
                              )
                            }}
                          </For>
                          <tr class="bg-gray-50">
                            <td class="px-4 py-2 text-sm font-medium text-gray-700">Total</td>
                            <td class="px-4 py-2 text-right text-sm font-semibold text-gray-900">
                              {formatCount(row.total)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        </Suspense>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/import-route-stats/')({component: AdminImportRouteStats})
