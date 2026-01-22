import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createSignal, For, Show, Suspense} from 'solid-js'

import {fetchProjects} from '../../../../services/projectsService.ts'

const AdminUnexpectedAnswersProjectList = () => {
  const projects = useQuery(() => {
    return {queryKey: ['projects'], queryFn: fetchProjects, refetchOnWindowFocus: false}
  })

  const [searchTerm, setSearchTerm] = createSignal('')

  const filteredProjects = () => {
    const projectsList = projects.data ?? []
    const term = searchTerm().toLowerCase()
    return projectsList.filter((project) => {
      return term === '' || project.name.toLowerCase().includes(term)
    })
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="mb-6">
        <h1 class="text-2xl font-bold">Unexpected Answer Values - Select Project</h1>
        <p class="text-sm text-gray-600 mt-2">
          Choose a project to investigate prompts with unexpected judgment answers
        </p>
      </div>

      <Suspense>
        <div class="space-y-4">
          {/* Loading and Error States */}
          <Show when={projects.isLoading}>
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
              <div class="text-gray-500">Loading projects...</div>
            </div>
          </Show>
          <Show when={projects.isError}>
            <div class="p-4 rounded-md bg-red-50 border border-red-200">
              <p class="text-red-600">Failed to load projects</p>
              <button
                onClick={() => {
                  return void projects.refetch()
                }}
                class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Retry
              </button>
            </div>
          </Show>

          <Show when={projects.data}>
            {() => {
              return (
                <>
                  {/* Search Filter */}
                  <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                    <input
                      type="text"
                      placeholder="Search projects..."
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
                      <span class="font-semibold text-gray-900">{filteredProjects().length}</span> projects found
                    </div>
                  </div>

                  {/* Projects List */}
                  <Show
                    when={filteredProjects().length > 0}
                    fallback={
                      <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-gray-500">
                        No projects found
                      </div>
                    }
                  >
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      <For each={filteredProjects()}>
                        {(project) => {
                          return (
                            <Link
                              to="/admin/unexpected-answers/$projectId"
                              params={{projectId: project.id}}
                              class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 hover:shadow-md hover:border-blue-300 transition-all"
                            >
                              <h3 class="text-lg font-semibold text-gray-900 mb-2">{project.name}</h3>
                              <p class="text-xs text-gray-500 font-mono mb-3">{project.id}</p>
                              <div class="text-sm text-blue-600 font-medium">Investigate →</div>
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

export const Route = createFileRoute('/admin/unexpected-answers/')({component: AdminUnexpectedAnswersProjectList})
