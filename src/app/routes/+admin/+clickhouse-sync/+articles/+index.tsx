import {createMutation, useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {Match, Show, Suspense, Switch} from 'solid-js'

import {apiClient} from '../../../../../services/apiClient.ts'
import {fetchSession} from '../../../../../services/fetchSession.ts'
import {handleApiResponse} from '../../../../../services/utils/handleApiResponse.ts'

const fetchArticlesSyncStatus = async () => {
  const response = await apiClient.api.admin['clickhouse-articles-sync-status'].get()
  return handleApiResponse(response, 'Failed to fetch articles sync status')
}

const formatDate = (dateStr: string | null): string => {
  const date = dateStr ? new Date(dateStr) : null
  return date ? date.toLocaleString() : 'N/A'
}

const formatLag = (lagSeconds: number | null): string => {
  return lagSeconds === null
    ? 'N/A'
    : lagSeconds < 60
      ? `${lagSeconds}s`
      : lagSeconds < 3600
        ? `${Math.round(lagSeconds / 60)}m`
        : lagSeconds < 86400
          ? `${Math.round(lagSeconds / 3600)}h`
          : `${Math.round(lagSeconds / 86400)}d`
}

const AdminClickhouseArticlesSync = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const queryClient = useQueryClient()

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const statusQuery = useQuery(() => {
    return {
      queryKey: ['clickhouse-sync', 'articles', 'status'],
      queryFn: fetchArticlesSyncStatus,
      staleTime: 1000 * 10,
      refetchOnWindowFocus: true,
    }
  })

  const syncMutation = createMutation(() => {
    return {
      mutationFn: async () => {
        const response = await apiClient.api.admin['sync-articles-to-clickhouse'].post()
        return handleApiResponse(response, 'Failed to sync articles')
      },
      onSuccess: () => {
        void queryClient.invalidateQueries({queryKey: ['clickhouse-sync', 'articles', 'status']})
      },
    }
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto max-w-4xl">
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
          <div class="mb-8">
            <div class="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h1 class="text-2xl font-bold">ClickHouse Sync — Articles</h1>
                <p class="text-sm text-gray-600 mt-1">Syncs PostgreSQL `articles` into ClickHouse `forska.articles`.</p>
              </div>
              <div class="flex gap-2">
                <Link
                  to="/admin/clickhouse-sync"
                  class="px-3 py-1 text-sm rounded-md bg-white border border-gray-200 text-gray-800 hover:bg-gray-50 font-medium"
                >
                  Judgments
                </Link>
                <span class="px-3 py-1 text-sm rounded-md bg-blue-600 text-white font-medium">Articles</span>
              </div>
            </div>
          </div>

          <div class="space-y-4">
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-lg font-semibold">Sync Status</h2>
                <button
                  onClick={() => {
                    return void statusQuery.refetch()
                  }}
                  disabled={statusQuery.isLoading}
                  class="px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 rounded-md disabled:opacity-50"
                >
                  {statusQuery.isLoading ? 'Loading...' : 'Refresh'}
                </button>
              </div>

              <Show when={statusQuery.isError}>
                <div class="p-4 rounded-md bg-red-50 border border-red-200 mb-4">
                  <p class="text-red-600">Failed to load status: {String(statusQuery.error)}</p>
                </div>
              </Show>

              <Show when={statusQuery.data}>
                {(s) => {
                  return (
                    <div class="space-y-4">
                      <div class="flex items-center gap-3">
                        <Switch>
                          <Match when={s().status === 'synced'}>
                            <span class="px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
                              Synced
                            </span>
                          </Match>
                          <Match when={s().status === 'behind'}>
                            <span class="px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
                              Behind
                            </span>
                          </Match>
                          <Match when={s().status === 'mutating'}>
                            <span class="px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">
                              Mutating
                            </span>
                          </Match>
                          <Match when={s().status === 'diff'}>
                            <span class="px-3 py-1 rounded-full text-sm font-medium bg-orange-100 text-orange-800">
                              Diff
                            </span>
                          </Match>
                          <Match when={s().status === 'critical'}>
                            <span class="px-3 py-1 rounded-full text-sm font-medium bg-red-100 text-red-800">
                              Critical
                            </span>
                          </Match>
                          <Match when={s().status === 'unreachable'}>
                            <span class="px-3 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-800">
                              Unreachable
                            </span>
                          </Match>
                        </Switch>
                        <span class="text-sm text-gray-600">{s().message}</span>
                      </div>

                      <div class="grid grid-cols-2 gap-4">
                        <div class="p-4 bg-gray-50 rounded-lg">
                          <h3 class="text-sm font-medium text-gray-500 mb-2">PostgreSQL</h3>
                          <p class="text-lg font-semibold text-gray-900">{s().postgres.count.toLocaleString()} rows</p>
                          <p class="text-xs text-gray-600 mt-1">
                            max(updatedAt): {formatDate(s().postgres.maxUpdatedAt)}
                          </p>
                        </div>
                        <div class="p-4 bg-gray-50 rounded-lg">
                          <h3 class="text-sm font-medium text-gray-500 mb-2">ClickHouse</h3>
                          <p class="text-lg font-semibold text-gray-900">
                            {(s().clickhouse.count ?? 0).toLocaleString()} unique ids (approx)
                          </p>
                          <p class="text-sm text-gray-700 mt-1">
                            {(s().clickhouse.physicalCount ?? 0).toLocaleString()} physical rows
                          </p>
                          <p class="text-xs text-gray-600 mt-1">
                            max(updated_at): {formatDate(s().clickhouse.maxUpdatedAt)}
                          </p>
                        </div>
                      </div>

                      <div class="grid grid-cols-2 gap-4">
                        <div class="p-4 bg-gray-50 rounded-lg text-center">
                          <p class="text-sm text-gray-500">Lag</p>
                          <p class="text-lg font-semibold">{formatLag(s().lagSeconds)}</p>
                        </div>
                        <div class="p-4 bg-gray-50 rounded-lg text-center">
                          <p class="text-sm text-gray-500">Pending CH mutations</p>
                          <p class="text-lg font-semibold">{(s().mutations.pending ?? 0).toLocaleString()}</p>
                        </div>
                      </div>
                    </div>
                  )
                }}
              </Show>
            </div>

            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h2 class="text-lg font-semibold mb-3">Run Sync</h2>
              <p class="text-sm text-gray-600 mb-4">
                Pulls new/updated PG rows into ClickHouse. Updated rows create new versions until ClickHouse merges.
              </p>

              <button
                onClick={() => {
                  return syncMutation.mutate()
                }}
                disabled={syncMutation.isPending}
                class="px-6 py-2.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                {syncMutation.isPending ? 'Syncing...' : 'Run Sync'}
              </button>

              <Show when={syncMutation.isSuccess && syncMutation.data}>
                {(result) => {
                  return (
                    <div class="mt-4 p-4 rounded-md bg-green-50 border border-green-200">
                      <p class="text-green-700 font-medium">Sync completed</p>
                      <p class="text-sm text-green-600 mt-1">
                        Inserted ~{result().syncedRows.toLocaleString()} rows in{' '}
                        {(result().durationMs / 1000).toFixed(1)}s
                      </p>
                      <p class="text-xs text-green-700 mt-1">Last updated_at: {result().lastUpdatedAt ?? 'N/A'}</p>
                    </div>
                  )
                }}
              </Show>

              <Show when={syncMutation.isError}>
                <div class="mt-4 p-4 rounded-md bg-red-50 border border-red-200">
                  <p class="text-red-600">Failed to sync: {String(syncMutation.error)}</p>
                </div>
              </Show>
            </div>
          </div>

          <div class="mt-6 bg-blue-50 rounded-lg shadow-sm border border-blue-200 p-6">
            <h3 class="text-sm font-semibold text-blue-900 mb-3">What This Sync Does</h3>
            <ul class="text-sm text-blue-800 space-y-2">
              <li>
                <strong>Source of truth:</strong> PostgreSQL. ClickHouse holds rows for fast project scoping/filtering.
              </li>
              <li>
                <strong>ReplacingMergeTree:</strong> updates insert new versions; the table may temporarily have more
                physical rows than unique ids.
              </li>
              <li>
                <strong>Does not handle deletes:</strong> if an article is removed in PostgreSQL, it may remain in
                ClickHouse until explicitly deleted.
              </li>
              <li>
                <strong>Judgments sync:</strong> back at{' '}
                <Link to="/admin/clickhouse-sync" class="underline">
                  /admin/clickhouse-sync
                </Link>
                .
              </li>
            </ul>
          </div>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/clickhouse-sync/articles/')({component: AdminClickhouseArticlesSync})
