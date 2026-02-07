import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createSignal, For, Show} from 'solid-js'

import {fetchProjectWithPrompts} from '../../../../../services/projectsService.ts'

const AdminUnexpectedAnswersPromptList = () => {
  const params = Route.useParams()
  const projectId = params().projectId

  const projectData = useQuery(() => {
    return {
      queryKey: ['project', projectId, 'with-prompts'],
      queryFn: () => {
        return fetchProjectWithPrompts(projectId)
      },
      refetchOnWindowFocus: false,
    }
  })

  const [searchTerm, setSearchTerm] = createSignal('')

  const filteredPrompts = () => {
    const prompts = projectData.data?.prompts ?? []
    const term = searchTerm().toLowerCase()
    return prompts
      .filter((prompt) => {
        return prompt.enabled && prompt.type // Only enabled prompts with defined types
      })
      .filter((prompt) => {
        return term === '' || (prompt.promptHeading?.toLowerCase().includes(term) ?? false)
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
        <h1 class="text-2xl font-bold">
          <Show when={projectData.data} fallback="Loading...">
            {(data) => {
              return data().project.name
            }}
          </Show>
        </h1>
        <p class="text-sm text-gray-600 mt-1">Select a prompt to investigate unexpected answers</p>
      </div>

      <div class="space-y-4">
        {/* Loading and Error States */}
        <Show when={projectData.isLoading}>
          <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
            <div class="text-gray-500">Loading prompts...</div>
          </div>
        </Show>
        <Show when={projectData.isError}>
          <div class="p-4 rounded-md bg-red-50 border border-red-200">
            <p class="text-red-600">Failed to load project prompts</p>
            <button
              onClick={() => {
                return void projectData.refetch()
              }}
              class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={projectData.data}>
          <>
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

            {/* Stats */}
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div class="text-sm text-gray-600">
                <span class="font-semibold text-gray-900">{filteredPrompts().length}</span> prompts with defined types
              </div>
            </div>

            {/* Prompts List */}
            <Show
              when={filteredPrompts().length > 0}
              fallback={
                <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-gray-500">
                  No prompts found with defined types
                </div>
              }
            >
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <For each={filteredPrompts()}>
                  {(prompt) => {
                    return (
                      <Link
                        to="/admin/unexpected-answers/$projectId/$promptId"
                        params={{projectId, promptId: prompt.id}}
                        class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 hover:shadow-md hover:border-blue-300 transition-all"
                      >
                        <h3 class="text-lg font-semibold text-gray-900 mb-2">
                          {prompt.promptHeading || 'Untitled Prompt'}
                        </h3>
                        <p class="text-xs text-gray-500 font-mono mb-3">{prompt.id}</p>
                        <div class="text-xs text-gray-600 mb-3">
                          <span class="font-medium">Type:</span> {prompt.type}
                        </div>
                        <div class="text-sm text-blue-600 font-medium">Investigate →</div>
                      </Link>
                    )
                  }}
                </For>
              </div>
            </Show>
          </>
        </Show>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/unexpected-answers/$projectId/')({
  component: AdminUnexpectedAnswersPromptList,
})
