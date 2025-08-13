import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {createEffect, createSignal, For, Show} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../../components/ui/button'
import {apiClient} from '../../../../services/apiClient'

type PromptItem = {
  id: string
  originalText: string
  promptHeading: string
  type: string
  isExisting: boolean
  originalId?: string
  order: number
}

const EditProject = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id

  // Fetch project data and prompts simultaneously
  const projectData = useQuery(() => {
    return {
      queryKey: ['project', projectId, 'with-prompts'],
      queryFn: async () => {
        const response = await apiClient.api.projects({id: projectId}).get()

        if (response.error) {
          throw new Error('Failed to fetch project')
        }

        if (response.data?.error) {
          throw new Error(response.data.error)
        }

        if (!response.data?.data) {
          throw new Error('Project not found')
        }

        return response.data.data
      },
    }
  })

  const [projectName, setProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [prompts, setPrompts] = createStore<PromptItem[]>([])
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  createEffect(() => {
    const data = projectData.data
    if (!data) return

    const {project, prompts: existingPrompts, hasJudgedArticles} = data

    if (project) {
      setProjectName(project.name)
      setDescription(project.description || '')
    }

    if (existingPrompts && existingPrompts.length > 0) {
      const formattedPrompts: PromptItem[] = existingPrompts.map((prompt) => {
        return {
          id: crypto.randomUUID(),
          originalText: prompt.originalText,
          promptHeading: prompt.promptHeading || '',
          type: prompt.type || '',
          isExisting: true,
          originalId: prompt.id,
          order: prompt.order || 0,
        }
      })
      setPrompts(formattedPrompts)
    } else {
      // Add one empty prompt if no existing prompts
      setPrompts([
        {
          id: crypto.randomUUID(),
          originalText: '',
          promptHeading: '',
          type: '',
          isExisting: false,
          order: 1,
        },
      ])
    }
  })

  const addPromptInput = () => {
    const newOrder =
      prompts.length > 0
        ? Math.max(
            ...prompts.map((p) => {
              return p.order
            }),
          ) + 1
        : 1
    setPrompts([
      ...prompts,
      {
        id: crypto.randomUUID(),
        originalText: '',
        promptHeading: '',
        type: '',
        isExisting: false,
        order: newOrder,
      },
    ])
  }

  const removePromptInput = (id: string) => {
    if (prompts.length > 1) {
      setPrompts(
        prompts.filter((prompt) => {
          return prompt.id !== id
        }),
      )
    }
  }

  const updatePromptInput = (
    id: string,
    field: 'originalText' | 'promptHeading' | 'type',
    value: string,
  ) => {
    const idx = prompts.findIndex((p) => {
      return p.id === id
    })
    if (idx >= 0) {
      setPrompts(idx, field, value)
    }
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    setError(null)
    setIsLoading(true)

    try {
      // Prepare prompts data for the API
      const promptsData = prompts
        .filter((p: PromptItem) => {
          return p.originalText || p.isExisting
        }) // Include existing prompts even if empty
        .map((p: PromptItem) => {
          return {
            originalId: p.originalId,
            originalText: p.originalText,
            promptHeading: p.promptHeading || undefined,
            type: p.type || undefined,
            order: p.order,
          }
        })

      // Update project and prompts in a single request
      const response = await apiClient.api
        .projects({id: projectId})
        .edit.patch({
          name: projectName(),
          description: description() || null,
          prompts: promptsData,
        })

      if (response.error || response.data?.error) {
        console.error(
          'Error updating project:',
          response.error || response.data?.error,
        )
        throw new Error(response.data?.error || 'Failed to update project')
      }

      // void navigate({to: '/projects'})
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'An unexpected error occurred'
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <div class="flex items-center gap-4 mb-6">
        <Button as={Link} href="/projects" variant="outline" size="sm">
          ← Back to Projects
        </Button>
        <h1 class="text-3xl font-bold">Edit Project</h1>
      </div>

      <Show when={projectData.isLoading}>
        <div class="text-center py-8">Loading project data...</div>
      </Show>

      <Show when={Boolean(projectData.error)}>
        <div class="text-center py-8 text-red-600">
          Error loading project:{' '}
          {(projectData.error as Error)?.message || 'Unknown error'}
        </div>
      </Show>

      <Show when={projectData.data && !projectData.isLoading}>
        <div class="bg-card border rounded-lg p-6">
          <Show when={projectData.data?.hasJudgedArticles}>
            <div class="mb-6 p-4 bg-amber-50 border-2 border-amber-300 rounded-lg">
              <div class="flex items-start gap-3">
                <span class="text-amber-600 text-xl mt-0.5">⚠️</span>
                <div>
                  <h3 class="font-semibold text-amber-900 mb-1">
                    Project Locked for Editing
                  </h3>
                  <p class="text-amber-800 text-sm">
                    This project cannot be modified because articles have
                    already been judged based on its prompts. All fields and
                    buttons have been disabled to preserve the integrity of
                    existing assessments.
                  </p>
                </div>
              </div>
            </div>
          </Show>
          <Show when={error()}>
            <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
              {error()}
            </div>
          </Show>

          <form
            onSubmit={(e) => {
              return void handleSubmit(e)
            }}
            class="space-y-6"
          >
            <div>
              <label for="project-name" class="block text-sm font-medium mb-2">
                Project Name *
              </label>
              <input
                id="project-name"
                type="text"
                value={projectName()}
                onInput={(e) => {
                  return setProjectName(e.currentTarget.value)
                }}
                placeholder="Enter project name"
                class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent ${
                  projectData.data?.hasJudgedArticles
                    ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed opacity-60'
                    : 'border-input'
                }`}
                required
                disabled={projectData.data?.hasJudgedArticles}
              />
            </div>

            <div>
              <label for="description" class="block text-sm font-medium mb-2">
                Description
              </label>
              <textarea
                id="description"
                value={description()}
                onInput={(e) => {
                  return setDescription(e.currentTarget.value)
                }}
                placeholder="Describe your project..."
                rows="4"
                class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none ${
                  projectData.data?.hasJudgedArticles
                    ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed opacity-60'
                    : 'border-input'
                }`}
                disabled={projectData.data?.hasJudgedArticles}
              />
            </div>

            <div>
              <div class="flex items-center justify-between mb-2">
                <label class="block text-sm font-medium">
                  Your questions about the article
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addPromptInput}
                  disabled={projectData.data?.hasJudgedArticles}
                  class={
                    projectData.data?.hasJudgedArticles
                      ? 'opacity-50 cursor-not-allowed'
                      : ''
                  }
                >
                  + Add Prompt
                </Button>
              </div>
              <div class="space-y-3">
                <For
                  each={[...prompts].sort((a, b) => {
                    return a.order - b.order
                  })}
                  fallback={<div>No prompts</div>}
                >
                  {(promptItem, index) => {
                    return (
                      <div class="flex gap-2">
                        <div class="flex-1 space-y-2">
                          <input
                            type="text"
                            value={promptItem.promptHeading}
                            onInput={(e) => {
                              return updatePromptInput(
                                promptItem.id,
                                'promptHeading',
                                e.currentTarget.value,
                              )
                            }}
                            placeholder={`Prompt ${index() + 1} heading (optional)...`}
                            class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent ${
                              projectData.data?.hasJudgedArticles
                                ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed opacity-60'
                                : 'border-input'
                            }`}
                            disabled={projectData.data?.hasJudgedArticles}
                          />
                          <input
                            type="text"
                            value={promptItem.type}
                            onInput={(e) => {
                              return updatePromptInput(
                                promptItem.id,
                                'type',
                                e.currentTarget.value,
                              )
                            }}
                            placeholder={`Prompt ${index() + 1} type (optional)...`}
                            class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent ${
                              projectData.data?.hasJudgedArticles
                                ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed opacity-60'
                                : 'border-input'
                            }`}
                            disabled={projectData.data?.hasJudgedArticles}
                          />
                          <textarea
                            value={promptItem.originalText}
                            onInput={(e) => {
                              return updatePromptInput(
                                promptItem.id,
                                'originalText',
                                e.currentTarget.value,
                              )
                            }}
                            placeholder={`Enter prompt ${index() + 1} content...`}
                            rows="4"
                            class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none ${
                              projectData.data?.hasJudgedArticles
                                ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed opacity-60'
                                : 'border-input'
                            }`}
                            disabled={projectData.data?.hasJudgedArticles}
                          />
                        </div>
                        <Show when={prompts.length > 1}>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              return removePromptInput(promptItem.id)
                            }}
                            class={`self-start mt-1 ${projectData.data?.hasJudgedArticles ? 'opacity-50 cursor-not-allowed' : ''}`}
                            disabled={projectData.data?.hasJudgedArticles}
                          >
                            ×
                          </Button>
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>

            <div class="flex gap-3 pt-4">
              <Button
                type="submit"
                disabled={
                  !projectName().trim()
                  || isLoading()
                  || projectData.data?.hasJudgedArticles
                }
                title={
                  projectData.data?.hasJudgedArticles
                    ? 'Cannot update: articles have been judged based on this project'
                    : undefined
                }
                class={
                  projectData.data?.hasJudgedArticles
                    ? 'opacity-50 cursor-not-allowed'
                    : ''
                }
              >
                {isLoading() ? 'Updating...' : 'Update Project'}
              </Button>
              <Button as={Link} href="/projects" variant="outline">
                Cancel
              </Button>
            </div>
          </form>
        </div>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/edit')({
  component: EditProject,
})
