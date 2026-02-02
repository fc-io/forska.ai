import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, For, Show, Suspense} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../components/ui/button'
import {apiClient} from '../../../services/apiClient'
import {fetchSession} from '../../../services/fetchSession'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

type PromptItem = {id: string; content: string; promptHeading: string; type: string}

type ExistingPrompt = {
  id: string
  originalText: string
  promptHeading: string | null
  type: string | null
  createdAt: string | null
  enabled: boolean
}

type ExistingPromptsResponse = {
  data: Array<{
    id: string
    originalText: string
    promptHeading: string | null
    type: string | null
    createdAt: Date | string | null
  }>
}

type ParsedDateResult = {date: Date | null; normalized: string | null; error: string | null}

type ImportRouteOption = {route: string; name: string | null}

type ImportRoutesResponse = {data: ImportRouteOption[]}

type ModelOption = {id: string; name: string; provider: string | null; modelName: string | null}
type ModelsResponse = {data: ModelOption[]}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

const parseDateInput = (value: string): ParsedDateResult => {
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return {date: null, normalized: null, error: null}
  }
  const matchesPattern = isoDatePattern.exec(trimmedValue)
  if (!matchesPattern) {
    return {date: null, normalized: null, error: 'Dates must use the YYYY-MM-DD format'}
  }
  const parsedDate = new Date(`${trimmedValue}T00:00:00.000Z`)
  if (Number.isNaN(parsedDate.getTime())) {
    return {date: null, normalized: null, error: 'Invalid date provided'}
  }
  return {date: parsedDate, normalized: trimmedValue, error: null}
}

const CreateProject = () => {
  const sessionQuery = useQuery(() => {
    return {
      queryKey: ['session'],
      queryFn: fetchSession,
      staleTime: 1000 * 60 * 5, // Consider data fresh for 5 minutes
    }
  })
  const importRoutesQuery = useQuery(() => {
    return {
      queryKey: ['importroutes'],
      queryFn: async () => {
        const response = await apiClient.api['import-routes'].get()
        const result = handleApiResponse<ImportRoutesResponse>(response, 'Failed to load import routes')
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
        const result = handleApiResponse<ModelsResponse>(response, 'Failed to load models')
        return result.data ?? []
      },
      staleTime: 1000 * 60 * 5,
    }
  })
  const existingPromptsQuery = useQuery(() => {
    return {
      queryKey: ['prompts'],
      queryFn: async () => {
        const response = await apiClient.api.prompts.get()
        const result = handleApiResponse<ExistingPromptsResponse>(response, 'Failed to load existing prompts')
        return result.data ?? []
      },
      staleTime: 1000 * 60 * 5,
    }
  })
  const createDefaultModel = async () => {
    await apiClient.api.judgments.model.get()
    await modelsQuery.refetch()
  }
  const navigate = useNavigate()
  const [projectName, setProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [selectedModelId, setSelectedModelId] = createSignal('')
  const [dateFrom, setDateFrom] = createSignal('')
  const [dateTo, setDateTo] = createSignal('')
  const [prompts, setPrompts] = createStore<PromptItem[]>([
    {id: crypto.randomUUID(), content: '', promptHeading: '', type: ''},
  ])
  const [existingPrompts, setExistingPrompts] = createStore<ExistingPrompt[]>([])
  const [selectedImportRoutes, setSelectedImportRoutes] = createSignal<string[]>([])
  const [useTitle, setUseTitle] = createSignal(true)
  const [useAbstract, setUseAbstract] = createSignal(true)
  const [useFulltext, setUseFulltext] = createSignal(false)
  const [useFulltextNoImages, setUseFulltextNoImages] = createSignal(false)
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const availableImportRoutes = () => {
    return importRoutesQuery.data ?? []
  }

  const availableModels = () => {
    const models = modelsQuery.data ?? []
    return [...models].sort((a, b) => {
      return a.name.localeCompare(b.name)
    })
  }

  createEffect(() => {
    const models = availableModels()
    const firstModel = models[0]
    if (firstModel && !selectedModelId()) {
      setSelectedModelId(firstModel.id)
    }
  })

  createEffect(() => {
    const data = existingPromptsQuery.data
    if (data && existingPrompts.length === 0) {
      setExistingPrompts(
        data.map((p) => {
          return {
            id: p.id,
            originalText: p.originalText,
            promptHeading: p.promptHeading,
            type: p.type,
            createdAt: p.createdAt ? String(p.createdAt) : null,
            enabled: false,
          }
        }),
      )
    }
  })

  const sortedExistingPrompts = createMemo(() => {
    return existingPrompts.slice().sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return dateB - dateA
    })
  })

  const toggleExistingPromptEnabled = (promptId: string) => {
    const idx = existingPrompts.findIndex((p) => {
      return p.id === promptId
    })
    const item = existingPrompts[idx]
    if (idx >= 0 && item) {
      setExistingPrompts(idx, 'enabled', !item.enabled)
    }
  }

  const addPromptInput = () => {
    setPrompts([...prompts, {id: crypto.randomUUID(), content: '', promptHeading: '', type: ''}])
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

  const updatePromptInput = (id: string, field: 'content' | 'promptHeading' | 'type', value: string) => {
    const idx = prompts.findIndex((p) => {
      return p.id === id
    })
    if (idx >= 0) {
      setPrompts(idx, field, value)
    }
  }

  const toggleImportRouteSelection = (route: string) => {
    setSelectedImportRoutes((current) => {
      const has = current.includes(route)
      return has
        ? current.filter((v) => {
            return v !== route
          })
        : [...current, route]
    })
  }

  const createProject = async (
    name: string,
    description: string,
    modelId: string,
    promptItems: PromptItem[],
    selectedExistingPrompts: ExistingPrompt[],
    importRoutes: string[],
    startDate?: string,
    endDate?: string,
  ) => {
    // Filter valid new prompts
    const validPrompts = promptItems
      .filter((prompt) => {
        return prompt.content.trim()
      })
      .map((prompt, index) => {
        return {
          content: prompt.content.trim(),
          promptHeading: prompt.promptHeading.trim() || undefined,
          type: prompt.type.trim() || undefined,
          order: index,
        }
      })

    // Filter enabled existing prompts
    const enabledExistingPrompts = selectedExistingPrompts
      .filter((p) => {
        return p.enabled
      })
      .map((p, index) => {
        return {originalId: p.id, order: validPrompts.length + index}
      })

    if (!sessionQuery.data?.user.id) {
      throw new Error('User must be authenticated to create a project')
    }

    const response = await apiClient.api.projects.post({
      name,
      description: description.trim() || undefined,
      ownerId: sessionQuery.data.user.id,
      modelId,
      prompts: validPrompts,
      existingPromptIds: enabledExistingPrompts,
      dateFrom: startDate,
      dateTo: endDate,
      importRoutes: importRoutes.length > 0 ? Array.from(new Set(importRoutes)) : undefined,
      useTitle: useTitle(),
      useAbstract: useAbstract(),
      useFulltext: useFulltext(),
      useFulltextNoImages: useFulltextNoImages(),
    })

    const result = handleApiResponse(response, 'Failed to create project')
    if (!result.data) {
      throw new Error('Failed to create project: No data returned')
    }
    return result.data
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault()

    setError(null)

    const startDateResult = parseDateInput(dateFrom())
    if (startDateResult.error) {
      setError(startDateResult.error)
      return
    }

    const endDateResult = parseDateInput(dateTo())
    if (endDateResult.error) {
      setError(endDateResult.error)
      return
    }

    if (startDateResult.date && endDateResult.date && startDateResult.date > endDateResult.date) {
      setError('Start date must be on or before the end date')
      return
    }

    setIsLoading(true)

    try {
      if (!selectedModelId()) {
        setError('Please select a model for this project')
        setIsLoading(false)
        return
      }

      await createProject(
        projectName(),
        description(),
        selectedModelId(),
        prompts,
        existingPrompts,
        selectedImportRoutes(),
        startDateResult.normalized ?? undefined,
        endDateResult.normalized ?? undefined,
      )
      // Navigate back to projects page on success
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
        <h1 class="text-3xl font-bold">Create New Project</h1>
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
                <div class="flex items-center justify-between gap-3">
                  <p class="text-sm text-muted-foreground">No models available.</p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      return void createDefaultModel()
                    }}
                  >
                    Create default model
                  </Button>
                </div>
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
              <p class="block text-sm font-medium mb-2">Project Timeline</p>
              <div class="grid grid-cols-2 gap-4">
                <label class="flex flex-col text-sm font-medium gap-1">
                  <span>Start Date</span>
                  <input
                    type="text"
                    value={dateFrom()}
                    onInput={(e) => {
                      return setDateFrom(e.currentTarget.value)
                    }}
                    placeholder="YYYY-MM-DD"
                    class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                  />
                </label>
                <label class="flex flex-col text-sm font-medium gap-1">
                  <span>End Date</span>
                  <input
                    type="text"
                    value={dateTo()}
                    onInput={(e) => {
                      return setDateTo(e.currentTarget.value)
                    }}
                    placeholder="YYYY-MM-DD"
                    class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                  />
                </label>
              </div>
            </div>

            <div>
              <p class="block text-sm font-medium mb-2">Import Routes</p>
              <Show when={importRoutesQuery.isLoading}>
                <p class="text-sm text-muted-foreground">Loading import routes...</p>
              </Show>
              <Show when={importRoutesQuery.isError}>
                <p class="text-sm text-red-600">
                  {importRoutesQuery.error instanceof Error
                    ? importRoutesQuery.error.message
                    : 'Failed to load import routes'}
                </p>
              </Show>
              <Show
                when={
                  !importRoutesQuery.isLoading && !importRoutesQuery.isError && availableImportRoutes().length === 0
                }
              >
                <p class="text-sm text-muted-foreground">No import routes available.</p>
              </Show>
              <Show
                when={!importRoutesQuery.isLoading && !importRoutesQuery.isError && availableImportRoutes().length > 0}
              >
                <div class="space-y-2">
                  <For each={availableImportRoutes()}>
                    {(r) => {
                      const name = r.name?.trim() ?? ''
                      const displayName = name ? name : r.route
                      const showRouteHint = Boolean(name) && name !== r.route
                      return (
                        <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer">
                          <input
                            type="checkbox"
                            class="mt-1"
                            checked={selectedImportRoutes().includes(r.route)}
                            onChange={() => {
                              return toggleImportRouteSelection(r.route)
                            }}
                          />
                          <div class="flex-1">
                            <p class="text-sm font-medium text-gray-900">{displayName}</p>
                            <Show when={showRouteHint}>
                              <p class="text-xs text-gray-600 font-mono break-all">{r.route}</p>
                            </Show>
                          </div>
                        </label>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </div>

            <div>
              <p class="block text-sm font-medium mb-2">Article Content Used</p>
              <div class="space-y-2">
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={useTitle()}
                    onChange={(e) => {
                      return setUseTitle(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Use Article Title</p>
                  </div>
                </label>
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={useAbstract()}
                    onChange={(e) => {
                      return setUseAbstract(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Use Article Abstract</p>
                  </div>
                </label>
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={useFulltext()}
                    onChange={(e) => {
                      const checked = e.currentTarget.checked
                      setUseFulltext(checked)
                      // Mutual exclusivity: uncheck the other if this is checked
                      if (checked) setUseFulltextNoImages(false)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Use Full Text (with images)</p>
                    <p class="text-xs text-gray-500 mt-0.5">
                      Include the complete article text including embedded images
                    </p>
                  </div>
                </label>
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={useFulltextNoImages()}
                    onChange={(e) => {
                      const checked = e.currentTarget.checked
                      setUseFulltextNoImages(checked)
                      // Mutual exclusivity: uncheck the other if this is checked
                      if (checked) setUseFulltext(false)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Use Full Text (without images)</p>
                    <p class="text-xs text-gray-500 mt-0.5">
                      Include article text but strip embedded base64 images to reduce token usage
                    </p>
                  </div>
                </label>
              </div>
            </div>

            <div>
              <div class="flex items-center justify-between mb-2">
                <label class="block text-sm font-medium">Prompts</label>
                <Button type="button" variant="outline" size="sm" onClick={addPromptInput}>
                  + Add Prompt
                </Button>
              </div>
              <div class="space-y-3">
                <For each={prompts} fallback={<div>No prompts</div>}>
                  {(promptItem, index) => {
                    return (
                      <div class="flex gap-2">
                        <div class="flex-1 space-y-2">
                          <input
                            type="text"
                            value={promptItem.promptHeading}
                            onInput={(e) => {
                              return updatePromptInput(promptItem.id, 'promptHeading', e.currentTarget.value)
                            }}
                            placeholder={`Prompt ${index() + 1} heading (optional)...`}
                            class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                          />
                          <input
                            type="text"
                            value={promptItem.type}
                            onInput={(e) => {
                              return updatePromptInput(promptItem.id, 'type', e.currentTarget.value)
                            }}
                            placeholder={`Prompt ${index() + 1} type (optional)...`}
                            class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                          />
                          <textarea
                            value={promptItem.content}
                            onInput={(e) => {
                              return updatePromptInput(promptItem.id, 'content', e.currentTarget.value)
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

            <Show when={sortedExistingPrompts().length > 0}>
              <div>
                <div class="flex items-center justify-between mb-2">
                  <label class="block text-sm font-medium">Existing Prompts</label>
                  <span class="text-xs text-muted-foreground">
                    {
                      sortedExistingPrompts().filter((p) => {
                        return p.enabled
                      }).length
                    }{' '}
                    of {sortedExistingPrompts().length} selected
                  </span>
                </div>
                <div class="space-y-3">
                  <For each={sortedExistingPrompts()}>
                    {(promptItem) => {
                      return (
                        <div
                          class="border rounded-lg p-4 bg-background"
                          classList={{'opacity-40': !promptItem.enabled}}
                        >
                          <div class="flex justify-between items-start mb-3">
                            <div class="flex items-center gap-2 flex-wrap">
                              <Show when={promptItem.promptHeading}>
                                <span class="font-medium">{promptItem.promptHeading}</span>
                              </Show>
                              <Show when={promptItem.type}>
                                <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                  {promptItem.type}
                                </span>
                              </Show>
                              <Show when={promptItem.createdAt}>
                                <span class="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium bg-gray-50 text-gray-600">
                                  Created: {new Date(promptItem.createdAt as string).toLocaleDateString()}
                                </span>
                              </Show>
                              <Show when={promptItem.enabled}>
                                <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                  Selected
                                </span>
                              </Show>
                            </div>
                            <label class="flex items-center gap-2">
                              <input
                                type="checkbox"
                                class="mt-0.5"
                                checked={promptItem.enabled}
                                onChange={() => {
                                  return toggleExistingPromptEnabled(promptItem.id)
                                }}
                              />
                              <span class="text-sm">Include</span>
                            </label>
                          </div>

                          <div class="space-y-3">
                            <Show when={promptItem.promptHeading}>
                              <div>
                                <label class="text-sm font-medium text-muted-foreground block mb-1">Heading</label>
                                <div class="bg-gray-50 rounded p-3 text-sm whitespace-pre-wrap">
                                  {promptItem.promptHeading}
                                </div>
                              </div>
                            </Show>
                            <Show when={promptItem.type}>
                              <div>
                                <label class="text-sm font-medium text-muted-foreground block mb-1">Type</label>
                                <div class="bg-gray-50 rounded p-3 text-sm whitespace-pre-wrap">{promptItem.type}</div>
                              </div>
                            </Show>
                            <div>
                              <label class="text-sm font-medium text-muted-foreground block mb-1">Prompt Text</label>
                              <div class="bg-gray-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">
                                {promptItem.originalText}
                              </div>
                            </div>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={existingPromptsQuery.isLoading}>
              <div class="text-sm text-muted-foreground">Loading existing prompts...</div>
            </Show>

            <div class="flex gap-3 pt-4">
              <Button type="submit" disabled={!projectName().trim() || isLoading()}>
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

export const Route = createFileRoute('/projects/create')({component: CreateProject})
