import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createSignal, For, Show, Suspense} from 'solid-js'

import {apiClient} from '../../../../../services/apiClient.ts'

type FailedRequestDetailItem = {
  articleId: string
  promptIds: string[]
  modelId: string
  modelName: string
  baseURL: string
  failureType: 'retry' | 'total_failure'
  attempts: number
  failedAttempts: number
  failedPromptTokens: number
  failedCompletionTokens: number
  failedTotalTokens: number
  error?: string | null
  sanitizationAttempted?: boolean
  sanitizedError?: string | null
  sanitizedResponse?: string | null
  lastResponse?: string | null
  systemPrompt?: string | null
  userPrompt?: string | null
}

type FailedRequest = {
  id: string
  createdAt: string | Date
  judgmentsJobId: string | null
  projectId: string | null
  modelName: string | null
  failedRequests: number | null
  failedRequestsDetails: FailedRequestDetailItem[] | null
  totalTokens: number
  userId: string | null
  sessionId: string | null
  requests: number
  successfulRequests: number | null
}

const fetchFailedRequest = async (id: string) => {
  console.log('Fetching failed request detail for id:', id)
  const response = await apiClient.api.tokens['failed-requests']({id}).get()

  if (response.error) {
    console.error('Network/API error:', response.error)
    throw new Error('Failed to fetch failed request')
  }

  if (!response.data.success) {
    console.error('API returned failure:', response.data.error)
    throw new Error(response.data.error || 'Failed to locate request')
  }

  return response.data.data as FailedRequest
}

const copyTextToClipboard = (text: string | null | undefined) => {
  if (!text) return
  const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard
  if (!clipboard) {
    return
  }
  return clipboard.writeText(text)
}

const CopyButton = (props: {text: string | null | undefined; label?: string}) => {
  const [copied, setCopied] = createSignal(false)

  const handleCopy = () => {
    if (!props.text) return
    void copyTextToClipboard(props.text)
    setCopied(true)
    setTimeout(() => {
      setCopied(false)
    }, 2000)
  }

  return (
    <button
      class="px-2 py-1 text-xs font-medium rounded transition-all duration-200"
      classList={{'bg-green-100 text-green-700': copied(), 'bg-gray-200 text-gray-600 hover:bg-gray-300': !copied()}}
      onClick={handleCopy}
    >
      <Show when={copied()} fallback={props.label ?? 'Copy'}>
        ✓ Copied!
      </Show>
    </button>
  )
}

const FailedRequestDetail = () => {
  const params = Route.useParams()
  const id = () => {
    return params().id
  }

  const failedRequestQuery = useQuery(() => {
    return {
      queryKey: ['failedRequest', id()],
      queryFn: () => {
        return fetchFailedRequest(id())
      },
      enabled: Boolean(id()),
      retry: false,
    }
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Link to={'/admin/failed_requests' as any} class="text-blue-600 hover:underline mb-4 inline-block">
        &larr; Back to Failed Requests
      </Link>
      <h1 class="text-2xl font-bold mb-6">Failed Request Details</h1>

      <Suspense
        fallback={
          <div class="flex items-center justify-center h-64">
            <p class="text-gray-500">Loading request details...</p>
          </div>
        }
      >
        <Show
          when={failedRequestQuery.data}
          fallback={
            <Show when={!failedRequestQuery.isLoading && !failedRequestQuery.isError}>
              <div class="p-4 rounded-md bg-yellow-50 border border-yellow-200">
                <p class="text-yellow-700">No data found for this request.</p>
              </div>
            </Show>
          }
        >
          {(request) => {
            const failureDetails = Array.isArray(request().failedRequestsDetails) ? request().failedRequestsDetails : []
            const hasFailureDetails = failureDetails.length > 0
            return (
              <div class="space-y-6">
                {/* Main Request Metadata */}
                <div class="bg-white shadow overflow-hidden sm:rounded-lg">
                  <div class="px-4 py-5 sm:px-6">
                    <h3 class="text-lg leading-6 font-medium text-gray-900">Token ID: {request().id}</h3>
                    <p class="mt-1 max-w-2xl text-sm text-gray-500">
                      Created At: {format(new Date(request().createdAt), 'yyyy-MM-dd HH:mm:ss')}
                    </p>
                  </div>
                  <div class="border-t border-gray-200">
                    <dl>
                      <div class="bg-gray-50 px-4 py-5 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
                        <dt class="text-sm font-medium text-gray-500">Job ID</dt>
                        <dd class="mt-1 text-sm text-gray-900 sm:mt-0 sm:col-span-2">
                          <Show when={request().judgmentsJobId} fallback="N/A">
                            <Link
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                              to={`/admin/jobs/${request().judgmentsJobId}` as any}
                              class="text-blue-600 hover:underline"
                            >
                              {request().judgmentsJobId}
                            </Link>
                          </Show>
                        </dd>
                      </div>
                      <div class="bg-white px-4 py-5 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
                        <dt class="text-sm font-medium text-gray-500">Project ID</dt>
                        <dd class="mt-1 text-sm text-gray-900 sm:mt-0 sm:col-span-2">
                          <Show when={request().projectId} fallback="N/A">
                            <Link
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                              to={`/projects/${request().projectId}` as any}
                              class="text-blue-600 hover:underline"
                            >
                              {request().projectId}
                            </Link>
                          </Show>
                        </dd>
                      </div>
                      <div class="bg-gray-50 px-4 py-5 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
                        <dt class="text-sm font-medium text-gray-500">Model</dt>
                        <dd class="mt-1 text-sm text-gray-900 sm:mt-0 sm:col-span-2">{request().modelName ?? 'N/A'}</dd>
                      </div>
                      <div class="bg-white px-4 py-5 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
                        <dt class="text-sm font-medium text-gray-500">Failures</dt>
                        <dd class="mt-1 text-sm text-gray-900 sm:mt-0 sm:col-span-2">{request().failedRequests}</dd>
                      </div>
                      <div class="bg-gray-50 px-4 py-5 sm:grid sm:grid-cols-3 sm:gap-4 sm:px-6">
                        <dt class="text-sm font-medium text-gray-500">Total Tokens</dt>
                        <dd class="mt-1 text-sm text-gray-900 sm:mt-0 sm:col-span-2">{request().totalTokens}</dd>
                      </div>
                    </dl>
                  </div>
                </div>

                {/* Detailed Failures List */}
                <Show
                  when={hasFailureDetails}
                  fallback={<p class="text-gray-500">No detailed failure information available.</p>}
                >
                  <div class="space-y-4">
                    <For each={failureDetails}>
                      {(detail: FailedRequestDetailItem, index) => {
                        return (
                          <div class="bg-white shadow overflow-hidden sm:rounded-lg border border-gray-200">
                            <div class="px-4 py-4 sm:px-6 bg-red-50 border-b border-red-100 flex justify-between items-center">
                              <h3 class="text-md font-medium text-red-800">Failure #{index() + 1}</h3>
                              <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                                {detail.failureType}
                              </span>
                            </div>
                            <div class="px-4 py-5 sm:p-6">
                              <dl class="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
                                <div class="sm:col-span-1">
                                  <dt class="text-sm font-medium text-gray-500">Article ID</dt>
                                  <dd class="mt-1 text-sm text-gray-900">
                                    <Show when={request().projectId} fallback={detail.articleId}>
                                      <Link
                                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                        to={`/projects/${request().projectId}/reviews/${detail.articleId}` as any}
                                        class="text-blue-600 hover:underline"
                                      >
                                        {detail.articleId}
                                      </Link>
                                    </Show>
                                  </dd>
                                </div>
                                <div class="sm:col-span-1">
                                  <dt class="text-sm font-medium text-gray-500">Prompt IDs</dt>
                                  <dd class="mt-1 text-sm text-gray-900">
                                    <Show when={request().projectId} fallback={detail.promptIds.join(', ')}>
                                      <Link
                                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                        to={`/projects/${request().projectId}` as any}
                                        class="text-blue-600 hover:underline"
                                      >
                                        {detail.promptIds.join(', ')}
                                      </Link>
                                    </Show>
                                  </dd>
                                </div>
                                <div class="sm:col-span-1">
                                  <dt class="text-sm font-medium text-gray-500">Attempts</dt>
                                  <dd class="mt-1 text-sm text-gray-900">
                                    {detail.attempts} (Failed: {detail.failedAttempts})
                                  </dd>
                                </div>
                                <div class="sm:col-span-1">
                                  <dt class="text-sm font-medium text-gray-500">Base URL</dt>
                                  <dd class="mt-1 text-sm text-gray-900 break-all">{detail.baseURL}</dd>
                                </div>
                                <div class="sm:col-span-2">
                                  <dt class="text-sm font-medium text-gray-500">Token Usage (Failed)</dt>
                                  <dd class="mt-1 text-sm text-gray-900">
                                    Prompt: {detail.failedPromptTokens} | Completion: {detail.failedCompletionTokens} |
                                    Total: {detail.failedTotalTokens}
                                  </dd>
                                </div>
                                <Show when={detail.error}>
                                  <div class="sm:col-span-2">
                                    <dt class="text-sm font-medium text-gray-500 flex items-center gap-2">
                                      Original Error
                                      <Show when={detail.sanitizationAttempted}>
                                        <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
                                          Sanitization attempted
                                        </span>
                                      </Show>
                                    </dt>
                                    <dd class="mt-1 text-sm text-gray-900 whitespace-pre-wrap break-words">
                                      {detail.error}
                                    </dd>
                                  </div>
                                </Show>
                                <Show when={detail.sanitizedError}>
                                  <div class="sm:col-span-2">
                                    <dt class="text-sm font-medium text-gray-500">Error After Sanitization</dt>
                                    <dd class="mt-1 text-sm text-gray-900 whitespace-pre-wrap break-words">
                                      {detail.sanitizedError}
                                    </dd>
                                  </div>
                                </Show>
                                <Show when={detail.sanitizedResponse}>
                                  <div class="sm:col-span-2">
                                    <div class="flex items-center justify-between">
                                      <dt class="text-sm font-medium text-gray-500">Sanitized Response</dt>
                                      <CopyButton text={detail.sanitizedResponse} />
                                    </div>
                                    <dd class="mt-1 text-sm text-gray-900 whitespace-pre-wrap break-words bg-yellow-50 p-3 rounded-md border border-yellow-200 max-h-64 overflow-y-auto">
                                      {detail.sanitizedResponse}
                                    </dd>
                                  </div>
                                </Show>
                                <Show when={detail.lastResponse}>
                                  <div class="sm:col-span-2">
                                    <dt class="text-sm font-medium text-gray-500">Last Response</dt>
                                    <dd class="mt-1 text-sm text-gray-900 whitespace-pre-wrap break-words">
                                      {detail.lastResponse}
                                    </dd>
                                  </div>
                                </Show>
                                <Show when={detail.systemPrompt}>
                                  <div class="sm:col-span-2">
                                    <div class="flex items-center justify-between">
                                      <dt class="text-sm font-medium text-gray-500">System Prompt</dt>
                                      <CopyButton text={detail.systemPrompt} />
                                    </div>
                                    <dd class="mt-1 text-sm text-gray-900 whitespace-pre-wrap break-words bg-gray-50 p-3 rounded-md border border-gray-200 max-h-64 overflow-y-auto">
                                      {detail.systemPrompt}
                                    </dd>
                                  </div>
                                </Show>
                                <Show when={detail.userPrompt}>
                                  <div class="sm:col-span-2">
                                    <div class="flex items-center justify-between">
                                      <dt class="text-sm font-medium text-gray-500">User Prompt</dt>
                                      <CopyButton text={detail.userPrompt} />
                                    </div>
                                    <dd class="mt-1 text-sm text-gray-900 whitespace-pre-wrap break-words bg-gray-50 p-3 rounded-md border border-gray-200 max-h-64 overflow-y-auto">
                                      {detail.userPrompt}
                                    </dd>
                                  </div>
                                </Show>
                              </dl>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>

                <div class="mt-6">
                  <div class="flex items-center justify-between mb-2">
                    <h3 class="text-lg font-medium text-gray-900">Raw JSON Data</h3>
                    <CopyButton text={JSON.stringify(request(), null, 2)} />
                  </div>
                  <pre class="bg-gray-100 p-4 rounded-md overflow-x-auto text-xs">
                    {JSON.stringify(request(), null, 2)}
                  </pre>
                </div>
              </div>
            )
          }}
        </Show>
        <Show when={failedRequestQuery.isError}>
          <div class="p-4 rounded-md bg-red-50 border border-red-200">
            <p class="text-red-600">Failed to load request details</p>
          </div>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/failed_requests/$id/')({component: FailedRequestDetail})
