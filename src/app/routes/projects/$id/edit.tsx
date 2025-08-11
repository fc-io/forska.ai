import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createResource, createSignal, For, Show} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../../components/ui/button'
import {apiClient} from '../../../../services/apiClient'
import type {Tables} from '../../../../types/database.types'

type PromptItem = {
  id: string
  project_id: string
  original_text: string
  prompt_heading: string
  type: string
  isExisting: boolean // Track if this is an existing prompt or new one
  originalId?: string // Store the database ID for existing prompts
  order: number
}

type ProjectData = Pick<
  Tables<'projects'>,
  'id' | 'name' | 'description' | 'owner_id'
>
type PromptData = Pick<
  Tables<'prompts'>,
  | 'id'
  | 'original_text'
  | 'transformed_text'
  | 'prompt_heading'
  | 'type'
  | 'project_id'
  | 'archived'
  | 'created_at'
  | 'order'
>

const EditProject = () => {
  const navigate = useNavigate()
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id

  // Fetch project data and prompts simultaneously
  const [projectData] = createResource(() => {
    return Promise.all([
      fetchProject(projectId),
      fetchProjectPrompts(projectId),
    ]).then(([project, prompts]) => {
      return {project, prompts}
    })
  })

  const [projectName, setProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [prompts, setPrompts] = createStore<PromptItem[]>([])
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  createEffect(() => {
    const data = projectData()
    if (!data) return

    const {project, prompts: existingPrompts} = data

    if (project) {
      setProjectName(project.name)
      setDescription(project.description || '')
    }

    if (existingPrompts && existingPrompts.length > 0) {
      const formattedPrompts: PromptItem[] = existingPrompts.map((prompt) => {
        const {original_text, prompt_heading, type} = prompt

        return {
          id: crypto.randomUUID(),
          original_text,
          prompt_heading: prompt_heading || '',
          type: type || '',
          isExisting: true,
          originalId: prompt.id,
          order: prompt.order,
          project_id: prompt.project_id,
        }
      })
      setPrompts(formattedPrompts)
    } else {
      // Add one empty prompt if no existing prompts
      setPrompts([
        {
          id: crypto.randomUUID(),
          original_text: '',
          prompt_heading: '',
          type: '',
          isExisting: false,
          order: 1,
          project_id: projectId,
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
        original_text: '',
        prompt_heading: '',
        type: '',
        isExisting: false,
        order: newOrder,
        project_id: projectId,
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

  const updatePromptInput = (id: string, field: 'original_text' | 'prompt_heading' | 'type', value: string) => {
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
      await updateProject(projectId, projectName(), description(), prompts)
      void navigate({to: '/projects'})
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

      <Show when={projectData.loading}>
        <div class="text-center py-8">Loading project data...</div>
      </Show>

      <Show when={Boolean(projectData.error)}>
        <div class="text-center py-8 text-red-600">
          Error loading project:{' '}
          {(projectData.error as Error)?.message || 'Unknown error'}
        </div>
      </Show>

      <Show when={projectData() && !projectData.loading}>
        <div class="bg-card border rounded-lg p-6">
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
                class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                required
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
                class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none"
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
                            value={promptItem.prompt_heading}
                            onInput={(e) => {
                              return updatePromptInput(
                                promptItem.id,
                                'prompt_heading',
                                e.currentTarget.value,
                              )
                            }}
                            placeholder={`Prompt ${index() + 1} heading (optional)...`}
                            class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
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
                            class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                          />
                          <textarea
                            value={promptItem.original_text}
                            onInput={(e) => {
                              return updatePromptInput(
                                promptItem.id,
                                'original_text',
                                e.currentTarget.value,
                              )
                            }}
                            placeholder={`Enter prompt ${index() + 1} content...`}
                            rows="4"
                            class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none"
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
                            class="self-start mt-1"
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
                disabled={!projectName().trim() || isLoading()}
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

const fetchProject = async (id: string): Promise<ProjectData> => {
  const response = await apiClient.api.projects[id].get()

  if (response.error) {
    console.error('Error fetching project:', response.error)
    throw new Error('Failed to fetch project')
  }

  if (response.data?.error) {
    throw new Error(response.data.error)
  }

  if (!response.data?.data?.project) {
    throw new Error('Project not found')
  }

  const project = response.data.data.project
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    owner_id: project.ownerId,
  }
}

const fetchProjectPrompts = async (
  projectId: string,
): Promise<PromptData[]> => {
  const response = await apiClient.api.projects[projectId].get()

  if (response.error) {
    console.error('Error fetching project prompts:', response.error)
    throw new Error('Failed to fetch project prompts')
  }

  if (response.data?.error) {
    throw new Error(response.data.error)
  }

  if (!response.data?.data?.prompts) {
    return []
  }

  return response.data.data.prompts.map((p) => {
    return {
      id: p.id,
      original_text: p.originalText,
      transformed_text: p.transformedText,
      prompt_heading: p.promptHeading,
      type: p.type,
      project_id: p.projectId,
      archived: p.archived,
      created_at: p.createdAt,
      order: p.order || 0,
    }
  })
}

const updateProject = async (
  projectId: string,
  name: string,
  description: string,
  promptItems: PromptItem[],
): Promise<void> => {
  try {
    // Update project details
    const projectResponse = await apiClient.api.projects[projectId].patch({
      name,
      description: description || null,
    })

    if (projectResponse.error || projectResponse.data?.error) {
      console.error(
        'Error updating project:',
        projectResponse.error || projectResponse.data?.error,
      )
      throw new Error('Failed to update project')
    }

    // For now, we'll handle prompts updates separately
    // This would ideally be handled in a single transaction on the server
    // You can extend the server route to handle prompt updates along with project updates
  } catch (err) {
    console.error('Error updating project:', err)
    throw err
  }
}

export const Route = createFileRoute('/projects/$id/edit')({
  component: EditProject,
})
