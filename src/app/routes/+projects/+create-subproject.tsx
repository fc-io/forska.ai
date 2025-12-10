import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createSignal, For, Show, Suspense} from 'solid-js'

import {Button} from '../../../components/ui/button'
import {apiClient} from '../../../services/apiClient'
import {fetchSession} from '../../../services/fetchSession'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

type PromptInfo = {id: string; promptHeading: string | null; type: string | null}

type ProjectSource = {id: string; name: string; description: string | null; prompts: PromptInfo[]}

type SourcesResponse = {data: ProjectSource[]}

type ModelOption = {id: string; name: string; provider: string | null; modelName: string | null}
type ModelsResponse = {data: ModelOption[]}

const CreateSubproject = () => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession, staleTime: 1000 * 60 * 5}
  })

  const sourcesQuery = useQuery(() => {
    return {
      queryKey: ['subproject-sources'],
      queryFn: async () => {
        const response = await apiClient.api.subprojects.sources.get()
        const result = handleApiResponse<SourcesResponse>(
          response as {data?: SourcesResponse; error?: unknown; status?: number},
          'Failed to load project sources',
        )
        return result.data ?? []
      },
      staleTime: 1000 * 60 * 5,
    }
  })

  const modelsQuery = useQuery(() => {
    return {
      queryKey: ['models'],
      queryFn: async () => {
        const response = await apiClient.api.models.get()
        const result = handleApiResponse<ModelsResponse>(
          response as {data?: ModelsResponse; error?: unknown; status?: number},
          'Failed to load models',
        )
        return result.data ?? []
      },
      staleTime: 1000 * 60 * 5,
    }
  })

  const navigate = useNavigate()
  const [projectName, setProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [selectedModelId, setSelectedModelId] = createSignal('')
  const [selectedProjects, setSelectedProjects] = createSignal<string[]>([])
  // Map of promptId -> selected (boolean, since each prompt has only one type)
  const [selectedPrompts, setSelectedPrompts] = createSignal<Set<string>>(new Set())
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const availableModels = () => {
    const models = modelsQuery.data ?? []
    return [...models].sort((a, b) => {
      return a.name.localeCompare(b.name)
    })
  }

  createEffect(() => {
    const models = availableModels()
    const firstModel = models[0]
    if (models.length > 0 && firstModel && !selectedModelId()) {
      setSelectedModelId(firstModel.id)
    }
  })

  const toggleProjectSelection = (projectId: string) => {
    setSelectedProjects((current) => {
      const has = current.includes(projectId)
      if (has) {
        // Remove project and its prompt selections
        const newSelectedPrompts = new Set(selectedPrompts())
        const project = sourcesQuery.data?.find((p) => {
          return p.id === projectId
        })
        if (project) {
          for (const prompt of project.prompts) {
            newSelectedPrompts.delete(prompt.id)
          }
        }
        setSelectedPrompts(newSelectedPrompts)
        return current.filter((v) => {
          return v !== projectId
        })
      }
      return [...current, projectId]
    })
  }

  // Get unique prompts from selected projects (deduplicated by id)
  const availablePrompts = () => {
    const promptMap = new Map<string, PromptInfo & {projectIds: string[]}>()
    for (const projectId of selectedProjects()) {
      const project = sourcesQuery.data?.find((p) => {
        return p.id === projectId
      })
      if (project) {
        for (const prompt of project.prompts) {
          if (promptMap.has(prompt.id)) {
            const existing = promptMap.get(prompt.id)
            if (existing) {
              existing.projectIds.push(projectId)
            }
          } else {
            promptMap.set(prompt.id, {...prompt, projectIds: [projectId]})
          }
        }
      }
    }
    return Array.from(promptMap.values())
  }

  const togglePromptSelection = (promptId: string) => {
    setSelectedPrompts((current) => {
      const newSet = new Set(current)
      if (newSet.has(promptId)) {
        newSet.delete(promptId)
      } else {
        newSet.add(promptId)
      }
      return newSet
    })
  }

  const isPromptSelected = (promptId: string) => {
    return selectedPrompts().has(promptId)
  }

  const hasAnySelections = () => {
    return selectedPrompts().size > 0
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    setError(null)

    if (!sessionQuery.data?.user.id) {
      setError('User must be authenticated to create a project')
      return
    }

    if (!selectedModelId()) {
      setError('Please select a model for this project')
      return
    }

    if (!hasAnySelections()) {
      setError('Please select at least one prompt')
      return
    }

    setIsLoading(true)

    try {
      // Build prompt selections from selected prompts
      // Each prompt has its type from the prompts table
      const promptSelections = Array.from(selectedPrompts()).map((promptId) => {
        const prompt = availablePrompts().find((p) => {
          return p.id === promptId
        })
        // Use the prompt's type if available, otherwise use empty array
        const types = prompt?.type ? [prompt.type] : []
        return {promptId, types}
      })

      const response = await apiClient.api.subprojects.post({
        name: projectName(),
        description: description().trim() || undefined,
        ownerId: sessionQuery.data.user.id,
        modelId: selectedModelId(),
        promptSelections,
      })

      const result = handleApiResponse(response, 'Failed to create subproject')
      if (!result.data) {
        throw new Error('Failed to create subproject: No data returned')
      }

      void navigate({to: '/projects'})
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred'
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <div class="flex items-center gap-4 mb-6">
        <Button as={Link} to="/projects" variant="outline" size="sm">
          ← Back to Projects
        </Button>
        <h1 class="text-3xl font-bold">Create New Subproject</h1>
      </div>

      <Suspense>
        <div class="bg-card border rounded-lg p-6">
          <Show when={error()}>
            <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">{error()}</div>
          </Show>
          <form
            onSubmit={(e) => {
              return void handleSubmit(e)
            }}
            class="space-y-6"
          >
            <div>
              <label for="model" class="block text-sm font-medium mb-2">
                Model *
              </label>
              <Show when={modelsQuery.isLoading}>
                <p class="text-sm text-muted-foreground">Loading models...</p>
              </Show>
              <Show when={modelsQuery.isError}>
                <p class="text-sm text-red-600">
                  {modelsQuery.error instanceof Error ? modelsQuery.error.message : 'Failed to load models'}
                </p>
              </Show>
              <Show when={!modelsQuery.isLoading && !modelsQuery.isError && availableModels().length > 0}>
                <select
                  id="model"
                  class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                  value={selectedModelId()}
                  onChange={(e) => {
                    return setSelectedModelId(e.currentTarget.value)
                  }}
                >
                  <For each={availableModels()}>
                    {(m) => {
                      return <option value={m.id}>{m.name}</option>
                    }}
                  </For>
                </select>
              </Show>
              <Show when={!modelsQuery.isLoading && !modelsQuery.isError && availableModels().length === 0}>
                <p class="text-sm text-muted-foreground">No models available.</p>
              </Show>
            </div>

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
              <p class="block text-sm font-medium mb-2">Import from Projects</p>
              <Show when={sourcesQuery.isLoading}>
                <p class="text-sm text-muted-foreground">Loading projects...</p>
              </Show>
              <Show when={sourcesQuery.isError}>
                <p class="text-sm text-red-600">
                  {sourcesQuery.error instanceof Error ? sourcesQuery.error.message : 'Failed to load projects'}
                </p>
              </Show>
              <Show when={!sourcesQuery.isLoading && !sourcesQuery.isError && (sourcesQuery.data?.length ?? 0) === 0}>
                <p class="text-sm text-muted-foreground">No projects with prompts available.</p>
              </Show>
              <Show when={!sourcesQuery.isLoading && !sourcesQuery.isError && (sourcesQuery.data?.length ?? 0) > 0}>
                <div class="space-y-2 max-h-64 overflow-y-auto">
                  <For each={sourcesQuery.data}>
                    {(project) => {
                      return (
                        <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                          <input
                            type="checkbox"
                            class="mt-1"
                            checked={selectedProjects().includes(project.id)}
                            onChange={() => {
                              return toggleProjectSelection(project.id)
                            }}
                          />
                          <div class="flex-1">
                            <p class="text-sm font-medium text-gray-900">{project.name}</p>
                            <Show when={project.description}>
                              <p class="text-xs text-muted-foreground mt-1">{project.description}</p>
                            </Show>
                            <p class="text-xs text-muted-foreground mt-1">
                              {project.prompts.length} prompt{project.prompts.length !== 1 ? 's' : ''}
                            </p>
                          </div>
                        </label>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </div>

            <Show when={selectedProjects().length > 0}>
              <div>
                <p class="block text-sm font-medium mb-2">Select Prompts</p>
                <div class="space-y-2">
                  <For each={availablePrompts()}>
                    {(prompt) => {
                      return (
                        <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                          <input
                            type="checkbox"
                            class="mt-1"
                            checked={isPromptSelected(prompt.id)}
                            onChange={() => {
                              return togglePromptSelection(prompt.id)
                            }}
                          />
                          <div class="flex-1">
                            <p class="text-sm font-medium text-gray-900">
                              {prompt.promptHeading || prompt.type || 'Untitled Prompt'}
                            </p>
                            <Show when={prompt.type}>
                              <p class="text-xs text-muted-foreground">Type: {prompt.type}</p>
                            </Show>
                          </div>
                        </label>
                      )
                    }}
                  </For>
                </div>
              </div>
            </Show>

            <div class="flex gap-3 pt-4">
              <Button type="submit" disabled={!projectName().trim() || !hasAnySelections() || isLoading()}>
                {isLoading() ? 'Creating...' : 'Create Project'}
              </Button>
              <Button as={Link} to="/projects" variant="outline">
                Cancel
              </Button>
            </div>
          </form>
        </div>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/projects/create-subproject')({component: CreateSubproject})
