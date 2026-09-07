import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {For, Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse.ts'
import {PdfConversionControls} from './pdfConversionControls.tsx'

const fetchConversionStats = async () => {
  const response = await apiClient.api.articles['conversion-stats'].get()
  return handleApiResponse(response, 'Failed to load conversion stats')
}

const AdminPdfConversions = () => {
  const statsQuery = useQuery(() => {
    return {
      queryKey: ['articles', 'conversion-stats'],
      queryFn: fetchConversionStats,
      staleTime: 1000 * 30,
      refetchOnWindowFocus: false,
      suspense: false,
    }
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <PdfConversionControls totalFailed={statsQuery.data?.totalFailed} />

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
                  <li class="px-4 py-4 sm:px-6">
                    <div class="flex items-center justify-between">
                      <div class="truncate text-sm font-medium text-blue-600">
                        <Link to="/articles/$id" params={{id: article.id}} class="hover:underline">
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
                      Last updated: {article.updatedAt ? new Date(article.updatedAt).toLocaleString() : 'Unknown'}
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
    </div>
  )
}

export const Route = createFileRoute('/admin/pdf-conversions/')({component: AdminPdfConversions})
