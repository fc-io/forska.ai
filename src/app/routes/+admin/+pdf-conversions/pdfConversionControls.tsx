import {createMutation, useQueryClient} from '@tanstack/solid-query'
import {Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'

export const PdfConversionControls = (props: {totalFailed: number | undefined}) => {
  const queryClient = useQueryClient()
  const resetMutation = createMutation(() => {
    return {
      mutationFn: async () => {
        const response = await apiClient.api.articles['conversion-reset'].post()
        return handleApiResponse(response, 'Failed to reset conversions')
      },
      onSuccess: () => {
        return queryClient.invalidateQueries({queryKey: ['articles', 'conversion-stats']})
      },
    }
  })

  return (
    <>
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">Failed PDF Conversions</h1>
        <div class="flex items-center space-x-4">
          <Show when={props.totalFailed !== undefined}>
            <span class="text-sm text-gray-600 bg-gray-100 px-3 py-1 rounded-full">
              Total Failed: <span class="font-semibold text-gray-900">{props.totalFailed}</span>
            </span>
          </Show>
          <button
            onClick={() => {
              return resetMutation.mutate()
            }}
            disabled={resetMutation.isPending || !props.totalFailed}
            class="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Show when={resetMutation.isPending} fallback="Reset All Failed">
              Resetting...
            </Show>
          </button>
        </div>
      </div>
      <Show when={resetMutation.isError}>
        <div role="alert" class="mb-4 p-4 rounded-md bg-red-50 border border-red-200">
          <p class="text-red-600">{resetMutation.error?.message || 'Failed to reset conversions'}</p>
        </div>
      </Show>
    </>
  )
}
