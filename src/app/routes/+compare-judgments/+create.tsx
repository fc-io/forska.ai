import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createMemo, createSignal, For, Show} from 'solid-js'

import {Button} from '../../../components/ui/button'
import {apiClient} from '../../../services/apiClient'
import {createComparisonProject, type CreateComparisonProjectInput} from '../../../services/comparisonProjectsService'
import {fetchSession} from '../../../services/fetchSession'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

type ExistingPrompt = {
  id: string
  originalText: string
  promptHeading: string | null
  type: string | null
  createdAt: Date | string | null
}

type ExistingPromptsResponse = {data: ExistingPrompt[]}

type ImportRouteOption = {route: string; name: string | null}
type ImportRoutesResponse = {data: ImportRouteOption[]}
type ParsedDateResult = {date: Date | null; normalized: string | null; error: string | null}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

const parseDateInput = (value: string): ParsedDateResult => {
  const trimmedValue = value.trim()

  if (!trimmedValue) {
    return {date: null, normalized: null, error: null}
  }

  if (!isoDatePattern.exec(trimmedValue)) {
    return {date: null, normalized: null, error: 'Dates must use the YYYY-MM-DD format'}
  }

  const parsedDate = new Date(`${trimmedValue}T00:00:00.000Z`)

  if (Number.isNaN(parsedDate.getTime())) {
    return {date: null, normalized: null, error: 'Invalid date provided'}
  }

  return {date: parsedDate, normalized: trimmedValue, error: null}
}

const toggleStringSelection = (currentValues: string[], nextValue: string) => {
  return currentValues.includes(nextValue)
    ? currentValues.filter((value) => {
        return value !== nextValue
      })
    : [...currentValues, nextValue]
}

const getPromptDateValue = (value: Date | string | null) => {
  return value ? new Date(value).getTime() : 0
}

const CreateCompareJudgmentsPage = () => {
  const navigate = useNavigate()
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession, staleTime: 1000 * 60 * 5, suspense: false}
  })
  const importRoutesQuery = useQuery(() => {
    return {
      queryKey: ['comparison-project-import-routes'],
      queryFn: async () => {
        const response = await apiClient.api['import-routes'].get()
        const result = handleApiResponse<ImportRoutesResponse>(response, 'Failed to load import routes')
        return result.data ?? []
      },
      staleTime: 1000 * 60 * 5,
      suspense: false,
    }
  })
  const existingPromptsQuery = useQuery(() => {
    return {
      queryKey: ['comparison-project-prompts'],
      queryFn: async () => {
        const response = await apiClient.api.prompts.get()
        const result = handleApiResponse<ExistingPromptsResponse>(response, 'Failed to load existing prompts')
        return result.data ?? []
      },
      staleTime: 1000 * 60 * 5,
      suspense: false,
    }
  })

  const [comparisonProjectName, setComparisonProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [dateFrom, setDateFrom] = createSignal('')
  const [dateTo, setDateTo] = createSignal('')
  const [selectedImportRoutes, setSelectedImportRoutes] = createSignal<string[]>([])
  const [selectedPromptIds, setSelectedPromptIds] = createSignal<string[]>([])
  const [useTitle, setUseTitle] = createSignal(true)
  const [useAbstract, setUseAbstract] = createSignal(true)
  const [useFulltext, setUseFulltext] = createSignal(false)
  const [useFulltextNoImages, setUseFulltextNoImages] = createSignal(false)
  const [compareWithHumans, setCompareWithHumans] = createSignal(false)
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const sortedExistingPrompts = createMemo(() => {
    return [...(existingPromptsQuery.data ?? [])].sort((left, right) => {
      return getPromptDateValue(right.createdAt) - getPromptDateValue(left.createdAt)
    })
  })

  const handleSubmit = async (event: Event) => {
    event.preventDefault()
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

    const ownerId = sessionQuery.data?.user.id
    if (!ownerId) {
      setError('User must be authenticated to create a comparison project')
      return
    }

    const promptSelections = sortedExistingPrompts()
      .filter((prompt) => {
        return selectedPromptIds().includes(prompt.id)
      })
      .map((prompt, index) => {
        return {promptId: prompt.id, order: index}
      })

    const createComparisonProjectInput: CreateComparisonProjectInput = {
      name: comparisonProjectName(),
      description: description().trim() || undefined,
      ownerId,
      compareWithHumans: compareWithHumans(),
      dateFrom: startDateResult.normalized ?? undefined,
      dateTo: endDateResult.normalized ?? undefined,
      useTitle: useTitle(),
      useAbstract: useAbstract(),
      useFulltext: useFulltext(),
      useFulltextNoImages: useFulltextNoImages(),
      importRoutes: selectedImportRoutes().length > 0 ? selectedImportRoutes() : undefined,
      promptSelections: promptSelections.length > 0 ? promptSelections : undefined,
    }

    setIsLoading(true)

    try {
      await createComparisonProject(createComparisonProjectInput)
      void navigate({to: '/compare-judgments'})
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'An unexpected error occurred'
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <div class="flex items-center gap-4 mb-6">
        <Button as={Link} to="/compare-judgments" variant="outline" size="sm">
          ← Back to Compare Judgments
        </Button>
        <h1 class="text-3xl font-bold">Create New Comparison</h1>
      </div>

      <div class="bg-card border rounded-lg p-6">
        <Show when={error()}>
          <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">{error()}</div>
        </Show>

        <form
          onSubmit={(event) => {
            return void handleSubmit(event)
          }}
          class="space-y-6"
        >
          <div>
            <label for="comparison-project-name" class="block text-sm font-medium mb-2">
              Name *
            </label>
            <input
              id="comparison-project-name"
              type="text"
              value={comparisonProjectName()}
              onInput={(event) => {
                return setComparisonProjectName(event.currentTarget.value)
              }}
              placeholder="Enter comparison project name"
              class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              required
            />
          </div>

          <div>
            <label for="comparison-project-description" class="block text-sm font-medium mb-2">
              Description
            </label>
            <textarea
              id="comparison-project-description"
              value={description()}
              onInput={(event) => {
                return setDescription(event.currentTarget.value)
              }}
              placeholder="Describe what this comparison project is for..."
              rows="4"
              class="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent resize-none"
            />
          </div>

          <div>
            <p class="block text-sm font-medium mb-2">Comparison Timeline</p>
            <div class="grid grid-cols-2 gap-4">
              <label class="flex flex-col text-sm font-medium gap-1">
                <span>Start Date</span>
                <input
                  type="text"
                  value={dateFrom()}
                  onInput={(event) => {
                    return setDateFrom(event.currentTarget.value)
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
                  onInput={(event) => {
                    return setDateTo(event.currentTarget.value)
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
                !importRoutesQuery.isLoading
                && !importRoutesQuery.isError
                && (importRoutesQuery.data?.length ?? 0) === 0
              }
            >
              <p class="text-sm text-muted-foreground">No import routes available.</p>
            </Show>
            <Show
              when={
                !importRoutesQuery.isLoading && !importRoutesQuery.isError && (importRoutesQuery.data?.length ?? 0) > 0
              }
            >
              <div class="space-y-2">
                <For each={importRoutesQuery.data ?? []}>
                  {(importRoute) => {
                    const displayName = importRoute.name?.trim() ? importRoute.name : importRoute.route
                    const showRouteHint = Boolean(importRoute.name?.trim()) && importRoute.name !== importRoute.route

                    return (
                      <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/40">
                        <input
                          type="checkbox"
                          class="mt-1"
                          checked={selectedImportRoutes().includes(importRoute.route)}
                          onChange={() => {
                            setSelectedImportRoutes((current) => {
                              return toggleStringSelection(current, importRoute.route)
                            })
                          }}
                        />
                        <div class="flex-1">
                          <p class="text-sm font-medium text-gray-900">{displayName}</p>
                          <Show when={showRouteHint}>
                            <p class="text-xs text-gray-600 font-mono break-all">{importRoute.route}</p>
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
                  onChange={(event) => {
                    return setUseTitle(event.currentTarget.checked)
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
                  onChange={(event) => {
                    return setUseAbstract(event.currentTarget.checked)
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
                  onChange={(event) => {
                    const isChecked = event.currentTarget.checked
                    setUseFulltext(isChecked)

                    if (isChecked) {
                      setUseFulltextNoImages(false)
                    }
                  }}
                />
                <div class="flex-1">
                  <p class="text-sm font-medium text-gray-900">Use Full Text (with images)</p>
                  <p class="text-xs text-gray-500 mt-0.5">
                    Include the complete article text including embedded images.
                  </p>
                </div>
              </label>
              <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer">
                <input
                  type="checkbox"
                  class="mt-1"
                  checked={useFulltextNoImages()}
                  onChange={(event) => {
                    const isChecked = event.currentTarget.checked
                    setUseFulltextNoImages(isChecked)

                    if (isChecked) {
                      setUseFulltext(false)
                    }
                  }}
                />
                <div class="flex-1">
                  <p class="text-sm font-medium text-gray-900">Use Full Text (without images)</p>
                  <p class="text-xs text-gray-500 mt-0.5">
                    Include article text but strip embedded images to reduce token usage.
                  </p>
                </div>
              </label>
            </div>
          </div>

          <div class="border border-input rounded-md p-4 bg-muted/20">
            <label class="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                class="mt-1"
                checked={compareWithHumans()}
                onChange={(event) => {
                  return setCompareWithHumans(event.currentTarget.checked)
                }}
              />
              <div class="flex-1">
                <p class="text-sm font-medium text-gray-900">Compare with humans</p>
                <p class="text-xs text-muted-foreground mt-1">
                  Save that this comparison should include human judgments in future result views.
                </p>
              </div>
            </label>
          </div>

          <div>
            <div class="flex items-center justify-between mb-2">
              <label class="block text-sm font-medium">Existing Prompts</label>
              <span class="text-xs text-muted-foreground">
                {selectedPromptIds().length} of {sortedExistingPrompts().length} selected
              </span>
            </div>
            <Show when={existingPromptsQuery.isLoading}>
              <div class="text-sm text-muted-foreground">Loading existing prompts...</div>
            </Show>
            <Show when={existingPromptsQuery.isError}>
              <p class="text-sm text-red-600">
                {existingPromptsQuery.error instanceof Error
                  ? existingPromptsQuery.error.message
                  : 'Failed to load existing prompts'}
              </p>
            </Show>
            <Show
              when={
                !existingPromptsQuery.isLoading && !existingPromptsQuery.isError && sortedExistingPrompts().length === 0
              }
            >
              <p class="text-sm text-muted-foreground">No prompts available.</p>
            </Show>
            <Show
              when={
                !existingPromptsQuery.isLoading && !existingPromptsQuery.isError && sortedExistingPrompts().length > 0
              }
            >
              <div class="space-y-3">
                <For each={sortedExistingPrompts()}>
                  {(prompt) => {
                    const isSelected = () => {
                      return selectedPromptIds().includes(prompt.id)
                    }

                    return (
                      <div class="border rounded-lg p-4 bg-background" classList={{'opacity-40': !isSelected()}}>
                        <div class="flex justify-between items-start mb-3 gap-4">
                          <div class="flex items-center gap-2 flex-wrap">
                            <Show when={prompt.promptHeading}>
                              <span class="font-medium">{prompt.promptHeading}</span>
                            </Show>
                            <Show when={prompt.type}>
                              <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                {prompt.type}
                              </span>
                            </Show>
                            <Show when={prompt.createdAt}>
                              <span class="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium bg-gray-50 text-gray-600">
                                Created: {new Date(prompt.createdAt as Date | string).toLocaleDateString()}
                              </span>
                            </Show>
                            <Show when={isSelected()}>
                              <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                Selected
                              </span>
                            </Show>
                          </div>
                          <label class="flex items-center gap-2">
                            <input
                              type="checkbox"
                              class="mt-0.5"
                              checked={isSelected()}
                              onChange={() => {
                                setSelectedPromptIds((current) => {
                                  return toggleStringSelection(current, prompt.id)
                                })
                              }}
                            />
                            <span class="text-sm">Include</span>
                          </label>
                        </div>

                        <div class="space-y-3">
                          <Show when={prompt.promptHeading}>
                            <div>
                              <label class="text-sm font-medium text-muted-foreground block mb-1">Heading</label>
                              <div class="bg-gray-50 rounded p-3 text-sm whitespace-pre-wrap">
                                {prompt.promptHeading}
                              </div>
                            </div>
                          </Show>
                          <Show when={prompt.type}>
                            <div>
                              <label class="text-sm font-medium text-muted-foreground block mb-1">Type</label>
                              <div class="bg-gray-50 rounded p-3 text-sm whitespace-pre-wrap">{prompt.type}</div>
                            </div>
                          </Show>
                          <div>
                            <label class="text-sm font-medium text-muted-foreground block mb-1">Prompt Text</label>
                            <div class="bg-gray-50 rounded p-3 text-sm font-mono whitespace-pre-wrap">
                              {prompt.originalText}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>

          <div class="flex gap-3 pt-4">
            <Button type="submit" disabled={!comparisonProjectName().trim() || isLoading() || sessionQuery.isLoading}>
              {isLoading() ? 'Creating...' : 'Create Comparison Project'}
            </Button>
            <Button as={Link} to="/compare-judgments" variant="outline">
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/compare-judgments/create')({component: CreateCompareJudgmentsPage})
