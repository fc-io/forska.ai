import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createMemo, For, Show, Suspense} from 'solid-js'

import {apiClient} from '../../../../../services/apiClient.ts'

const formatCount = (value: number | null | undefined): string => {
  return value === null || value === undefined ? '0' : value.toLocaleString()
}

const parseYear = (value: string): string => {
  const parsed = parseInt(value, 10)
  const ok = Number.isFinite(parsed) && parsed >= 1800 && parsed <= 3000
  return ok ? String(parsed) : '0'
}

const formatArticleDate = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : format(date, 'yyyy-MM-dd')
}

const fetchYearArticles = async (year: string) => {
  const response = await apiClient.api.admin['import-route-stats']['year-articles'].get({query: {year}})
  if (response.error) throw new Error('Failed to fetch year articles')
  if (!response.data) throw new Error('Failed to fetch year articles')
  return response.data.data
}

const AdminImportRouteStatsYear = () => {
  const params = Route.useParams()

  const year = createMemo(() => {
    return parseYear(params().year)
  })

  const yearArticlesQuery = useQuery(() => {
    return {
      queryKey: ['admin', 'import-route-stats', 'year-articles', year()],
      queryFn: () => {
        return fetchYearArticles(year())
      },
      enabled: year() !== '0',
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 0,
    }
  })

  const articles = createMemo(() => {
    return yearArticlesQuery.data?.articles ?? []
  })

  const total = createMemo(() => {
    return yearArticlesQuery.data?.total ?? 0
  })

  const fallbackTotal = createMemo(() => {
    return yearArticlesQuery.data?.fallbackTotal ?? 0
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="max-w-6xl mx-auto space-y-6">
        <div class="flex items-start justify-between gap-4">
          <div class="flex flex-col gap-2">
            <Link
              to="/admin/import-route-stats"
              class="text-blue-600 hover:text-blue-800 text-sm flex items-center gap-1"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to Import Route Stats
            </Link>
            <div>
              <h1 class="text-2xl font-bold text-gray-900">Articles in {year()}</h1>
              <div class="text-sm text-gray-600">Showing the first 200 by article date (fallback: import date).</div>
            </div>
          </div>
          <div class="text-sm text-gray-700">
            Total: <span class="font-semibold text-gray-900">{formatCount(total())}</span>
            <span class="text-gray-500"> ({formatCount(fallbackTotal())} fallback)</span>
          </div>
        </div>

        <Suspense>
          <Show when={year() === '0'}>
            <div class="rounded-md border border-red-200 bg-red-50 p-4">
              <div class="text-red-700">Invalid year.</div>
            </div>
          </Show>

          <Show when={yearArticlesQuery.isLoading}>
            <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
              <div class="h-5 w-56 animate-pulse rounded bg-gray-200" />
              <div class="mt-4 h-4 w-80 animate-pulse rounded bg-gray-200" />
            </div>
          </Show>

          <Show when={yearArticlesQuery.isError}>
            <div class="rounded-md border border-red-200 bg-red-50 p-4">
              <div class="text-red-700">Failed to load year articles.</div>
              <button
                class="mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                onClick={() => {
                  return void yearArticlesQuery.refetch()
                }}
              >
                Retry
              </button>
            </div>
          </Show>

          <Show when={!yearArticlesQuery.isLoading && !yearArticlesQuery.isError && year() !== '0'}>
            <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
              <table class="min-w-full divide-y divide-gray-200">
                <thead class="bg-gray-50">
                  <tr>
                    <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Date</th>
                    <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Title
                    </th>
                    <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Import Route
                    </th>
                    <th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Article ID
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 bg-white">
                  <For each={articles()}>
                    {(article) => {
                      return (
                        <tr class="hover:bg-gray-50">
                          <td class="px-4 py-2 text-sm text-gray-700 whitespace-nowrap">
                            <span class={article.isFallbackDate ? 'text-gray-500' : 'text-gray-700'}>
                              {formatArticleDate(article.date)}
                            </span>
                            <Show when={article.isFallbackDate}>
                              <span class="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">fallback</span>
                            </Show>
                          </td>
                          <td class="px-4 py-2 text-sm text-gray-900">
                            <Link
                              to="/admin/import-route-stats/$year/$id"
                              params={{year: year(), id: article.id}}
                              class="text-blue-600 hover:text-blue-800 hover:underline"
                            >
                              {article.articleTitle ?? 'Untitled'}
                            </Link>
                          </td>
                          <td class="px-4 py-2 text-sm text-gray-700 whitespace-nowrap">
                            {article.importRoute ?? '(none)'}
                          </td>
                          <td class="px-4 py-2 text-sm text-gray-700 whitespace-nowrap font-mono">
                            {article.articleId ?? '(none)'}
                          </td>
                        </tr>
                      )
                    }}
                  </For>
                  <Show when={articles().length === 0}>
                    <tr>
                      <td class="px-4 py-8 text-sm text-gray-500 text-center" colSpan={4}>
                        No articles found.
                      </td>
                    </tr>
                  </Show>
                </tbody>
              </table>
            </div>
          </Show>
        </Suspense>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/import-route-stats/$year/')({component: AdminImportRouteStatsYear})
