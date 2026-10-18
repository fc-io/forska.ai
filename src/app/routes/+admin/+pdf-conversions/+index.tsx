import {createMutation, useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {For, Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'
import {PdfConversionControls} from './pdfConversionControls.tsx'
import {PdfConversionFailedRow} from './pdfConversionFailedRow.tsx'
import {PdfConversionReconvertStatus} from './pdfConversionReconvertStatus.tsx'

const fetchConversionStats = async () => {
  const response = await apiClient.api.articles['conversion-stats'].get()
  return handleApiResponse(response, 'Failed to load conversion stats')
}

const reconvertFailedConversion = async (articleId: string) => {
  const response = await apiClient.api.articles['conversion-reconvert'].post({articleId})
  return handleApiResponse(response, 'Failed to reconvert article')
}

const AdminPdfConversions = () => {
  const queryClient = useQueryClient()
  const statsQuery = useQuery(() => {
    return {
      queryKey: ['articles', 'conversion-stats'],
      queryFn: fetchConversionStats,
      staleTime: 1000 * 30,
      refetchOnWindowFocus: false,
      suspense: false,
    }
  })
  const reconvertMutation = createMutation(() => {
    return {
      mutationFn: reconvertFailedConversion,
      onSuccess: () => {
        return queryClient.invalidateQueries({queryKey: ['articles', 'conversion-stats']})
      },
    }
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <PdfConversionControls totalFailed={statsQuery.data?.totalFailed} />

      <PdfConversionReconvertStatus
        clearedConvertedText={reconvertMutation.data?.clearedConvertedText}
        errorMessage={reconvertMutation.error?.message}
        isError={reconvertMutation.isError}
        isSuccess={reconvertMutation.isSuccess}
      />

      <Show when={statsQuery.isLoading}>
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
          <p class="text-gray-500 text-center">Loading failed conversions...</p>
        </div>
      </Show>

      <Show when={statsQuery.isError}>
        <div role="alert" class="p-4 rounded-md bg-red-50 border border-red-200">
          <p class="text-red-600">{statsQuery.error?.message || 'Failed to load conversion stats'}</p>
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

      <Show when={statsQuery.isSuccess}>
        <div class="bg-white shadow overflow-hidden sm:rounded-md">
          <ul class="divide-y divide-gray-200">
            <For each={statsQuery.data?.lastFailed ?? []}>
              {(article) => {
                return (
                  <PdfConversionFailedRow
                    article={article}
                    isReconvertDisabled={reconvertMutation.isPending}
                    isReconverting={reconvertMutation.isPending && reconvertMutation.variables === article.id}
                    onReconvert={reconvertMutation.mutate}
                  />
                )
              }}
            </For>
            <Show when={!statsQuery.data?.lastFailed?.length}>
              <li class="px-4 py-8 text-center text-gray-500 text-sm">No failed conversions found.</li>
            </Show>
          </ul>
        </div>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/pdf-conversions/')({component: AdminPdfConversions})
