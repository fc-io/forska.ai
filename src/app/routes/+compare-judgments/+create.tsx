import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createMemo, createSignal, For, Show} from 'solid-js'

import {Button} from '../../../components/ui/button'
import {apiClient} from '../../../services/apiClient'
import {
  type ComparisonProjectSource,
  createComparisonProject,
  type CreateComparisonProjectInput,
  fetchComparisonProjectSources,
} from '../../../services/comparisonProjectsService'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'
import {isImportedFileRoute} from '../../../utils/importRouteUtils.ts'

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

const getSelectedContentOptionCount = (options: {
  compareTitleAndAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}) => {
  return [options.compareTitleAndAbstract, options.useFulltext, options.useFulltextNoImages].filter(Boolean).length
}

const promptHasSummaryCriteria = (prompt: ComparisonProjectSource['prompts'][number]) => {
  return Boolean(prompt.criteriaDisposition && prompt.criteriaSectionKey)
}

const getSummaryCriteriaLabel = (prompt: ComparisonProjectSource['prompts'][number]) => {
  const labelParts = [prompt.criteriaDisposition, prompt.criteriaSectionLabel ?? prompt.criteriaSectionKey].filter(
    Boolean,
  )

  return labelParts.join(' · ')
}

const getSummaryCapableSources = (sources: ComparisonProjectSource[]) => {
  return sources.filter((source) => {
    return source.isSummaryCapable
  })
}

const getSummarySourcePrompts = (sourceProject: ComparisonProjectSource | undefined) => {
  return [...(sourceProject?.prompts ?? [])].filter(promptHasSummaryCriteria).sort((left, right) => {
    return left.order - right.order
  })
}

const getPromptSelectionsFromExistingPrompts = (prompts: ExistingPrompt[], selectedPromptIds: string[]) => {
  return prompts
    .filter((prompt) => {
      return selectedPromptIds.includes(prompt.id)
    })
    .map((prompt, index) => {
      return {promptId: prompt.id, order: index}
    })
}

const CreateCompareJudgmentsPage = () => {
  const navigate = useNavigate()
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
  const sourcesQuery = useQuery(() => {
    return {
      queryKey: ['comparison-project-sources'],
      queryFn: fetchComparisonProjectSources,
      staleTime: 1000 * 60 * 5,
      suspense: false,
    }
  })

  const [comparisonProjectName, setComparisonProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [selectedImportRoutes, setSelectedImportRoutes] = createSignal<string[]>([])
  const [selectedPromptIds, setSelectedPromptIds] = createSignal<string[]>([])
  const [compareTitleAndAbstract, setCompareTitleAndAbstract] = createSignal(true)
  const [useFulltext, setUseFulltext] = createSignal(false)
  const [useFulltextNoImages, setUseFulltextNoImages] = createSignal(false)
  const [compareWithHumans, setCompareWithHumans] = createSignal(false)
  const [summaryModeEnabled, setSummaryModeEnabled] = createSignal(false)
  const [selectedSummarySourceProjectId, setSelectedSummarySourceProjectId] = createSignal('')
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const sortedExistingPrompts = createMemo(() => {
    return [...(existingPromptsQuery.data ?? [])].sort((left, right) => {
      return getPromptDateValue(right.createdAt) - getPromptDateValue(left.createdAt)
    })
  })
  const selectedContentOptionCount = createMemo(() => {
    return getSelectedContentOptionCount({
      compareTitleAndAbstract: compareTitleAndAbstract(),
      useFulltext: useFulltext(),
      useFulltextNoImages: useFulltextNoImages(),
    })
  })
  const hasSelectedContentOptions = createMemo(() => {
    return selectedContentOptionCount() > 0
  })
  const summaryCapableSources = createMemo(() => {
    return getSummaryCapableSources(sourcesQuery.data ?? [])
  })
  const selectedSummarySourceProject = createMemo(() => {
    return summaryCapableSources().find((sourceProject) => {
      return sourceProject.id === selectedSummarySourceProjectId()
    })
  })
  const summarySourcePrompts = createMemo(() => {
    return getSummarySourcePrompts(selectedSummarySourceProject())
  })
  const selectableExistingPrompts = createMemo(() => {
    return sortedExistingPrompts()
  })
  const selectedSelectablePromptCount = createMemo(() => {
    const selectablePromptIds = new Set(
      selectableExistingPrompts().map((prompt) => {
        return prompt.id
      }),
    )

    return selectedPromptIds().filter((promptId) => {
      return selectablePromptIds.has(promptId)
    }).length
  })
  const summaryModeUnavailableReason = createMemo(() => {
    if (sourcesQuery.isLoading) {
      return 'Loading summary-capable source projects...'
    }

    if (sourcesQuery.isError) {
      return sourcesQuery.error instanceof Error ? sourcesQuery.error.message : 'Failed to load source projects'
    }

    return summaryCapableSources().length === 0 ? 'No summary-capable source projects are available.' : null
  })
  const summarySourceInvalidReason = createMemo(() => {
    if (!summaryModeEnabled()) {
      return null
    }

    if (!selectedSummarySourceProjectId()) {
      return 'Select a summary-capable source project'
    }

    if (!selectedSummarySourceProject()) {
      return 'Selected summary source project is unavailable'
    }

    return summarySourcePrompts().length === 0
      ? 'Selected summary source project has no prompts with summary criteria metadata'
      : null
  })
  const canSubmit = createMemo(() => {
    return (
      Boolean(comparisonProjectName().trim())
      && hasSelectedContentOptions()
      && !summarySourceInvalidReason()
      && !isLoading()
    )
  })

  const handleSubmit = async (event: Event) => {
    event.preventDefault()
    setError(null)

    if (!hasSelectedContentOptions()) {
      setError('Select at least one article content option to compare')
      return
    }

    const summaryValidationError = summarySourceInvalidReason()
    if (summaryValidationError) {
      setError(summaryValidationError)
      return
    }

    const promptSelections = summaryModeEnabled()
      ? undefined
      : getPromptSelectionsFromExistingPrompts(sortedExistingPrompts(), selectedPromptIds())

    const createComparisonProjectInput: CreateComparisonProjectInput = {
      name: comparisonProjectName(),
      description: description().trim() || undefined,
      compareWithHumans: compareWithHumans(),
      humanJudgmentMode: summaryModeEnabled() ? 'summary' : 'prompt',
      summarySourceProjectId: summaryModeEnabled() ? selectedSummarySourceProjectId() : null,
      useTitle: compareTitleAndAbstract(),
      useAbstract: compareTitleAndAbstract(),
      useFulltext: useFulltext(),
      useFulltextNoImages: useFulltextNoImages(),
      importRoutes: selectedImportRoutes().length > 0 ? selectedImportRoutes() : undefined,
      promptSelections: promptSelections && promptSelections.length > 0 ? promptSelections : undefined,
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
        <h1 class="text-3xl font-bold">Compare Articles</h1>
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
                    const showRouteHint =
                      Boolean(importRoute.name?.trim())
                      && importRoute.name !== importRoute.route
                      && !isImportedFileRoute(importRoute.route)

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
            <div class="flex items-center justify-between mb-2">
              <p class="block text-sm font-medium">Compare Article Content Used *</p>
              <span class="text-xs text-muted-foreground">{selectedContentOptionCount()} selected</span>
            </div>
            <div class="space-y-2">
              <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer">
                <input
                  type="checkbox"
                  class="mt-1"
                  checked={compareTitleAndAbstract()}
                  onChange={(event) => {
                    return setCompareTitleAndAbstract(event.currentTarget.checked)
                  }}
                />
                <div class="flex-1">
                  <p class="text-sm font-medium text-gray-900">Article Title and Abstract</p>
                  <p class="text-xs text-gray-500 mt-0.5">
                    Compare judgments that use the article title plus abstract.
                  </p>
                </div>
              </label>
              <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer">
                <input
                  type="checkbox"
                  class="mt-1"
                  checked={useFulltext()}
                  onChange={(event) => {
                    return setUseFulltext(event.currentTarget.checked)
                  }}
                />
                <div class="flex-1">
                  <p class="text-sm font-medium text-gray-900">Use Full Text (with images)</p>
                  <p class="text-xs text-gray-500 mt-0.5">
                    Compare judgments that use the complete article text including embedded images.
                  </p>
                </div>
              </label>
              <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer">
                <input
                  type="checkbox"
                  class="mt-1"
                  checked={useFulltextNoImages()}
                  onChange={(event) => {
                    return setUseFulltextNoImages(event.currentTarget.checked)
                  }}
                />
                <div class="flex-1">
                  <p class="text-sm font-medium text-gray-900">Use Full Text (without images)</p>
                  <p class="text-xs text-gray-500 mt-0.5">
                    Compare judgments that use article text with embedded images stripped out.
                  </p>
                </div>
              </label>
            </div>
            <Show when={!hasSelectedContentOptions()}>
              <p class="mt-2 text-sm text-red-600">Pick at least one content option.</p>
            </Show>
          </div>

          <div class="border border-input rounded-md p-4 bg-muted/20">
            <label class="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                class="mt-1"
                checked={compareWithHumans()}
                onChange={(event) => {
                  setCompareWithHumans(event.currentTarget.checked)

                  if (!event.currentTarget.checked) {
                    setSummaryModeEnabled(false)
                  }
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

          <div class="border border-input rounded-md p-4 bg-muted/20">
            <label class="flex items-start gap-3" classList={{'cursor-pointer': !summaryModeUnavailableReason()}}>
              <input
                type="checkbox"
                class="mt-1"
                checked={summaryModeEnabled()}
                disabled={Boolean(summaryModeUnavailableReason())}
                onChange={(event) => {
                  setSummaryModeEnabled(event.currentTarget.checked)

                  if (event.currentTarget.checked) {
                    setCompareWithHumans(true)
                  }
                }}
              />
              <div class="flex-1">
                <p class="text-sm font-medium text-gray-900">Summary mode</p>
                <p class="text-xs text-muted-foreground mt-1">
                  Compare overall human decisions derived from a summary-capable source project.
                </p>
                <Show when={summaryModeUnavailableReason()}>
                  <p class="text-xs text-red-600 mt-1">{summaryModeUnavailableReason()}</p>
                </Show>
              </div>
            </label>
          </div>

          <Show when={summaryModeEnabled()}>
            <div>
              <p class="block text-sm font-medium mb-2">Summary Source Project *</p>
              <Show when={sourcesQuery.isLoading}>
                <p class="text-sm text-muted-foreground">Loading summary-capable source projects...</p>
              </Show>
              <Show when={sourcesQuery.isError}>
                <p class="text-sm text-red-600">
                  {sourcesQuery.error instanceof Error ? sourcesQuery.error.message : 'Failed to load source projects'}
                </p>
              </Show>
              <Show when={!sourcesQuery.isLoading && !sourcesQuery.isError}>
                <div class="space-y-2">
                  <For each={summaryCapableSources()}>
                    {(sourceProject) => {
                      const summaryPromptCount = () => {
                        return sourceProject.prompts.filter(promptHasSummaryCriteria).length
                      }
                      const isDisabled = () => {
                        return summaryPromptCount() === 0
                      }

                      return (
                        <label
                          class="flex items-start gap-3 border border-input rounded-md p-3"
                          classList={{'cursor-pointer hover:bg-muted/50': !isDisabled(), 'opacity-50': isDisabled()}}
                        >
                          <input
                            type="radio"
                            name="summary-source-project"
                            class="mt-1"
                            disabled={isDisabled()}
                            checked={selectedSummarySourceProjectId() === sourceProject.id}
                            onChange={() => {
                              setSelectedSummarySourceProjectId(sourceProject.id)
                            }}
                          />
                          <div class="flex-1">
                            <div class="flex items-center gap-2 flex-wrap">
                              <p class="text-sm font-medium text-gray-900">{sourceProject.name}</p>
                              <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                                {sourceProject.modelName}
                              </span>
                            </div>
                            <p class="text-xs text-muted-foreground mt-1">
                              Summary prompts: {summaryPromptCount()} of {sourceProject.prompts.length}
                            </p>
                            <Show when={isDisabled()}>
                              <p class="text-xs text-red-600 mt-1">
                                This project has no prompts with summary criteria metadata.
                              </p>
                            </Show>
                          </div>
                        </label>
                      )
                    }}
                  </For>
                </div>
              </Show>
              <Show when={summarySourceInvalidReason()}>
                <p class="mt-2 text-sm text-red-600">{summarySourceInvalidReason()}</p>
              </Show>
            </div>
          </Show>

          <Show
            when={summaryModeEnabled()}
            fallback={
              <div>
                <div class="flex items-center justify-between mb-2">
                  <label class="block text-sm font-medium">Existing Prompts</label>
                  <span class="text-xs text-muted-foreground">
                    {selectedSelectablePromptCount()} of {selectableExistingPrompts().length} selected
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
                    !existingPromptsQuery.isLoading
                    && !existingPromptsQuery.isError
                    && selectableExistingPrompts().length === 0
                  }
                >
                  <p class="text-sm text-muted-foreground">No prompts available.</p>
                </Show>
                <Show
                  when={
                    !existingPromptsQuery.isLoading
                    && !existingPromptsQuery.isError
                    && selectableExistingPrompts().length > 0
                  }
                >
                  <div class="space-y-3">
                    <For each={selectableExistingPrompts()}>
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
            }
          >
            <div>
              <div class="flex items-center justify-between mb-2">
                <label class="block text-sm font-medium">Inherited Summary Prompts</label>
                <span class="text-xs text-muted-foreground">{summarySourcePrompts().length} inherited</span>
              </div>
              <p class="text-sm text-muted-foreground mb-3">
                Summary mode automatically compares overall decisions using the selected source project's eligible
                summary prompts.
              </p>
              <Show when={!selectedSummarySourceProjectId()}>
                <p class="text-sm text-muted-foreground">
                  Select a summary source project to preview inherited prompts.
                </p>
              </Show>
              <Show when={selectedSummarySourceProjectId() && summarySourcePrompts().length === 0}>
                <p class="text-sm text-muted-foreground">
                  No eligible summary prompts are available on the selected source project.
                </p>
              </Show>
              <Show when={summarySourcePrompts().length > 0}>
                <div class="space-y-2">
                  <For each={summarySourcePrompts()}>
                    {(prompt) => {
                      return (
                        <div class="border border-input rounded-md p-3 bg-background">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-sm font-medium text-gray-900">
                              {prompt.promptHeading?.trim() || `Prompt ${prompt.order + 1}`}
                            </span>
                            <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
                              Inherited automatically
                            </span>
                            <Show when={getSummaryCriteriaLabel(prompt)}>
                              <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                                {getSummaryCriteriaLabel(prompt)}
                              </span>
                            </Show>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </div>
          </Show>

          <div class="flex gap-3 pt-4">
            <Button type="submit" disabled={!canSubmit()}>
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
