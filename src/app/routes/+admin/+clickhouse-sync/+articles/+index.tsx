import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {Show} from 'solid-js'

import {fetchSession} from '../../../../../services/fetchSession.ts'

const AdminClickhouseArticlesSync = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const isSignedIn = () => {
    return Boolean(sessionQuery.data?.user)
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto max-w-4xl">
      <Show when={sessionQuery.isLoading}>
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
      </Show>

      <Show when={sessionQuery.isError}>
        <div class="p-4 rounded-md bg-red-50 border border-red-200 mb-6">
          <p class="text-red-600">
            Failed to load session: {sessionQuery.error instanceof Error ? sessionQuery.error.message : 'Unknown error'}
          </p>
        </div>
      </Show>

      <Show when={!sessionQuery.isLoading && !sessionQuery.isError}>
        <Show
          when={isSignedIn()}
          fallback={
            <div class="max-w-xl mx-auto text-center py-12">
              <h2 class="text-xl font-semibold text-gray-900">Sign in required</h2>
              <p class="mt-2 text-gray-600">You need to be signed in to view this page.</p>
              <Link to="/" class="mt-4 inline-block text-blue-600 hover:underline">
                Go back home
              </Link>
            </div>
          }
        >
          <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div class="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h1 class="text-2xl font-bold">ClickHouse Sync (Legacy)</h1>
                <p class="text-sm text-gray-600 mt-1">Removed. ClickHouse syncing is handled by PeerDB.</p>
              </div>
              <div class="flex gap-2">
                <Link
                  to="/admin/sync-stats"
                  class="px-3 py-1 text-sm rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700"
                >
                  Sync Stats
                </Link>
              </div>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/clickhouse-sync/articles/')({component: AdminClickhouseArticlesSync})
