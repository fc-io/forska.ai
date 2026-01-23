import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createSignal, For, Show, Suspense} from 'solid-js'

import {env} from '../../../../utils/client-env.ts'

type Prompt = {
  id: string
  promptHeading: string
  type: string | null
  originalText: string
  createdAt: string | Date
  ownerId: string
  archived: boolean
}

type PromptsListResponse = {prompts: Prompt[]}

const formatPromptTimestamp = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

const getPromptPreview = (text: string, maxLength = 240): string => {
  const normalized = text.trim().replace(/\s+/g, ' ')
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
}

const fetchAllPromptsWithTypes = async (): Promise<PromptsListResponse> => {
  const response = await fetch(`${env.VITE_SERVER_API}/api/admin/list-prompts-with-types`, {credentials: 'include'})
  if (!response.ok) {
    throw new Error('Failed to fetch prompts list')
  }
  return response.json() as Promise<PromptsListResponse>
}

const AdminUnexpectedAnswersAllPrompts = () => {
  const promptsList = useQuery(() => {
    return {queryKey: ['admin-prompts-list'], queryFn: fetchAllPromptsWithTypes, refetchOnWindowFocus: false}
  })

  const [searchTerm, setSearchTerm] = createSignal('')

  const filteredPrompts = () => {
    const prompts = promptsList.data?.prompts ?? []
    const term = searchTerm().toLowerCase()
    return prompts.filter((prompt) => {
      return term === '' || prompt.promptHeading.toLowerCase().includes(term)
    })
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="mb-6">
        <div class="flex items-center gap-3 mb-2">
          <Link to="/admin/unexpected-answers" class="text-blue-600 hover:text-blue-800 text-sm font-medium">
            ← Back to Projects
          </Link>
        </div>
        <h1 class="text-2xl font-bold">All Prompts - Unexpected Answers (Global View)</h1>
        <p class="text-sm text-gray-600 mt-1">
          Select a prompt to investigate unexpected answers across all projects, models, and configurations
        </p>
      </div>

      <Suspense>
        <div class="space-y-4">
          {/* Loading and Error States */}
          <Show when={promptsList.isLoading}>
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
              <div class="text-gray-500">Loading prompts...</div>
            </div>
          </Show>
          <Show when={promptsList.isError}>
            <div class="p-4 rounded-md bg-red-50 border border-red-200">
              <p class="text-red-600">Failed to load prompts</p>
              <button
                onClick={() => {
                  return void promptsList.refetch()
                }}
                class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Retry
              </button>
            </div>
          </Show>

          <Show when={promptsList.data}>
            {(data) => {
              return (
                <>
                  {/* Warning Banner */}
                  <div class="bg-purple-50 rounded-lg shadow-sm border border-purple-200 p-4">
                    <p class="text-sm text-purple-800">
                      <strong>Note:</strong> This is a global view not filtered by project scope. To delete unexpected
                      judgments, navigate to a specific project.
                    </p>
                  </div>

                  {/* Search Filter */}
                  <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                    <input
                      type="text"
                      placeholder="Search prompts..."
                      value={searchTerm()}
                      onInput={(e) => {
                        return setSearchTerm(e.currentTarget.value)
                      }}
                      class="w-full px-3 py-2 border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  {/* Summary Stats */}
                  <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                    <div class="text-sm text-gray-600">
                      <span class="font-semibold text-gray-900">{filteredPrompts().length}</span> prompts found
                      {searchTerm() && (
                        <span>
                          {' '}
                          (out of <span class="font-semibold text-gray-900">{data().prompts.length}</span> total)
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Prompts List */}
                  <Show
                    when={filteredPrompts().length > 0}
                    fallback={
                      <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-gray-500">
                        No prompts found
                      </div>
                    }
                  >
                    <div class="space-y-3">
                      <For each={filteredPrompts()}>
                        {(prompt) => {
                          return (
                            <Link
                              to="/admin/unexpected-answers/all-prompts/$promptId"
                              params={{promptId: prompt.id}}
                              class="block border rounded-lg p-4 bg-white hover:shadow-md hover:border-blue-300 transition-all"
                            >
                              <div class="flex justify-between items-start gap-4">
                                <div class="flex-1 min-w-0">
                                  <div class="flex items-center gap-2 flex-wrap">
                                    <span class="font-medium truncate">{prompt.promptHeading}</span>
                                    <Show when={prompt.type}>
                                      <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                        {prompt.type}
                                      </span>
                                    </Show>
                                    <Show when={prompt.archived}>
                                      <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                                        Archived
                                      </span>
                                    </Show>
                                  </div>
                                  <div class="mt-1 text-xs text-gray-500">
                                    Created {formatPromptTimestamp(prompt.createdAt)} • Owner{' '}
                                    {prompt.ownerId.slice(0, 8)}
                                  </div>
                                </div>
                                <div class="text-sm text-blue-600 font-medium whitespace-nowrap">Investigate →</div>
                              </div>
                              <div class="mt-3 bg-gray-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">
                                {getPromptPreview(prompt.originalText)}
                              </div>
                            </Link>
                          )
                        }}
                      </For>
                    </div>
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

export const Route = createFileRoute('/admin/unexpected-answers/all-prompts/')({
  component: AdminUnexpectedAnswersAllPrompts,
})
