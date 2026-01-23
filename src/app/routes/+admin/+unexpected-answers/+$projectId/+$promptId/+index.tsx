import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createSignal, For, Show, Suspense} from 'solid-js'

import {env} from '../../../../../utils/client-env.ts'

type UnexpectedAnswer = {value: string | null; count: number}

type PromptResult = {
  promptId: string
  promptHeading: string
  expectedOptions: string[]
  unexpectedAnswers: UnexpectedAnswer[]
  totalJudgments: number
  percentUnexpected: number
}

type InvestigationResponse = {projectName: string; promptHeading: string; result: PromptResult | null}

const fetchUnexpectedAnswersForPrompt = async (projectId: string, promptId: string): Promise<InvestigationResponse> => {
  const response = await fetch(
    `${env.VITE_SERVER_API}/api/admin/investigate-unexpected-answers?projectId=${encodeURIComponent(projectId)}&promptId=${encodeURIComponent(promptId)}`,
    {credentials: 'include'},
  )
  if (!response.ok) {
    throw new Error('Failed to fetch unexpected answers data')
  }
  return response.json() as Promise<InvestigationResponse>
}

const deleteUnexpectedValue = async (promptId: string, unexpectedValue: string | null): Promise<{deleted: number}> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/delete-unexpected-answers`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    credentials: 'include',
    body: JSON.stringify({promptId, unexpectedValue}),
  })
  if (!response.ok) {
    throw new Error('Failed to delete unexpected judgments')
  }
  return response.json() as Promise<{deleted: number}>
}

const AdminUnexpectedAnswersPromptDetail = () => {
  const params = Route.useParams()
  const projectId = params().projectId
  const promptId = params().promptId
  const queryClient = useQueryClient()

  const [deletingValue, setDeletingValue] = createSignal<string | null>(null)

  const investigation = useQuery(() => {
    return {
      queryKey: ['admin-unexpected-answers', projectId, promptId],
      queryFn: () => {
        return fetchUnexpectedAnswersForPrompt(projectId, promptId)
      },
      refetchOnWindowFocus: false,
    }
  })

  const handleDelete = async (unexpectedValue: string | null) => {
    if (
      !confirm(
        `Delete all ${
          investigation.data?.result?.unexpectedAnswers.find((ua) => {
            return ua.value === unexpectedValue
          })?.count || 0
        } judgments with this value?`,
      )
    ) {
      return
    }

    setDeletingValue(unexpectedValue)
    const result = await deleteUnexpectedValue(promptId, unexpectedValue)
    setDeletingValue(null)

    if (result.deleted > 0) {
      await queryClient.invalidateQueries({queryKey: ['admin-unexpected-answers', projectId, promptId]})
    }
  }

  const getPercentColor = (percent: number) => {
    if (percent >= 20) return 'text-red-600 font-semibold'
    if (percent >= 10) return 'text-orange-600 font-medium'
    if (percent >= 5) return 'text-yellow-600'
    return 'text-gray-600'
  }

  const formatValue = (value: string | null) => {
    if (value === null) return 'NULL'
    if (value === '') return '(empty string)'
    return value
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="mb-6">
        <div class="flex items-center gap-3 mb-2">
          <Link to="/admin/unexpected-answers" class="text-blue-600 hover:text-blue-800 text-sm font-medium">
            ← Projects
          </Link>
          <span class="text-gray-400">/</span>
          <Link
            to="/admin/unexpected-answers/$projectId"
            params={{projectId}}
            class="text-blue-600 hover:text-blue-800 text-sm font-medium"
          >
            <Show when={investigation.data} fallback="Loading...">
              {(data) => {
                return data().projectName
              }}
            </Show>
          </Link>
        </div>
        <h1 class="text-2xl font-bold">
          <Show when={investigation.data} fallback="Loading...">
            {(data) => {
              return data().promptHeading
            }}
          </Show>
        </h1>
        <p class="text-sm text-gray-600 mt-1">Unexpected Answer Values</p>
      </div>

      <Suspense>
        <div class="space-y-4">
          {/* Loading and Error States */}
          <Show when={investigation.isLoading}>
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
              <div class="text-gray-500">Analyzing prompt judgments...</div>
            </div>
          </Show>
          <Show when={investigation.isError}>
            <div class="p-4 rounded-md bg-red-50 border border-red-200">
              <p class="text-red-600">Failed to load investigation data</p>
              <p class="text-sm text-red-500 mt-1">
                {investigation.error instanceof Error ? investigation.error.message : 'Unknown error'}
              </p>
              <button
                onClick={() => {
                  return void investigation.refetch()
                }}
                class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Retry
              </button>
            </div>
          </Show>

          <Show when={investigation.data}>
            {(data) => {
              return (
                <>
                  {/* No Issues - Success Message */}
                  <Show when={data().result === null}>
                    <div class="bg-green-50 rounded-lg shadow-sm border border-green-200 p-8 text-center">
                      <div class="text-green-700 font-medium text-lg">
                        ✓ No unexpected answers found for this prompt!
                      </div>
                      <div class="text-sm text-green-600 mt-2">All judgments match the defined type options.</div>
                    </div>
                  </Show>

                  {/* Results */}
                  <Show when={data().result}>
                    {(result) => {
                      const promptResult = result()
                      if (!promptResult) return null
                      return (
                        <>
                          {/* Summary Card */}
                          <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                            <div class="flex justify-between items-start">
                              <div class="flex-1">
                                <div class="text-sm text-gray-500 mb-2">Summary</div>
                                <div class="grid grid-cols-2 gap-6">
                                  <div>
                                    <div class="text-gray-600 text-xs uppercase mb-1">Total Judgments</div>
                                    <div class="text-2xl font-semibold text-gray-900">
                                      {promptResult.totalJudgments.toLocaleString()}
                                    </div>
                                  </div>
                                  <div>
                                    <div class="text-gray-600 text-xs uppercase mb-1">Unexpected</div>
                                    <div
                                      class={`text-2xl font-bold ${getPercentColor(promptResult.percentUnexpected)}`}
                                    >
                                      {promptResult.percentUnexpected.toFixed(1)}%
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Details Card */}
                          <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                              {/* Expected Options */}
                              <div>
                                <h3 class="text-sm font-medium text-gray-700 mb-3">Expected Options</h3>
                                <div class="flex flex-wrap gap-2">
                                  <For each={promptResult.expectedOptions}>
                                    {(option) => {
                                      return (
                                        <span class="inline-block px-3 py-1 bg-green-100 text-green-800 text-sm rounded-full">
                                          {option}
                                        </span>
                                      )
                                    }}
                                  </For>
                                </div>
                              </div>

                              {/* Unexpected Values */}
                              <div>
                                <h3 class="text-sm font-medium text-gray-700 mb-3">
                                  Unexpected Values Found ({promptResult.unexpectedAnswers.length})
                                </h3>
                                <div class="space-y-2">
                                  <For each={promptResult.unexpectedAnswers}>
                                    {(unexpected) => {
                                      const isDeleting = () => {
                                        return deletingValue() === unexpected.value
                                      }
                                      return (
                                        <div class="flex justify-between items-center py-2 px-3 bg-red-50 rounded gap-3">
                                          <div class="flex-1">
                                            <div class="text-sm font-mono text-red-600">
                                              "{formatValue(unexpected.value)}"
                                            </div>
                                            <div class="text-xs text-gray-500 mt-0.5">
                                              {unexpected.count.toLocaleString()} judgments
                                            </div>
                                          </div>
                                          <button
                                            onClick={() => {
                                              return void handleDelete(unexpected.value)
                                            }}
                                            disabled={isDeleting()}
                                            class="px-3 py-1 text-xs font-medium rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                          >
                                            {isDeleting() ? 'Deleting...' : 'Delete'}
                                          </button>
                                        </div>
                                      )
                                    }}
                                  </For>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Recommendations */}
                          <div class="bg-blue-50 rounded-lg shadow-sm border border-blue-200 p-6">
                            <h3 class="text-sm font-semibold text-blue-900 mb-3">What To Do</h3>
                            <ul class="text-sm text-blue-800 space-y-2">
                              <li>• Review if these values are valid but missing from type definition</li>
                              <li>• Check if judgments are from an old schema version</li>
                              <li>• Consider re-judging articles if values are incorrect</li>
                              <li>• Update type definition if new valid options identified</li>
                            </ul>
                          </div>
                        </>
                      )
                    }}
                  </Show>
                </>
              )
            }}
          </Show>
        </div>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/unexpected-answers/$projectId/$promptId/')({
  component: AdminUnexpectedAnswersPromptDetail,
})
