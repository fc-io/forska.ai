import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import type {JSX} from 'solid-js'
import {createEffect, createMemo, createSignal, For, Show, Suspense} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../../components/ui/button'
import {apiClient} from '../../../../services/apiClient'
import {fetchProjectWithPrompts} from '../../../../services/projectsService'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse'

type PromptItem = {
  id: string
  originalText: string
  promptHeading: string
  type: string
  isExisting: boolean
  originalId?: string
  order: number
  archived: boolean
  enabled?: boolean
  originProjectId?: string | null
  createdAt?: Date | string | null
}

type ProjectPromptResponse = {
  id: string
  originalText: string
  promptHeading: string | null
  type: string | null
  order: number | null
  archived: boolean
  enabled?: boolean
  originProjectId?: string | null
  createdAt?: Date | string | null
}

type ProjectSummary = {
  name: string
  description: string | null
  dateFrom: string | Date | null
  dateTo: string | Date | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
}

type ModelOption = {id: string; name: string; provider: string | null; modelName: string | null}
type ModelsResponse = {data: ModelOption[]}
type ImportRoutesResponse = {data: string[]}

type ProjectDetailsResponse = {
  project: ProjectSummary
  prompts: ProjectPromptResponse[]
  hasJudgedArticles: boolean
  model?: {id: string; name: string; provider?: string | null; modelName?: string | null} | null
  importRoutes?: string[]
}

type ParsedDateResult = {date: Date | null; normalized: string | null; error: string | null}

type PromptPayload = {
  originalId?: string
  originalText: string
  promptHeading?: string
  type?: string
  order: number
  archived?: boolean
  enabled?: boolean
}

const isNullableString = (value: unknown): value is string | null => {
  return value === null || typeof value === 'string'
}

const isNullableStringOrDate = (value: unknown): value is string | Date | null => {
  return value === null || typeof value === 'string' || value instanceof Date
}

const isProjectSummary = (value: unknown): value is ProjectSummary => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const summary = value as Record<string, unknown>
  const name = summary.name
  const description = summary.description
  const dateFrom = summary.dateFrom
  const dateTo = summary.dateTo
  const useTitle = summary.useTitle
  const useAbstract = summary.useAbstract
  const useFulltext = summary.useFulltext
  const hasValidDates = isNullableStringOrDate(dateFrom) && isNullableStringOrDate(dateTo)
  return (
    typeof name === 'string'
    && isNullableString(description)
    && hasValidDates
    && typeof useTitle === 'boolean'
    && typeof useAbstract === 'boolean'
    && typeof useFulltext === 'boolean'
  )
}

const isProjectPromptResponse = (value: unknown): value is ProjectPromptResponse => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const prompt = value as Record<string, unknown>
  const id = prompt.id
  const originalText = prompt.originalText
  const promptHeading = prompt.promptHeading
  const type = prompt.type
  const order = prompt.order
  const archived = (value as any)?.archived
  const hasRequiredFields = typeof id === 'string' && typeof originalText === 'string'
  const hasOptionalFields =
    (promptHeading === null || typeof promptHeading === 'string')
    && (type === null || typeof type === 'string')
    && (order === null || typeof order === 'number')
    && (typeof archived === 'boolean' || archived === undefined)
  return hasRequiredFields && hasOptionalFields
}

const isProjectDetailsResponse = (value: unknown): value is ProjectDetailsResponse => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const details = value as Record<string, unknown>
  const project = details.project
  const prompts = details.prompts
  const hasJudgedArticles = details.hasJudgedArticles
  const model = details.model
  if (!isProjectSummary(project)) {
    return false
  }
  if (!Array.isArray(prompts) || !prompts.every(isProjectPromptResponse)) {
    return false
  }
  const isValidModel =
    model === undefined
    || model === null
    || (typeof model === 'object' && model !== null && typeof (model as {id?: unknown}).id === 'string')
  return typeof hasJudgedArticles === 'boolean' && isValidModel
}

const buildExistingPrompt = (prompt: ProjectPromptResponse): PromptItem => {
  return {
    id: crypto.randomUUID(),
    originalText: prompt.originalText,
    promptHeading: prompt.promptHeading ?? '',
    type: prompt.type ?? '',
    isExisting: true,
    originalId: prompt.id,
    order: prompt.order ?? 0,
    archived: Boolean(prompt.archived),
    enabled: typeof prompt.enabled === 'boolean' ? prompt.enabled : undefined,
    originProjectId: prompt.originProjectId ?? null,
    createdAt: prompt.createdAt ?? null,
  }
}

const buildEmptyPrompt = (order: number): PromptItem => {
  return {
    id: crypto.randomUUID(),
    originalText: '',
    promptHeading: '',
    type: '',
    isExisting: false,
    order,
    archived: false,
  }
}

const mapPromptsFromResponse = (promptList: ProjectPromptResponse[]): PromptItem[] => {
  return promptList.length === 0
    ? [buildEmptyPrompt(1)]
    : promptList.map((prompt) => {
        return buildExistingPrompt(prompt)
      })
}

const getHighestOrder = (items: PromptItem[], index = 0, currentMax = 0): number => {
  if (index >= items.length) {
    return currentMax
  }
  const item = items[index]
  if (!item) {
    return currentMax
  }
  const nextMax = item.order > currentMax ? item.order : currentMax
  return getHighestOrder(items, index + 1, nextMax)
}

const getNextOrder = (items: PromptItem[]): number => {
  return getHighestOrder(items) + 1
}

const buildPromptsPayload = (owned: PromptItem[], imported: PromptItem[]): PromptPayload[] => {
  const ownedPayload = owned
    .filter((prompt) => {
      return prompt.originalText.trim().length > 0
    })
    .map((prompt) => {
      return {
        originalId: prompt.originalId,
        originalText: prompt.originalText,
        promptHeading: prompt.promptHeading || undefined,
        type: prompt.type || undefined,
        order: prompt.order,
        archived: prompt.archived,
        enabled: prompt.enabled,
      }
    })

  const importedPayload = imported.map((prompt) => {
    return {
      originalId: prompt.originalId,
      originalText: prompt.originalText,
      // Preserve metadata for imported prompts so server doesn't null them
      promptHeading: prompt.promptHeading || undefined,
      type: prompt.type || undefined,
      order: prompt.order,
      enabled: prompt.enabled,
    }
  })

  return [...ownedPayload, ...importedPayload]
}

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

const formatDateForInput = (value: string | Date | null): string => {
  if (!value) {
    return ''
  }
  const stringValue = value instanceof Date ? value.toISOString() : value
  const isoDateMatch = isoDatePattern.exec(stringValue)
  if (isoDateMatch) {
    return isoDateMatch[0]
  }
  const parsedDate = new Date(stringValue)
  if (Number.isNaN(parsedDate.getTime())) {
    return ''
  }
  return parsedDate.toISOString().slice(0, 10)
}

const EditProject = (): JSX.Element => {
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const projectData = useQuery(() => {
    return {
      queryKey: ['project', projectId, 'with-prompts'],
      queryFn: () => {
        return fetchProjectWithPrompts(projectId)
      },
      // Disable auto-refetch on window focus since this is a form with user-editable state.
      // Otherwise, refetches would overwrite the user's local changes (e.g., enabled checkbox).
      refetchOnWindowFocus: false,
    }
  })

  const [projectName, setProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [ownedPrompts, setOwnedPrompts] = createStore<PromptItem[]>([])
  const [importedPrompts, setImportedPrompts] = createStore<PromptItem[]>([])
  const [dateFrom, setDateFrom] = createSignal('')
  const [dateTo, setDateTo] = createSignal('')
  const [isLoading, setIsLoading] = createSignal(false)
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)
  const [selectedModelId, setSelectedModelId] = createSignal('')
  const [selectedImportRoutes, setSelectedImportRoutes] = createSignal<string[]>([])
  const [useTitle, setUseTitle] = createSignal(true)
  const [useAbstract, setUseAbstract] = createSignal(true)
  const [useFulltext, setUseFulltext] = createSignal(false)

  // Track whether we've loaded initial data to avoid overwriting local changes on refetch
  let initialDataLoaded = false

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

  const importRoutesQuery = useQuery(() => {
    return {
      queryKey: ['importroutes'],
      queryFn: async () => {
        const response = await apiClient.api.importroutes.get()
        const result = handleApiResponse<ImportRoutesResponse>(response, 'Failed to load import routes')
        return result.data ?? []
      },
      staleTime: 1000 * 60 * 5,
    }
  })

  const createDefaultModel = async () => {
    await apiClient.api.judgments.model.get()
    await modelsQuery.refetch()
  }

  const availableModels = () => {
    const models = modelsQuery.data ?? []
    return [...models].sort((a, b) => {
      return a.name.localeCompare(b.name)
    })
  }

  const availableImportRoutes = () => {
    return importRoutesQuery.data ?? []
  }

  const projectDetails = createMemo(() => {
    const data = projectData.data
    return isProjectDetailsResponse(data) ? data : undefined
  })

  const isLocked = createMemo(() => {
    return Boolean(projectDetails()?.hasJudgedArticles)
  })

  const fieldStateClass = createMemo(() => {
    return isLocked() ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-not-allowed opacity-60' : 'border-input'
  })

  const actionStateClass = createMemo(() => {
    return isLocked() ? 'opacity-50 cursor-not-allowed' : ''
  })

  const sortedOwnedPrompts = createMemo(() => {
    return ownedPrompts.slice().sort((a, b) => {
      return a.order - b.order
    })
  })

  const sortedImportedPrompts = createMemo(() => {
    return importedPrompts.slice().sort((a, b) => {
      return a.order - b.order
    })
  })

  createEffect(() => {
    const details = projectDetails()
    if (details) {
      setProjectName(details.project.name)
      setDescription(details.project.description ?? '')
      setDateFrom(formatDateForInput(details.project.dateFrom))
      setDateTo(formatDateForInput(details.project.dateTo))
      const all = mapPromptsFromResponse(details.prompts)
      const owned = all.filter((p) => {
        return p.originProjectId === projectId
      })
      const imported = all.filter((p) => {
        return p.originProjectId !== projectId
      })
      setOwnedPrompts(owned.length > 0 ? owned : [buildEmptyPrompt(1)])

      // Only set importedPrompts on initial load to preserve user's local checkbox changes
      if (!initialDataLoaded) {
        setImportedPrompts(imported)
        initialDataLoaded = true
        console.log(
          'Importable prompts initial load',
          imported.map((p) => {
            return {order: p.order, heading: p.promptHeading, type: p.type, enabled: p.enabled}
          }),
        )
      }

      setUseTitle(details.project.useTitle)
      setUseAbstract(details.project.useAbstract)
      setUseFulltext(details.project.useFulltext)
      if (!selectedModelId() && details.model?.id) {
        setSelectedModelId(details.model.id)
      }
      const routes = Array.isArray(details.importRoutes) ? details.importRoutes : []
      setSelectedImportRoutes(routes)
    } else if (projectData.isSuccess) {
      setOwnedPrompts([buildEmptyPrompt(1)])
      if (!initialDataLoaded) {
        setImportedPrompts([])
      }
      setDateFrom('')
      setDateTo('')
    }
  })

  createEffect(() => {
    const models = availableModels()
    const firstId = models[0]?.id
    if (!selectedModelId() && firstId) {
      setSelectedModelId(firstId)
    }
  })

  const addPromptInput = () => {
    const next = ownedPrompts.slice()
    next.push(buildEmptyPrompt(ownedPrompts.length === 0 ? 1 : getNextOrder(ownedPrompts)))
    setOwnedPrompts(next)
  }

  const removePromptInput = (promptId: string) => {
    if (ownedPrompts.length > 1) {
      const next = ownedPrompts.slice().filter((prompt) => {
        return prompt.id !== promptId
      })
      setOwnedPrompts(next)
      return
    }
    setOwnedPrompts([buildEmptyPrompt(1)])
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

  const updatePromptInput = (
    promptId: string,
    field: 'originalText' | 'promptHeading' | 'type' | 'order' | 'archived',
    value: string | number | boolean,
  ) => {
    setOwnedPrompts(
      (prompt) => {
        return prompt.id === promptId
      },
      field as any,
      value as any,
    )
  }

  const toggleImportedPromptEnabled = (promptId: string) => {
    setImportedPrompts(
      (p) => {
        return p.id === promptId
      },
      'enabled' as any,
      (prev) => {
        return !prev as any
      },
    )
  }

  const sendUpdateRequest = async (startDate: string | null, endDate: string | null): Promise<void> => {
    const promptsPayload = buildPromptsPayload(ownedPrompts, importedPrompts)
    const response = await apiClient.api
      .projects({id: projectId})
      .edit.patch({
        name: projectName(),
        description: description() || null,
        prompts: promptsPayload,
        dateFrom: startDate,
        dateTo: endDate,
        modelId: selectedModelId() || undefined,
        importRoutes: selectedImportRoutes(),
        useTitle: useTitle(),
        useAbstract: useAbstract(),
        useFulltext: useFulltext(),
      })

    if (response.error || !response.data?.data) {
      throw new Error('Failed to update project')
    }

    const result = response.data.data
    setProjectName(result.project.name)
    setDescription(result.project.description ?? '')
    setDateFrom(formatDateForInput(result.project.dateFrom))
    setDateTo(formatDateForInput(result.project.dateTo))
    const all = mapPromptsFromResponse(result.prompts)
    const owned = all.filter((p) => {
      return p.originProjectId === projectId
    })
    const imported = all.filter((p) => {
      return p.originProjectId !== projectId
    })
    setOwnedPrompts(owned.length > 0 ? owned : [buildEmptyPrompt(1)])
    setImportedPrompts(imported)

    // Keep related caches in sync so subsequent views show fresh data immediately
    queryClient.setQueryData(['project', projectId, 'with-prompts'], (prev: unknown) => {
      const previous = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {}
      return {
        ...previous,
        project: result.project,
        prompts: result.prompts,
        hasJudgedArticles: previous.hasOwnProperty('hasJudgedArticles') ? previous.hasJudgedArticles : false,
        model: previous.hasOwnProperty('model') ? previous.model : null,
        importRoutes: Array.isArray(previous.importRoutes) ? previous.importRoutes : [],
      }
    })
    void queryClient.invalidateQueries({queryKey: ['project', projectId]})
    void queryClient.invalidateQueries({queryKey: ['projects']})
  }

  const handleSubmit = (event: SubmitEvent) => {
    event.preventDefault()
    setErrorMessage(null)

    const startDateResult = parseDateInput(dateFrom())
    if (startDateResult.error) {
      setErrorMessage(startDateResult.error)
      return
    }

    const endDateResult = parseDateInput(dateTo())
    if (endDateResult.error) {
      setErrorMessage(endDateResult.error)
      return
    }

    if (startDateResult.date && endDateResult.date && startDateResult.date > endDateResult.date) {
      setErrorMessage('Start date must be on or before the end date')
      return
    }

    setIsLoading(true)

    const onFulfilled = () => {
      setIsLoading(false)
      void navigate({to: '/projects'})
    }

    const onRejected = (error: unknown) => {
      const message = error instanceof Error ? error.message : 'An unexpected error occurred'
      setErrorMessage(message)
      setIsLoading(false)
    }

    void sendUpdateRequest(startDateResult.normalized ?? null, endDateResult.normalized ?? null).then(
      onFulfilled,
      onRejected,
    )
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <div class="flex items-center gap-4 mb-6">
        <Button as={Link} to="/projects" variant="outline" size="sm">
          ← Back to Projects
        </Button>
        <h1 class="text-3xl font-bold">Edit Project</h1>
      </div>

      <Suspense>
        <Show when={projectData.isLoading}>
          <div class="text-center py-8">Loading project data...</div>
        </Show>

        <Show when={Boolean(projectData.error)}>
          <div class="text-center py-8 text-red-600">
            Error loading project: {projectData.error instanceof Error ? projectData.error.message : 'Unknown error'}
          </div>
        </Show>

        <Show when={projectDetails()}>
          <div class="bg-card border rounded-lg p-6">
            <Show when={isLocked()}>
              <div class="mb-6 p-4 bg-amber-50 border-2 border-amber-300 rounded-lg">
                <div class="flex items-start gap-3">
                  <span class="text-amber-600 text-xl mt-0.5">⚠️</span>
                  <div>
                    <h3 class="font-semibold text-amber-900 mb-1">Project Locked for Editing</h3>
                    <p class="text-amber-800 text-sm">
                      This project cannot be modified because a judgment job exists for it. All fields and buttons have
                      been disabled to preserve the integrity of the running/finished job.
                    </p>
                  </div>
                </div>
              </div>
            </Show>
            <Show when={errorMessage()}>
              <div id="test" class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                {errorMessage()}
              </div>
            </Show>

            <form onSubmit={handleSubmit} class="space-y-6">
              <div>
                <label for="model" class="block text-sm font-medium mb-2">
                  Model
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
                    class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent ${fieldStateClass()}`}
                    value={selectedModelId()}
                    onChange={(event) => {
                      return setSelectedModelId(event.currentTarget.value)
                    }}
                    disabled={isLocked()}
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
                      disabled={isLocked()}
                      class={actionStateClass()}
                    >
                      Create default model
                    </Button>
                  </div>
                </Show>
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
                  when={
                    !importRoutesQuery.isLoading && !importRoutesQuery.isError && availableImportRoutes().length > 0
                  }
                >
                  <div class="space-y-2">
                    <For each={availableImportRoutes()}>
                      {(route) => {
                        return (
                          <label
                            class={`flex items-start gap-3 border rounded-md p-3 cursor-pointer ${isLocked() ? 'opacity-60' : 'border-input'}`}
                          >
                            <input
                              type="checkbox"
                              class="mt-1"
                              checked={selectedImportRoutes().includes(route)}
                              onChange={() => {
                                return toggleImportRouteSelection(route)
                              }}
                              disabled={isLocked()}
                            />
                            <div class="flex-1">
                              <p class="text-sm font-medium text-gray-900">
                                <span class="font-mono">{route}</span>
                              </p>
                            </div>
                          </label>
                        )
                      }}
                    </For>
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
                  onInput={(event) => {
                    return setProjectName(event.currentTarget.value)
                  }}
                  placeholder="Enter project name"
                  class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent ${fieldStateClass()}`}
                  required
                  disabled={isLocked()}
                />
              </div>

              <div>
                <label for="description" class="block text-sm font-medium mb-2">
                  Description
                </label>
                <textarea
                  id="description"
                  value={description()}
                  onInput={(event) => {
                    return setDescription(event.currentTarget.value)
                  }}
                  placeholder="Describe your project..."
                  rows="4"
                  class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none ${fieldStateClass()}`}
                  disabled={isLocked()}
                />
              </div>

              <div>
                <p class="block text-sm font-medium mb-2">Project Timeline</p>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label class={`flex flex-col text-sm font-medium gap-1 ${isLocked() ? 'opacity-60' : ''}`}>
                    <span>Start Date</span>
                    <input
                      type="text"
                      value={dateFrom()}
                      onInput={(event) => {
                        return setDateFrom(event.currentTarget.value)
                      }}
                      placeholder="YYYY-MM-DD"
                      class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent ${fieldStateClass()}`}
                      disabled={isLocked()}
                    />
                  </label>
                  <label class={`flex flex-col text-sm font-medium gap-1 ${isLocked() ? 'opacity-60' : ''}`}>
                    <span>End Date</span>
                    <input
                      type="text"
                      value={dateTo()}
                      onInput={(event) => {
                        return setDateTo(event.currentTarget.value)
                      }}
                      placeholder="YYYY-MM-DD"
                      class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent ${fieldStateClass()}`}
                      disabled={isLocked()}
                    />
                  </label>
                </div>
              </div>

              <div>
                <p class="block text-sm font-medium mb-2">Article Content Used</p>
                <div class="space-y-2">
                  <label
                    class={`flex items-start gap-3 border rounded-md p-3 cursor-pointer ${
                      isLocked() ? 'opacity-60' : 'border-input'
                    }`}
                  >
                    <input
                      type="checkbox"
                      class="mt-1"
                      checked={useTitle()}
                      onChange={(event) => {
                        return setUseTitle(event.currentTarget.checked)
                      }}
                      disabled={isLocked()}
                    />
                    <div class="flex-1">
                      <p class="text-sm font-medium text-gray-900">Use Article Title</p>
                    </div>
                  </label>
                  <label
                    class={`flex items-start gap-3 border rounded-md p-3 cursor-pointer ${
                      isLocked() ? 'opacity-60' : 'border-input'
                    }`}
                  >
                    <input
                      type="checkbox"
                      class="mt-1"
                      checked={useAbstract()}
                      onChange={(event) => {
                        return setUseAbstract(event.currentTarget.checked)
                      }}
                      disabled={isLocked()}
                    />
                    <div class="flex-1">
                      <p class="text-sm font-medium text-gray-900">Use Article Abstract</p>
                    </div>
                  </label>
                  <label
                    class={`flex items-start gap-3 border rounded-md p-3 cursor-pointer ${
                      isLocked() ? 'opacity-60' : 'border-input'
                    }`}
                  >
                    <input
                      type="checkbox"
                      class="mt-1"
                      checked={useFulltext()}
                      onChange={(event) => {
                        return setUseFulltext(event.currentTarget.checked)
                      }}
                      disabled={isLocked()}
                    />
                    <div class="flex-1">
                      <p class="text-sm font-medium text-gray-900">
                        Use the full text of the Article (less performant)
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              <div>
                <div class="flex items-center justify-between mb-2">
                  <label class="block text-sm font-medium">Your questions about the article</label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addPromptInput}
                    disabled={isLocked()}
                    class={actionStateClass()}
                  >
                    + Add Prompt
                  </Button>
                </div>
                <div class="space-y-3">
                  <For each={sortedOwnedPrompts()} fallback={<div>No prompts</div>}>
                    {(promptItem, index) => {
                      return (
                        <div class="flex gap-2">
                          <div class="flex-1 space-y-2">
                            <div class="text-[11px] text-gray-500">
                              {promptItem.originalId
                                ? `Prompt ID: ${String(promptItem.originalId).slice(0, 8)}`
                                : 'New prompt'}
                            </div>
                            <input
                              type="text"
                              value={promptItem.promptHeading}
                              onInput={(event) => {
                                return updatePromptInput(promptItem.id, 'promptHeading', event.currentTarget.value)
                              }}
                              placeholder={`Prompt ${index() + 1} heading (optional)...`}
                              class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent ${fieldStateClass()}`}
                              disabled={isLocked()}
                            />
                            <input
                              type="text"
                              value={promptItem.type}
                              onInput={(event) => {
                                return updatePromptInput(promptItem.id, 'type', event.currentTarget.value)
                              }}
                              placeholder={`Prompt ${index() + 1} type (optional)...`}
                              class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent ${fieldStateClass()}`}
                              disabled={isLocked()}
                            />
                            <textarea
                              value={promptItem.originalText}
                              onInput={(event) => {
                                return updatePromptInput(promptItem.id, 'originalText', event.currentTarget.value)
                              }}
                              placeholder={`Enter prompt ${index() + 1} content...`}
                              rows="4"
                              class={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none ${fieldStateClass()}`}
                              disabled={isLocked()}
                            />
                            <div class="flex items-center gap-4">
                              <label class="flex items-center gap-2 text-sm">
                                <span>Order</span>
                                <input
                                  type="number"
                                  class={`w-20 px-2 py-1 border rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent ${fieldStateClass()}`}
                                  value={promptItem.order}
                                  onInput={(e) => {
                                    const val = Number(e.currentTarget.value || 0)
                                    return updatePromptInput(promptItem.id, 'order', Number.isNaN(val) ? 0 : val)
                                  }}
                                  disabled={isLocked()}
                                />
                              </label>
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              return removePromptInput(promptItem.id)
                            }}
                            class={`self-start mt-1 ${actionStateClass()}`}
                            disabled={isLocked()}
                          >
                            ×
                          </Button>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </div>

              <Show when={sortedImportedPrompts().length > 0}>
                <div>
                  <div class="flex items-center justify-between mb-2">
                    <label class="block text-sm font-medium">Importable prompts</label>
                  </div>
                  <div class="space-y-3">
                    <For each={sortedImportedPrompts()}>
                      {(promptItem) => {
                        return (
                          <div
                            class="border rounded-lg p-4 bg-background"
                            classList={{'opacity-40': promptItem.enabled === false}}
                          >
                            <div class="flex justify-between items-start mb-3">
                              <div class="flex items-center gap-2">
                                <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                                  {promptItem.order}
                                </span>
                                <Show when={promptItem.promptHeading}>
                                  <span class="font-medium">{promptItem.promptHeading}</span>
                                </Show>
                                <Show when={promptItem.type}>
                                  <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                    {promptItem.type}
                                  </span>
                                </Show>
                                <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                                  Imported
                                </span>
                                <Show when={promptItem.originalId}>
                                  <span class="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium bg-gray-50 text-gray-600 font-mono">
                                    {promptItem.originalId}
                                  </span>
                                </Show>
                                <Show when={promptItem.createdAt}>
                                  <span class="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium bg-gray-50 text-gray-600">
                                    Created: {new Date(promptItem.createdAt as string | Date).toLocaleDateString()}
                                  </span>
                                </Show>
                                <Show when={promptItem.enabled !== undefined}>
                                  <span
                                    class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium"
                                    classList={{
                                      'bg-green-100 text-green-800': promptItem.enabled,
                                      'bg-gray-100 text-gray-800': !promptItem.enabled,
                                    }}
                                  >
                                    {promptItem.enabled ? 'Enabled' : 'Disabled'}
                                  </span>
                                </Show>
                              </div>
                              <label class={`flex items-center gap-2 ${isLocked() ? 'opacity-60' : ''}`}>
                                <input
                                  type="checkbox"
                                  class="mt-0.5"
                                  checked={Boolean(promptItem.enabled)}
                                  onChange={() => {
                                    return toggleImportedPromptEnabled(promptItem.id)
                                  }}
                                  disabled={isLocked()}
                                />
                                <span class="text-sm">Enabled</span>
                              </label>
                            </div>

                            <div class="space-y-3">
                              <div>
                                <label class="text-sm font-medium text-muted-foreground block mb-1">Heading</label>
                                <div class="bg-gray-50 rounded p-3 text-sm whitespace-pre-wrap">
                                  {promptItem.promptHeading || '—'}
                                </div>
                              </div>
                              <div>
                                <label class="text-sm font-medium text-muted-foreground block mb-1">Type</label>
                                <div class="bg-gray-50 rounded p-3 text-sm whitespace-pre-wrap">
                                  {promptItem.type || '—'}
                                </div>
                              </div>
                              <div>
                                <label class="text-sm font-medium text-muted-foreground block mb-1">
                                  Original Text
                                </label>
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

              <div class="flex gap-3 pt-4">
                <Button
                  type="submit"
                  disabled={!projectName().trim() || isLoading() || isLocked()}
                  title={isLocked() ? 'Cannot update: a judgment job exists for this project' : undefined}
                  class={actionStateClass()}
                >
                  {isLoading() ? 'Updating...' : 'Update Project'}
                </Button>
                <Button as={Link} to="/projects" variant="outline">
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        </Show>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/edit')({component: EditProject})
