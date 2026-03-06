import {createMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {fetchSession} from '../../../../services/fetchSession.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'

const AdminPdfReset = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const isSignedIn = () => {
    return Boolean(sessionQuery.data?.user)
  }

  const resetMutation = createMutation(() => {
    return {
      mutationFn: async () => {
        const response = await apiClient.api.articles['pdf-fetch-reset'].post()
        return handleApiResponse(response, 'Failed to reset PDF fetches')
      },
    }
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto max-w-2xl">
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
          <h1 class="text-2xl font-bold mb-6">Reset PDF Fetches</h1>

          <div class="bg-white shadow rounded-lg p-6 mb-6">
            <p class="text-gray-700 mb-6">
              This will reset all auto-fetched PDFs so they can be re-downloaded from arxiv/unpaywall. User-uploaded
              PDFs will not be affected.
            </p>

            <Show when={resetMutation.isSuccess}>
              <div class="mb-4 p-3 bg-green-50 border border-green-200 rounded-md text-green-800 text-sm">
                Reset started in background. Articles will be re-fetched by the cron job.
              </div>
            </Show>

            <Show when={resetMutation.isError}>
              <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-800 text-sm">
                Failed to reset: {String(resetMutation.error)}
              </div>
            </Show>

            <button
              onClick={() => {
                return resetMutation.mutate()
              }}
              disabled={resetMutation.isPending}
              class="w-full px-4 py-3 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {resetMutation.isPending ? 'Resetting...' : 'Reset All Auto-Fetched PDFs'}
            </button>
          </div>

          <p class="text-xs text-gray-500">
            After reset, the cron job will automatically re-fetch PDFs from arxiv and unpaywall.
          </p>
        </Show>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/pdf-reset/')({component: AdminPdfReset})
