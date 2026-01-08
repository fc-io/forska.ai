import {createMutation, useQuery, useQueryClient} from '@tanstack/solid-query'
import {Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'
import {handleApiResponse} from '../../../services/utils/handleApiResponse.ts'

interface ArticleAdminSectionProps {
  articleId: string
}

const fetchArticleAdminInfo = async (articleId: string) => {
  const response = await apiClient.api.articles({id: articleId})['admin-info'].get()
  return handleApiResponse(response, 'Failed to load admin info')
}

/**
 * Admin-only section that displays article metadata and provides
 * a button to force refetch the PDF. This component should be wrapped
 * in a Suspense boundary to avoid blocking the rest of the page.
 */
export const ArticleAdminSection = (props: ArticleAdminSectionProps) => {
  const queryClient = useQueryClient()

  const adminInfoQuery = useQuery(() => {
    return {
      queryKey: ['article-admin-info', props.articleId],
      queryFn: () => {
        return fetchArticleAdminInfo(props.articleId)
      },
      staleTime: 1000 * 30,
    }
  })

  const fetchPdfMutation = createMutation(() => {
    return {
      mutationFn: async () => {
        const response = await apiClient.api.articles({id: props.articleId})['fetch-pdf'].post()
        return handleApiResponse(response, 'Failed to fetch PDF')
      },
      onSuccess: () => {
        // Invalidate the admin info query to refresh the data
        queryClient.invalidateQueries({queryKey: ['article-admin-info', props.articleId]})
        // Also invalidate the main article query in case it's being used
        queryClient.invalidateQueries({queryKey: ['admin-article-details', props.articleId]})
        queryClient.invalidateQueries({queryKey: ['article-review-details']})
      },
    }
  })

  const formatDate = (date: string | Date | null | undefined) => {
    if (!date) return 'Never'
    const d = typeof date === 'string' ? new Date(date) : date
    return d.toLocaleString()
  }

  return (
    <div class="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
      <div class="flex items-center gap-2 mb-3">
        <svg class="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <h3 class="text-sm font-semibold text-amber-800">Admin Info</h3>
      </div>

      <Show when={adminInfoQuery.isLoading}>
        <div class="text-sm text-amber-700">Loading admin info...</div>
      </Show>

      <Show when={adminInfoQuery.isError}>
        <div class="text-sm text-red-600">Failed to load admin info</div>
      </Show>

      <Show when={adminInfoQuery.data?.article}>
        {(article) => {
          return (
            <div class="space-y-2">
              <div class="text-xs">
                <span class="font-medium text-amber-800">Article ID:</span>
                <span class="ml-2 font-mono text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded select-all">
                  {article().id}
                </span>
              </div>

              <div class="text-xs">
                <span class="font-medium text-amber-800">PDF Fetched At:</span>
                <span class="ml-2 text-amber-700">{formatDate(article().fullTextFetchedAt)}</span>
              </div>

              <div class="text-xs">
                <span class="font-medium text-amber-800">PDF Path:</span>
                <Show when={article().fullTextPDF} fallback={<span class="ml-2 text-amber-600 italic">Not available</span>}>
                  <span class="ml-2 font-mono text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded text-xs break-all">
                    {article().fullTextPDF}
                  </span>
                </Show>
              </div>

              <Show when={article().fullTextConversionStatus}>
                <div class="text-xs">
                  <span class="font-medium text-amber-800">Conversion Status:</span>
                  <span
                    class={`ml-2 px-1.5 py-0.5 rounded text-xs ${
                      article().fullTextConversionStatus === 'success'
                        ? 'bg-green-100 text-green-700'
                        : article().fullTextConversionStatus === 'failed'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {article().fullTextConversionStatus}
                  </span>
                </div>
              </Show>

              <Show when={article().fullTextConversionError}>
                <div class="text-xs">
                  <span class="font-medium text-amber-800">Conversion Error:</span>
                  <span class="ml-2 font-mono text-red-600 text-xs break-all">{article().fullTextConversionError}</span>
                </div>
              </Show>

              <div class="pt-2 border-t border-amber-200">
                <button
                  onClick={() => {
                    return fetchPdfMutation.mutate()
                  }}
                  disabled={fetchPdfMutation.isPending}
                  class="w-full px-3 py-1.5 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {fetchPdfMutation.isPending ? (
                    <span class="flex items-center justify-center gap-2">
                      <svg class="animate-spin h-3 w-3" viewBox="0 0 24 24">
                        <circle
                          class="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          stroke-width="4"
                          fill="none"
                        />
                        <path
                          class="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                      Fetching PDF...
                    </span>
                  ) : (
                    'Fetch PDF Now'
                  )}
                </button>

                <Show when={fetchPdfMutation.isSuccess}>
                  <div class="mt-2 text-xs text-green-600">
                    ✓ PDF fetch completed
                    <Show when={fetchPdfMutation.data?.fullTextPDF}>
                      {' '}
                      - saved to {fetchPdfMutation.data?.fullTextPDF}
                    </Show>
                    <Show when={!fetchPdfMutation.data?.fullTextPDF}> - no PDF found</Show>
                  </div>
                </Show>

                <Show when={fetchPdfMutation.isError}>
                  <div class="mt-2 text-xs text-red-600">✗ Failed to fetch PDF</div>
                </Show>
              </div>
            </div>
          )
        }}
      </Show>
    </div>
  )
}
