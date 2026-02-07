import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createSignal, For, Show, Suspense} from 'solid-js'

import {Button} from '../../../components/ui/button'
import {apiClient} from '../../../services/apiClient'
import {fetchSession} from '../../../services/fetchSession'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

type PromptInfo = {id: string; promptHeading: string | null; originalText: string; type: string | null}

type ProjectSource = {
  id: string
  name: string
  description: string | null
  modelId: string
  modelName: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  prompts: PromptInfo[]
}

type SourcesResponse = {data: ProjectSource[]}

type ModelOption = {id: string; name: string; provider: string | null; modelName: string | null}
type ModelsResponse = {data: ModelOption[]}

// Parse arktype definition like "'yes' | 'no' | 'unsure' | 'potentially' | 'marginally'" into array
const parseArktypeOptions = (typeStr: string | null): string[] => {
  if (!typeStr) return []

  // Match quoted strings: 'value' or "value"
  const matches = typeStr.match(/['"]([^'"]+)['"]/g)
  if (!matches) return []

  return matches.map((m) => {
    return m.slice(1, -1) // Remove quotes
  })
}

const formatContentSettings = (project: ProjectSource): string => {
  const parts: string[] = []
  if (project.useTitle) parts.push('title')
  if (project.useAbstract) parts.push('abstract')
  if (project.useFulltext) parts.push('fulltext')
  if (project.useFulltextNoImages) parts.push('fulltext (no images)')
  return parts.length > 0 ? parts.join(' + ') : 'none'
}

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
  // Map of promptId -> selected answer types
  const [promptAnswerTypes, setPromptAnswerTypes] = createSignal<Record<string, string[]>>({})
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [dateFrom, setDateFrom] = createSignal('')
  const [dateTo, setDateTo] = createSignal('')

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
        const newAnswerTypes = {...promptAnswerTypes()}
        const project = sourcesQuery.data?.find((p) => {
          return p.id === projectId
        })
        if (project) {
          for (const prompt of project.prompts) {
            delete newAnswerTypes[prompt.id]
          }
        }
        setPromptAnswerTypes(newAnswerTypes)
        return current.filter((v) => {
          return v !== projectId
        })
      }
      return [...current, projectId]
    })
  }

  // Get unique prompts from selected projects (deduplicated by id)
  const availablePrompts = () => {
    const promptMap = new Map<string, PromptInfo & {projectIds: string[]; options: string[]}>()
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
            promptMap.set(prompt.id, {...prompt, projectIds: [projectId], options: parseArktypeOptions(prompt.type)})
          }
        }
      }
    }
    return Array.from(promptMap.values())
  }

  const toggleAnswerType = (promptId: string, answerType: string) => {
    setPromptAnswerTypes((current) => {
      const currentTypes = current[promptId] || []
      const has = currentTypes.includes(answerType)
      if (has) {
        const newTypes = currentTypes.filter((t) => {
          return t !== answerType
        })
        if (newTypes.length === 0) {
          const {[promptId]: _, ...rest} = current
          return rest
        }
        return {...current, [promptId]: newTypes}
      }
      return {...current, [promptId]: [...currentTypes, answerType]}
    })
  }

  const isAnswerTypeSelected = (promptId: string, answerType: string) => {
    const types = promptAnswerTypes()[promptId] || []
    return types.includes(answerType)
  }

  const hasSelectedProjects = () => {
    return selectedProjects().length > 0
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

    if (!hasSelectedProjects()) {
      setError('Please select at least one source project')
      return
    }

    setIsLoading(true)

    try {
      // Build prompt selections from selected answer types
      const promptSelections = Object.entries(promptAnswerTypes()).map(([promptId, types]) => {
        return {promptId, types}
      })

      const response = await apiClient.api.subprojects.post({
        name: projectName(),
        description: description().trim() || undefined,
        ownerId: sessionQuery.data.user.id,
        modelId: selectedModelId(),
        dateFrom: dateFrom() || undefined,
        dateTo: dateTo() || undefined,
        promptSelections,
        sourceProjectIds: selectedProjects(),
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

            <div class="grid grid-cols-2 gap-4">
              <div>
                <label for="date-from" class="block text-sm font-medium mb-2">
                  Date From (optional)
                </label>
                <input
                  id="date-from"
                  type="date"
                  value={dateFrom()}
                  onInput={(e) => {
                    return setDateFrom(e.currentTarget.value)
                  }}
                  class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                />
              </div>
              <div>
                <label for="date-to" class="block text-sm font-medium mb-2">
                  Date To (optional)
                </label>
                <input
                  id="date-to"
                  type="date"
                  value={dateTo()}
                  onInput={(e) => {
                    return setDateTo(e.currentTarget.value)
                  }}
                  class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                />
              </div>
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
                <div class="space-y-2">
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
                            <Show when={project.modelName}>
                              <p class="text-xs text-muted-foreground mt-1">Model: {project.modelName}</p>
                            </Show>
                            <p class="text-xs text-muted-foreground mt-1">Content: {formatContentSettings(project)}</p>
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
                <p class="block text-sm font-medium mb-2">Select Prompts and Answer Types</p>
                <p class="text-xs text-muted-foreground mb-3">
                  For each prompt, select which answer types to filter by. Filters apply per source project (a prompt
                  only filters articles from projects that include it). Within a project, articles must match ALL
                  selected prompt/type combinations. Only judgments matching each source project's model and content
                  settings are considered.
                </p>
                <div class="space-y-4">
                  <For each={availablePrompts()}>
                    {(prompt) => {
                      return (
                        <div class="border border-input rounded-md p-4">
                          <div class="mb-3">
                            <p class="text-sm font-medium text-gray-900">{prompt.promptHeading || 'Untitled Prompt'}</p>
                            <Show when={prompt.originalText}>
                              <p class="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                                {prompt.originalText}
                              </p>
                            </Show>
                            <Show when={prompt.type}>
                              <p class="text-xs text-muted-foreground mt-1">Type: {prompt.type}</p>
                            </Show>
                          </div>
                          <Show when={prompt.options.length > 0}>
                            <div class="flex flex-col gap-2">
                              <For each={prompt.options}>
                                {(answerType) => {
                                  return (
                                    <label class="flex items-center gap-2 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={isAnswerTypeSelected(prompt.id, answerType)}
                                        onChange={() => {
                                          toggleAnswerType(prompt.id, answerType)
                                        }}
                                      />
                                      <span class="text-sm">{answerType}</span>
                                    </label>
                                  )
                                }}
                              </For>
                            </div>
                          </Show>
                          <Show when={prompt.options.length === 0}>
                            <p class="text-xs text-muted-foreground italic">No type options defined for this prompt</p>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </div>
            </Show>

            <div class="flex gap-3 pt-4">
              <Button type="submit" disabled={!projectName().trim() || !hasSelectedProjects() || isLoading()}>
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
