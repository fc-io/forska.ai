import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createResource, createSignal, For, Show} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../../components/ui/button'
import type {Tables} from '../../../../types/database.types'
import {getSupabaseClient} from '../../../../utils/getSupabaseClient'

type PromptItem = {
  id: string
  project_id: string
  original_text: string
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
        const {original_text} = prompt

        return {
          id: crypto.randomUUID(),
          original_text,
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

  const updatePromptInput = (id: string, value: string) => {
    const idx = prompts.findIndex((p) => {
      return p.id === id
    })
    if (idx >= 0) {
      setPrompts(idx, 'original_text', value)
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
          {error() && (
            <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
              {error()}
            </div>
          )}

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
                        <div class="flex-1">
                          <textarea
                            value={promptItem.original_text}
                            onInput={(e) => {
                              return updatePromptInput(
                                promptItem.id,
                                e.currentTarget.value,
                              )
                            }}
                            placeholder={`Enter prompt ${index() + 1} content...`}
                            rows="4"
                            class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none"
                          />
                        </div>
                        {prompts.length > 1 && (
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
                        )}
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
  const supabase = getSupabaseClient()
  const {data, error} = await supabase
    .from('projects')
    .select('id, name, description, owner_id')
    .eq('id', id)
    .single()

  if (error) {
    console.error('Error fetching project:', error)
    throw new Error(`Failed to fetch project: ${error.message}`)
  }

  if (!data) {
    throw new Error('Project not found')
  }

  const project = data as Tables<'projects'>
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    owner_id: project.owner_id,
  }
}

const fetchProjectPrompts = async (
  projectId: string,
): Promise<PromptData[]> => {
  const supabase = getSupabaseClient()
  const {data, error} = await supabase
    .from('prompts')
    .select(
      'id, original_text, transformed_text, project_id, archived, created_at, order',
    )
    .eq('project_id', projectId)
    .eq('archived', false)
    .order('created_at', {ascending: true})

  if (error) {
    console.error('Error fetching project prompts:', error)
    throw new Error(`Failed to fetch project prompts: ${error.message}`)
  }

  return (data as Tables<'prompts'>[]) || []
}

const updateProject = async (
  projectId: string,
  name: string,
  description: string,
  promptItems: PromptItem[],
): Promise<void> => {
  const supabase = getSupabaseClient()

  try {
    // Start a transaction-like operation by updating project first
    const {error: projectError} = await supabase
      .from('projects')
      .update({name, description, updated_at: new Date().toISOString()})
      .eq('id', projectId)

    if (projectError) {
      console.error('Error updating project:', projectError)
      throw new Error(`Failed to update project: ${projectError.message}`)
    }

    // Get existing prompts (including their original text to check for changes)
    const {data: existingPrompts, error: fetchError} = await supabase
      .from('prompts')
      .select('id, original_text')
      .eq('project_id', projectId)
      .eq('archived', false)

    if (fetchError) {
      console.error('Error fetching existing prompts:', fetchError)
      throw new Error(`Failed to fetch existing prompts: ${fetchError.message}`)
    }

    // const keepPromptIds = promptItems
    //   .filter((p) => {
    //     return p.isExisting && p.originalId
    //   })
    //   .map((p) => {
    //     return p.originalId
    //   })
    //   .filter((id): id is string => {
    //     return id !== undefined
    //   })
    // Archive removed prompts
    const promptsToArchive = (existingPrompts || []).filter((p) => {
      const input = promptItems.find((item) => {
        return item.originalId === p.id
      })
      return p.original_text !== input?.original_text
    })

    const promptsToArchiveIds = promptsToArchive.map((p) => {
      return p.id as string
    })
    if (promptsToArchiveIds.length > 0) {
      console.log('promptsToArchive', promptsToArchive)
      const {error: archiveError} = await supabase
        .from('prompts')
        .update({archived: true})
        .in('id', promptsToArchiveIds)
      // .select('id, archived') // force the server to return the rows
      // .throwOnError()
      if (archiveError) {
        console.error('Error archiving prompts:', archiveError)
        throw new Error(`Failed to archive prompts: ${archiveError.message}`)
      }
      const updatedPrompts = promptsToArchive
        .map((p) => {
          return promptItems.find((item) => {
            return item.originalId === p.id
          })
        })
        .filter((input) => {
          return input !== undefined
        })
        .map((input) => {
          return {
            project_id: input.project_id,
            order: input.order,
            original_text: input.original_text,
          }
        })
      const {error: insertError} = await supabase
        .from('prompts')
        .insert(updatedPrompts)

      if (insertError) {
        console.error('Error inserting new prompts:', insertError)
        throw new Error(`Failed to insert new prompts: ${insertError.message}`)
      }
    }

    // Insert completely new prompts
    const newPrompts = promptItems.filter((p) => {
      return !p.isExisting
    })

    if (newPrompts.length > 0) {
      const promptsToInsert = newPrompts.map((p) => {
        return {
          original_text: p.original_text,
          project_id: projectId,
          archived: false,
        }
      })

      const {error: insertError} = await supabase
        .from('prompts')
        .insert(promptsToInsert)

      if (insertError) {
        console.error('Error inserting new prompts:', insertError)
        throw new Error(`Failed to insert new prompts: ${insertError.message}`)
      }
    }
  } catch (err) {
    console.error('Error updating project:', err)
    throw err
  }
}

export const Route = createFileRoute('/projects/$id/edit')({
  component: EditProject,
})
