import {Dialog} from '@ark-ui/solid'
import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createSignal, For, Show, Suspense} from 'solid-js'
import {Portal} from 'solid-js/web'

import {apiClient} from '../../../../services/apiClient.ts'
import {fetchSession} from '../../../../services/fetchSession.ts'

type FailedRequestRow = {
  id: string
  createdAt: string | Date
  judgmentsJobId: string | null
  modelName: string | null
  failedRequests: number | null
  failedRequestsDetails: unknown
  totalTokens: number
}

const fetchFailedRequests = async () => {
  const response = await apiClient.api.tokens['failed-requests'].post({limit: 50, offset: 0})
  if (response.error) throw new Error('Failed to fetch failed requests')
  return response.data.data
}

const AdminFailedRequests = () => {
  const [selectedDetails, setSelectedDetails] = createSignal<unknown>(null)
  const [isOpen, setIsOpen] = createSignal(false)

  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const failedRequestsQuery = useQuery(() => {
    return {queryKey: ['failedRequests'], queryFn: fetchFailedRequests, refetchOnWindowFocus: true}
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
  }

  const openDetails = (details: unknown) => {
    setSelectedDetails(details)
    setIsOpen(true)
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <Suspense
        fallback={
          <div class="flex items-center justify-center h-64">
            <p class="text-gray-500">Loading...</p>
          </div>
        }
      >
        <Show
          when={isAdmin()}
          fallback={
            <div class="bg-white border border-gray-200 rounded-lg shadow-sm max-w-xl mx-auto p-10 text-center">
              <h1 class="text-2xl font-semibold text-gray-900 mb-2">Administrator Access Required</h1>
              <Link
                to="/"
                class="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Go back home
              </Link>
            </div>
          }
        >
          <div class="flex justify-between items-center mb-6">
            <h1 class="text-2xl font-bold">Failed Requests</h1>
          </div>

          <Show when={failedRequestsQuery.isLoading}>
            <p class="text-gray-500">Loading failed requests...</p>
          </Show>

          <Show when={failedRequestsQuery.isError}>
            <div class="p-4 rounded-md bg-red-50 border border-red-200">
              <p class="text-red-600">Failed to load failed requests</p>
              <button
                onClick={() => {
                  return void failedRequestsQuery.refetch()
                }}
                class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Retry
              </button>
            </div>
          </Show>

          <Show when={!failedRequestsQuery.isLoading && !failedRequestsQuery.isError}>
            <div class="overflow-x-auto bg-white rounded-lg shadow">
              <table class="min-w-full divide-y divide-gray-200">
                <thead class="bg-gray-50">
                  <tr>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Token ID
                    </th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Job ID
                    </th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Model
                    </th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Failures
                    </th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200">
                  <For each={failedRequestsQuery.data}>
                    {(row: FailedRequestRow) => {
                      return (
                        <tr class="hover:bg-gray-50">
                          <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono text-xs">
                            {row.id.slice(0, 8)}...
                          </td>
                          <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {format(new Date(row.createdAt), 'yyyy-MM-dd HH:mm:ss')}
                          </td>
                          <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono text-xs">
                            {row.judgmentsJobId ?? '—'}
                          </td>
                          <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{row.modelName ?? '—'}</td>
                          <td class="px-6 py-4 whitespace-nowrap text-sm text-red-600 font-medium">
                            {row.failedRequests ?? 0}
                          </td>
                          <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            <button
                              onClick={() => {
                                return openDetails(row.failedRequestsDetails)
                              }}
                              class="text-blue-600 hover:text-blue-900"
                            >
                              View Details
                            </button>
                          </td>
                        </tr>
                      )
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>
      </Suspense>

      <Dialog.Root
        open={isOpen()}
        onOpenChange={(e) => {
          return setIsOpen(e.open)
        }}
      >
        <Portal>
          <Dialog.Backdrop class="fixed inset-0 bg-black/50 z-40" />
          <Dialog.Positioner class="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Dialog.Content class="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[80vh] flex flex-col">
              <div class="p-6 border-b border-gray-200 flex justify-between items-center">
                <Dialog.Title class="text-lg font-semibold text-gray-900">Failure Details</Dialog.Title>
                <Dialog.CloseTrigger class="text-gray-400 hover:text-gray-500">
                  <span class="sr-only">Close</span>
                  <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </Dialog.CloseTrigger>
              </div>
              <div class="p-6 overflow-auto">
                <pre class="bg-gray-50 p-4 rounded-md text-xs font-mono overflow-x-auto">
                  {JSON.stringify(selectedDetails(), null, 2)}
                </pre>
              </div>
              <div class="p-6 border-t border-gray-200 flex justify-end">
                <Dialog.CloseTrigger class="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 text-sm font-medium">
                  Close
                </Dialog.CloseTrigger>
              </div>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </div>
  )
}

export const Route = createFileRoute('/admin/failed_requests/')({component: AdminFailedRequests})
