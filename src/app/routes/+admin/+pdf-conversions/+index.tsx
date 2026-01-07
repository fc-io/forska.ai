import {createMutation, useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {For, Show, Suspense} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {fetchSession} from '../../../../services/fetchSession.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'

const fetchConversionStats = async () => {
  const response = await apiClient.api.articles['conversion-stats'].get()
  return handleApiResponse(response, 'Failed to load conversion stats')
}

const AdminPdfConversions = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const queryClient = useQueryClient()

  const resetMutation = createMutation(() => {
    return {
      mutationFn: async () => {
        const response = await apiClient.api.articles['conversion-reset'].post()
        return handleApiResponse(response, 'Failed to reset conversions')
      },
      onSuccess: () => {
        queryClient.invalidateQueries({queryKey: ['articles', 'conversion-stats']})
      },
    }
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
            <h1 class="text-2xl font-bold">Failed PDF Conversions</h1>
            <div class="flex items-center space-x-4">
              <Show when={statsQuery.data?.totalFailed !== undefined}>
                <span class="text-sm text-gray-600 bg-gray-100 px-3 py-1 rounded-full">
                  Total Failed: <span class="font-semibold text-gray-900">{statsQuery.data?.totalFailed}</span>
                </span>
              </Show>
              <button
                onClick={() => {
                  return resetMutation.mutate()
                }}
                disabled={resetMutation.isPending || !statsQuery.data?.totalFailed}
                class="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {resetMutation.isPending ? 'Resetting...' : 'Reset All Failed'}
              </button>
            </div>
          </div>

          <Show when={statsQuery.isLoading}>
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
              <p class="text-gray-500 text-center">Loading failed conversions...</p>
            </div>
          </Show>

          <Show when={statsQuery.isError}>
            <div class="p-4 rounded-md bg-red-50 border border-red-200">
              <p class="text-red-600">Failed to load data</p>
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
            <div class="bg-white shadow overflow-hidden sm:rounded-md">
              <ul class="divide-y divide-gray-200">
                <For each={statsQuery.data?.lastFailed}>
                  {(article) => {
                    return (
                      <li class="px-4 py-4 sm:px-6">
                        <div class="flex items-center justify-between">
                          <div class="truncate text-sm font-medium text-blue-600">
                            <Link to={`/admin/articles/${article.id}`} class="hover:underline">
                              {article.title}
                            </Link>
                          </div>
                          <div class="ml-2 flex-shrink-0 flex">
                            <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-red-100 text-red-800">
                              {article.attempts} attempts
                            </span>
                          </div>
                        </div>
                        <div class="mt-2 text-sm text-gray-500">
                          <p class="truncate font-mono bg-gray-50 p-1 rounded text-xs">
                            {article.error || 'Unknown error'}
                          </p>
                        </div>
                        <div class="mt-2 text-xs text-gray-400">
                          Last updated: {new Date(article.updatedAt).toLocaleString()}
                        </div>
                      </li>
                    )
                  }}
                </For>
                <Show when={!statsQuery.data?.lastFailed?.length}>
                  <li class="px-4 py-8 text-center text-gray-500 text-sm">No failed conversions found.</li>
                </Show>
              </ul>
            </div>
          </Show>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/pdf-conversions/')({component: AdminPdfConversions})
