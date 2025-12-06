import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {For, Show, Suspense} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {fetchSession} from '../../../../services/fetchSession.ts'

type FailedRequestDetailItem = {failureType: 'retry' | 'total_failure'; error: string | null}

type FailedRequestRow = {
  id: string
  createdAt: string | Date
  judgmentsJobId: string | null
  projectId: string | null
  projectName: string | null
  promptHeadings: string | null
  modelName: string | null
  failedRequests: number | null
  failedRequestsDetails: FailedRequestDetailItem[] | null
  totalTokens: number
}

const fetchFailedRequests = async () => {
  const response = await apiClient.api.tokens['failed-requests'].post({limit: 50, offset: 0})
  if (response.error) throw new Error('Failed to fetch failed requests')
  return response.data.data as FailedRequestRow[]
}

/** Extract unique failure types from details array */
const getFailureTypes = (details: FailedRequestDetailItem[] | null): string => {
  if (!details || details.length === 0) return '—'
  const types = [
    ...new Set(
      details.map((d) => {
        return d.failureType
      }),
    ),
  ]
  return types
    .map((t) => {
      return t === 'total_failure' ? 'Total Failure' : 'Retry'
    })
    .join(', ')
}

/** Get the first non-null error message */
const getFirstError = (details: FailedRequestDetailItem[] | null): string | null => {
  if (!details || details.length === 0) return null
  const first = details.find((d) => {
    return d.error != null
  })
  return first?.error ?? null
}

const AdminFailedRequests = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  const failedRequestsQuery = useQuery(() => {
    return {queryKey: ['failedRequests'], queryFn: fetchFailedRequests, refetchOnWindowFocus: true}
  })

  const isAdmin = () => {
    return sessionQuery.data?.user?.role === 'admin'
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
              <table class="w-full table-fixed divide-y divide-gray-200">
                <thead class="bg-gray-50">
                  <tr>
                    <th class="w-[280px] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Token ID
                    </th>
                    <th class="w-[150px] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Time
                    </th>
                    <th class="w-[260px] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Project
                    </th>
                    <th class="w-[150px] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Prompt
                    </th>
                    <th class="w-[100px] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Job ID
                    </th>
                    <th class="w-[100px] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Failures
                    </th>
                    <th class="w-[100px] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Failed Type
                    </th>
                    <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Error
                    </th>
                  </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200">
                  <For each={failedRequestsQuery.data}>
                    {(row: FailedRequestRow) => {
                      return (
                        <tr class="hover:bg-gray-50">
                          <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-500 font-mono text-xs">
                            <Link
                              to={`/admin/failed_requests/${row.id}`}
                              class="text-blue-600 hover:text-blue-900 underline"
                            >
                              {row.id}
                            </Link>
                          </td>
                          <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-900">
                            {format(new Date(row.createdAt), 'yyyy-MM-dd HH:mm:ss')}
                          </td>
                          <td
                            class="px-4 py-4 text-sm text-gray-700 overflow-hidden text-ellipsis whitespace-nowrap"
                            title={row.projectName ?? ''}
                          >
                            <Show when={row.projectId} fallback={row.projectName ?? '—'}>
                              {(projectId) => {
                                return (
                                  <Link
                                    to="/projects/$id"
                                    params={{id: projectId()}}
                                    class="text-blue-600 hover:text-blue-900 underline"
                                  >
                                    {row.projectName}
                                  </Link>
                                )
                              }}
                            </Show>
                          </td>
                          <td
                            class="px-4 py-4 text-sm text-gray-700 overflow-hidden text-ellipsis whitespace-nowrap"
                            title={row.promptHeadings ?? ''}
                          >
                            {row.promptHeadings ?? '—'}
                          </td>
                          <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-500 font-mono text-xs">
                            <Show when={row.judgmentsJobId} fallback={'—'}>
                              {(jobId) => {
                                return (
                                  <Link
                                    to="/admin/jobs/$id"
                                    params={{id: jobId()}}
                                    class="text-blue-600 hover:text-blue-900 underline"
                                  >
                                    {jobId().split('-')[0]}
                                  </Link>
                                )
                              }}
                            </Show>
                          </td>
                          <td class="px-4 py-4 whitespace-nowrap text-sm text-red-600 font-medium">
                            {row.failedRequests ?? 0}
                          </td>
                          <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-700">
                            {getFailureTypes(row.failedRequestsDetails)}
                          </td>
                          <td
                            class="px-4 py-4 text-sm text-gray-600 overflow-hidden text-ellipsis whitespace-nowrap"
                            title={getFirstError(row.failedRequestsDetails) ?? ''}
                          >
                            {getFirstError(row.failedRequestsDetails) ?? '—'}
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
    </div>
  )
}

export const Route = createFileRoute('/admin/failed_requests/')({component: AdminFailedRequests})
