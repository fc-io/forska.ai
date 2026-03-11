import {createMutation} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'

const AdminPdfReset = () => {
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
      <h1 class="text-2xl font-bold mb-6">Reset PDF Fetches</h1>

      <div class="bg-white shadow rounded-lg p-6 mb-6">
        <p class="text-gray-700 mb-6">
          This will reset all auto-fetched PDFs so they can be re-downloaded from arxiv/unpaywall. Manual uploads will
          not be affected.
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
    </div>
  )
}

export const Route = createFileRoute('/admin/pdf-reset/')({component: AdminPdfReset})
