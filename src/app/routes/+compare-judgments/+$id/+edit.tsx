import * as Select from '@kobalte/core/select'
import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import type {HumanJudgmentMode} from '../../../../db/schemaTypes'
import {apiClient} from '../../../../services/apiClient'
import {
  type ComparisonProjectEditFormData,
  type ComparisonProjectSource,
  fetchComparisonProjectEditFormData,
  fetchComparisonProjectSources,
  updateComparisonProject,
  type UpdateComparisonProjectInput,
} from '../../../../services/comparisonProjectsService'
import {ensureSelectableModelId} from '../../../../services/ensureSelectableModelId.ts'
import {handleApiResponse} from '../../../../services/utils/handleApiResponse'

type ModelOption = {
  id: string
  label: string
  modelName: string | null
  name: string
  provider: string | null
  version: string | null
}
type ModelsResponse = {data: ModelOption[]}

const formatPromptCreatedAt = (value: Date | string) => {
  return new Date(value).toLocaleDateString()
}

const togglePromptSelection = (currentValues: string[], nextValue: string) => {
  return currentValues.includes(nextValue)
    ? currentValues.filter((value) => {
        return value !== nextValue
      })
    : [...currentValues, nextValue]
}

const formatContentSettings = (sourceProject: ComparisonProjectSource) => {
  const parts = [
    sourceProject.useTitle ? 'title' : null,
    sourceProject.useAbstract ? 'abstract' : null,
    sourceProject.useFulltextNoImages ? 'fulltext (no images)' : sourceProject.useFulltext ? 'fulltext' : null,
  ].filter(Boolean) as string[]

  return parts.length > 0 ? parts.join(' + ') : 'none'
}

const hasSummaryPromptCriteria = (prompt: ComparisonProjectSource['prompts'][number]) => {
  return Boolean(prompt.criteriaDisposition && prompt.criteriaSectionKey)
}

const getSummaryPrompts = (sourceProject: ComparisonProjectSource | undefined) => {
  return [...(sourceProject?.prompts ?? [])].filter(hasSummaryPromptCriteria).sort((left, right) => {
    return left.order - right.order
  })
}

const getAdditionalSummaryProjectReason = (
  primarySourceProject: ComparisonProjectSource | undefined,
  additionalSourceProject: ComparisonProjectSource,
) => {
  if (!primarySourceProject) {
    return 'Select a primary project first.'
  }

  if (!additionalSourceProject.isSummaryCapable) {
    return 'Summary mode is unavailable for this project.'
  }

  return getSummaryPrompts(additionalSourceProject).length === 0 ? 'No prompts with summary criteria metadata.' : null
}

const getPromptSelectionsFromSourceProject = (sourceProject: ComparisonProjectSource, summaryModeEnabled: boolean) => {
  const prompts = summaryModeEnabled ? getSummaryPrompts(sourceProject) : sourceProject.prompts

  return prompts.map((prompt, index) => {
    return {promptId: prompt.id, order: prompt.order ?? index}
  })
}

const getUniqueSourceProjectValues = (
  sourceProjects: ComparisonProjectSource[],
  getValues: (sourceProject: ComparisonProjectSource) => string[],
) => {
  return Array.from(new Set(sourceProjects.flatMap(getValues)))
}

const getSelectedContentOptionCount = (options: {
  compareTitleAndAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}) => {
  return [options.compareTitleAndAbstract, options.useFulltext, options.useFulltextNoImages].filter(Boolean).length
}

const getSelectedPromptIds = (comparisonProject: ComparisonProjectEditFormData) => {
  return [...comparisonProject.promptSelections]
    .sort((left, right) => {
      return left.order - right.order
    })
    .map((selection) => {
      return selection.promptId
    })
}

const getSelectedModelIds = (comparisonProject: ComparisonProjectEditFormData) => {
  return comparisonProject.selectedModelIds ?? []
}

const getHumanJudgmentModeLabel = (humanJudgmentMode: HumanJudgmentMode) => {
  return humanJudgmentMode === 'summary' ? 'Summary overall decisions' : 'Prompt-by-prompt decisions'
}

const getResolvedModelIdsForUpdate = async (selectedModelIds: string[], availableModels: ModelOption[]) => {
  const resolvedModelIds = await Promise.all(
    selectedModelIds.map(async (selectedModelId) => {
      const selectedModel = availableModels.find((model) => {
        return model.id === selectedModelId
      })

      return selectedModel ? ensureSelectableModelId(selectedModel) : selectedModelId
    }),
  )

  return Array.from(new Set(resolvedModelIds))
}

const EditComparisonProjectPage = () => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const params = Route.useParams()
  const comparisonProjectId = () => {
    const routeParams = params()

    return 'id' in routeParams ? routeParams.id : ''
  }
  const comparisonProjectQuery = useQuery(() => {
    return {
      queryKey: ['comparison-project-edit', comparisonProjectId()],
      queryFn: () => {
        return fetchComparisonProjectEditFormData(comparisonProjectId())
      },
      suspense: false,
    }
  })
  const modelsQuery = useQuery(() => {
    return {
      queryKey: ['comparison-project-models'],
      queryFn: async () => {
        const response = await apiClient.api.models.get()
        const result = handleApiResponse<ModelsResponse>(
          response as unknown as {data?: ModelsResponse; error?: unknown; status?: number},
          'Failed to load models',
        )

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
  const [compareWithHumans, setCompareWithHumans] = createSignal(false)
  const [summaryModeEnabled, setSummaryModeEnabled] = createSignal(false)
  const [humanJudgmentMode, setHumanJudgmentMode] = createSignal<HumanJudgmentMode>('prompt')
  const [selectedSourceProjectId, setSelectedSourceProjectId] = createSignal('')
  const [selectedAdditionalSourceProjectIds, setSelectedAdditionalSourceProjectIds] = createSignal<string[]>([])
  const [selectedModelIds, setSelectedModelIds] = createSignal<string[]>([])
  const [compareTitleAndAbstract, setCompareTitleAndAbstract] = createSignal(true)
  const [useFulltext, setUseFulltext] = createSignal(false)
  const [useFulltextNoImages, setUseFulltextNoImages] = createSignal(false)
  const [selectedPromptIds, setSelectedPromptIds] = createSignal<string[]>([])
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [initializedComparisonProjectVersion, setInitializedComparisonProjectVersion] = createSignal<string | null>(
    null,
  )
  const modelOptions = createMemo(() => {
    return (modelsQuery.data ?? []).map((model) => {
      return {value: model.id, label: model.label}
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
  const canUseSummaryMode = createMemo(() => {
    return Boolean(comparisonProjectQuery.data?.summarySourceProject)
  })
  const isSourceProjectBacked = createMemo(() => {
    return (comparisonProjectQuery.data?.sourceProjectIds.length ?? 0) > 0
  })
  const selectedSourceProject = createMemo(() => {
    return (sourcesQuery.data ?? []).find((sourceProject) => {
      return sourceProject.id === selectedSourceProjectId()
    })
  })
  const hasComparableContentOptions = createMemo(() => {
    const sourceProject = selectedSourceProject()

    return isSourceProjectBacked()
      ? Boolean(
          sourceProject?.useTitle
          || sourceProject?.useAbstract
          || sourceProject?.useFulltext
          || sourceProject?.useFulltextNoImages,
        )
      : hasSelectedContentOptions()
  })
  const selectedAdditionalSourceProjects = createMemo(() => {
    return selectedAdditionalSourceProjectIds().reduce<ComparisonProjectSource[]>(
      (selectedProjects, sourceProjectId) => {
        const sourceProject = (sourcesQuery.data ?? []).find((candidateSourceProject) => {
          return candidateSourceProject.id === sourceProjectId
        })

        return sourceProject ? [...selectedProjects, sourceProject] : selectedProjects
      },
      [],
    )
  })
  const additionalSourceProjects = createMemo(() => {
    return (sourcesQuery.data ?? []).filter((sourceProject) => {
      return sourceProject.id !== selectedSourceProjectId()
    })
  })
  const selectedSourceProjectSummaryPrompts = createMemo(() => {
    return getSummaryPrompts(selectedSourceProject())
  })
  const selectedProjectCount = createMemo(() => {
    return selectedSourceProjectId() ? 1 + selectedAdditionalSourceProjectIds().length : 0
  })
  const selectedHumanJudgmentModeLabel = createMemo(() => {
    return getHumanJudgmentModeLabel(humanJudgmentMode())
  })
  const summaryModeUnavailableReason = createMemo(() => {
    if (!isSourceProjectBacked()) {
      return null
    }

    if (sourcesQuery.isLoading) {
      return 'Select a primary project after projects finish loading.'
    }

    if (sourcesQuery.isError) {
      return sourcesQuery.error instanceof Error ? sourcesQuery.error.message : 'Failed to load projects'
    }

    if (!selectedSourceProjectId()) {
      return 'Select a primary project to enable summary mode.'
    }

    if (!selectedSourceProject()?.isSummaryCapable) {
      return 'Selected primary project is not summary-capable.'
    }

    return selectedSourceProjectSummaryPrompts().length === 0
      ? 'Selected primary project has no prompts with summary criteria metadata.'
      : null
  })
  const additionalProjectValidationError = createMemo(() => {
    if (!summaryModeEnabled()) {
      return null
    }

    const invalidSourceProject = selectedAdditionalSourceProjects().find((sourceProject) => {
      return Boolean(getAdditionalSummaryProjectReason(selectedSourceProject(), sourceProject))
    })

    if (!invalidSourceProject) {
      return null
    }

    const reason = getAdditionalSummaryProjectReason(selectedSourceProject(), invalidSourceProject)

    return reason ? `${invalidSourceProject.name}: ${reason}` : null
  })
  const canSubmit = createMemo(() => {
    return Boolean(
      comparisonProjectName().trim()
      && hasComparableContentOptions()
      && (!isSourceProjectBacked() || selectedSourceProject())
      && (!summaryModeEnabled() || (!summaryModeUnavailableReason() && !additionalProjectValidationError()))
      && !isLoading(),
    )
  })

  createEffect(() => {
    const comparisonProject = comparisonProjectQuery.data
    const comparisonProjectVersion = comparisonProject
      ? `${comparisonProject.id}:${new Date(comparisonProject.updatedAt).toISOString()}`
      : null

    if (!comparisonProject || initializedComparisonProjectVersion() === comparisonProjectVersion) {
      return
    }

    setComparisonProjectName(comparisonProject.name)
    setDescription(comparisonProject.description ?? '')
    setCompareWithHumans(comparisonProject.compareWithHumans)
    setHumanJudgmentMode(comparisonProject.humanJudgmentMode)
    setSummaryModeEnabled(comparisonProject.compareWithHumans && comparisonProject.humanJudgmentMode === 'summary')
    setSelectedModelIds(getSelectedModelIds(comparisonProject))
    setCompareTitleAndAbstract(comparisonProject.useTitle || comparisonProject.useAbstract)
    setUseFulltext(comparisonProject.useFulltext)
    setUseFulltextNoImages(comparisonProject.useFulltextNoImages)
    setSelectedPromptIds(getSelectedPromptIds(comparisonProject))

    const [fallbackSourceProjectId] = comparisonProject.sourceProjectIds
    const primarySourceProjectId = comparisonProject.summarySourceProjectId ?? fallbackSourceProjectId ?? ''
    setSelectedSourceProjectId(primarySourceProjectId)
    setSelectedAdditionalSourceProjectIds(
      comparisonProject.sourceProjectIds.filter((sourceProjectId) => {
        return sourceProjectId !== primarySourceProjectId
      }),
    )
    setInitializedComparisonProjectVersion(comparisonProjectVersion)
  })

  const handleSubmit = async (event: Event) => {
    event.preventDefault()
    setError(null)

    if (!hasComparableContentOptions()) {
      setError('Select at least one article content option to compare')
      return
    }

    if (isSourceProjectBacked() && !selectedSourceProject()) {
      setError('Select a primary project to compare from')
      return
    }

    const sourceSummaryValidationError = summaryModeEnabled()
      ? (summaryModeUnavailableReason() ?? additionalProjectValidationError())
      : null

    if (sourceSummaryValidationError) {
      setError(sourceSummaryValidationError)
      return
    }

    setIsLoading(true)

    try {
      const sourceProject = selectedSourceProject()
      const selectedHumanJudgmentMode = compareWithHumans()
        ? isSourceProjectBacked()
          ? summaryModeEnabled()
            ? 'summary'
            : 'prompt'
          : humanJudgmentMode()
        : 'prompt'
      const selectedSourceProjects = sourceProject
        ? selectedHumanJudgmentMode === 'summary'
          ? [sourceProject, ...selectedAdditionalSourceProjects()]
          : [sourceProject]
        : []
      const resolvedModelIds = isSourceProjectBacked()
        ? getUniqueSourceProjectValues(selectedSourceProjects, (selectedProject) => {
            return [selectedProject.modelId]
          })
        : await getResolvedModelIdsForUpdate(selectedModelIds(), modelsQuery.data ?? [])
      const sourceProjectPromptSelections = sourceProject
        ? getPromptSelectionsFromSourceProject(sourceProject, selectedHumanJudgmentMode === 'summary')
        : []
      const updateComparisonProjectInput: UpdateComparisonProjectInput = isSourceProjectBacked()
        ? {
            name: comparisonProjectName().trim(),
            description: description().trim() || null,
            compareWithHumans: compareWithHumans(),
            humanJudgmentMode: selectedHumanJudgmentMode,
            summarySourceProjectId: selectedHumanJudgmentMode === 'summary' ? selectedSourceProjectId() : null,
            modelIds: resolvedModelIds.length > 0 ? resolvedModelIds : undefined,
            useTitle: sourceProject?.useTitle ?? compareTitleAndAbstract(),
            useAbstract: sourceProject?.useAbstract ?? compareTitleAndAbstract(),
            useFulltext: sourceProject?.useFulltext ?? useFulltext(),
            useFulltextNoImages: sourceProject?.useFulltextNoImages ?? useFulltextNoImages(),
            importRoutes: getUniqueSourceProjectValues(selectedSourceProjects, (selectedProject) => {
              return selectedProject.importRoutes.map((importRoute) => {
                return importRoute.route
              })
            }),
            sourceProjectIds: selectedSourceProjects.map((selectedProject) => {
              return selectedProject.id
            }),
            promptSelections: sourceProjectPromptSelections,
          }
        : {
            name: comparisonProjectName().trim(),
            description: description().trim() || null,
            compareWithHumans: compareWithHumans(),
            humanJudgmentMode: selectedHumanJudgmentMode,
            summarySourceProjectId:
              selectedHumanJudgmentMode === 'summary' ? comparisonProjectQuery.data?.summarySourceProjectId : null,
            modelIds: resolvedModelIds.length > 0 ? resolvedModelIds : undefined,
            useTitle: compareTitleAndAbstract(),
            useAbstract: compareTitleAndAbstract(),
            useFulltext: useFulltext(),
            useFulltextNoImages: useFulltextNoImages(),
            promptSelections: selectedPromptIds().map((promptId, index) => {
              return {promptId, order: index}
            }),
          }

      await updateComparisonProject(comparisonProjectId(), updateComparisonProjectInput)
      await Promise.all([
        queryClient.invalidateQueries({queryKey: ['comparison-project-edit', comparisonProjectId()]}),
        queryClient.invalidateQueries({queryKey: ['comparison-project', comparisonProjectId()]}),
      ])
      void navigate({to: '/compare-judgments/$id', params: {id: comparisonProjectId()} as never})
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
        <Button
          as={Link}
          to="/compare-judgments/$id"
          params={{id: comparisonProjectId()} as never}
          variant="outline"
          size="sm"
        >
          ← Back to Comparison
        </Button>
        <h1 class="text-3xl font-bold">Edit Compare Project</h1>
      </div>

      <Show when={comparisonProjectQuery.isLoading}>
        <div class="bg-card border rounded-lg p-6 text-sm text-muted-foreground">Loading comparison project...</div>
      </Show>

      <Show when={comparisonProjectQuery.isError}>
        <div class="bg-card border rounded-lg p-6 text-sm text-red-600">
          {comparisonProjectQuery.error instanceof Error
            ? comparisonProjectQuery.error.message
            : 'Failed to load comparison project'}
        </div>
      </Show>

      <Show when={!comparisonProjectQuery.isLoading && !comparisonProjectQuery.isError && comparisonProjectQuery.data}>
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
            <Show when={isSourceProjectBacked()}>
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

                      if (!event.currentTarget.checked) {
                        setSelectedAdditionalSourceProjectIds([])
                      }
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Summary mode</p>
                    <p class="text-xs text-muted-foreground mt-1">
                      Use the primary project's overall human decisions and summary prompts for comparison.
                    </p>
                    <Show when={summaryModeUnavailableReason()}>
                      <p class="text-xs text-muted-foreground mt-1">{summaryModeUnavailableReason()}</p>
                    </Show>
                  </div>
                </label>
              </div>

              <div>
                <div class="flex items-center justify-between mb-2 gap-3">
                  <p class="block text-sm font-medium">Primary Project</p>
                  <Show when={selectedProjectCount() > 0}>
                    <span class="text-xs text-muted-foreground">{selectedProjectCount()} selected for comparison</span>
                  </Show>
                </div>
                <p class="text-xs text-muted-foreground mb-3">
                  The primary project controls content settings and, in summary mode, supplies the human summary
                  judgments.
                </p>
                <Show when={sourcesQuery.isLoading}>
                  <p class="text-sm text-muted-foreground">Loading projects...</p>
                </Show>
                <Show when={sourcesQuery.isError}>
                  <p class="text-sm text-red-600">
                    {sourcesQuery.error instanceof Error ? sourcesQuery.error.message : 'Failed to load projects'}
                  </p>
                </Show>
                <Show when={!sourcesQuery.isLoading && !sourcesQuery.isError && (sourcesQuery.data?.length ?? 0) > 0}>
                  <div class="space-y-2">
                    <For each={sourcesQuery.data ?? []}>
                      {(sourceProject) => {
                        return (
                          <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                            <input
                              type="radio"
                              name="source-project"
                              class="mt-1"
                              checked={selectedSourceProjectId() === sourceProject.id}
                              onChange={() => {
                                setSelectedSourceProjectId(sourceProject.id)
                                setSelectedAdditionalSourceProjectIds((currentValues) => {
                                  const nextValues = currentValues.filter((value) => {
                                    return value !== sourceProject.id
                                  })

                                  return sourceProject.isSummaryCapable && getSummaryPrompts(sourceProject).length > 0
                                    ? nextValues.filter((value) => {
                                        const nextProject = (sourcesQuery.data ?? []).find((candidateSourceProject) => {
                                          return candidateSourceProject.id === value
                                        })

                                        return nextProject
                                          ? !getAdditionalSummaryProjectReason(sourceProject, nextProject)
                                          : false
                                      })
                                    : []
                                })

                                if (!sourceProject.isSummaryCapable || getSummaryPrompts(sourceProject).length === 0) {
                                  setSummaryModeEnabled(false)
                                }
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
                                Content: {formatContentSettings(sourceProject)}
                              </p>
                              <p class="text-xs text-muted-foreground mt-1">
                                Prompts: {sourceProject.prompts.length} · Import routes:{' '}
                                {sourceProject.importRoutes.length}
                              </p>
                              <p
                                class="text-xs mt-1"
                                classList={{
                                  'text-emerald-700': sourceProject.isSummaryCapable,
                                  'text-muted-foreground': !sourceProject.isSummaryCapable,
                                }}
                              >
                                {sourceProject.isSummaryCapable
                                  ? `Summary mode available · ${getSummaryPrompts(sourceProject).length} summary prompts`
                                  : 'Summary mode unavailable for this project'}
                              </p>
                              <Show when={sourceProject.description}>
                                <p class="text-xs text-muted-foreground mt-1">{sourceProject.description}</p>
                              </Show>
                            </div>
                          </label>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </div>

              <Show when={summaryModeEnabled() && selectedSourceProject()}>
                <details class="border border-input rounded-md p-4 bg-muted/10" open>
                  <summary class="cursor-pointer list-none flex items-center justify-between gap-3">
                    <div>
                      <p class="text-sm font-medium text-gray-900">Additional Projects to Compare With</p>
                      <p class="text-xs text-muted-foreground mt-1">
                        The primary project stays the human summary source. Additional projects add their own summary
                        results.
                      </p>
                    </div>
                    <span class="text-xs text-muted-foreground">
                      {selectedAdditionalSourceProjectIds().length} selected
                    </span>
                  </summary>

                  <div class="mt-4 space-y-2">
                    <Show when={additionalSourceProjects().length === 0}>
                      <p class="text-sm text-muted-foreground">No additional projects are available.</p>
                    </Show>
                    <For each={additionalSourceProjects()}>
                      {(sourceProject) => {
                        const disabledReason = createMemo(() => {
                          return getAdditionalSummaryProjectReason(selectedSourceProject(), sourceProject)
                        })

                        return (
                          <label
                            class="flex items-start gap-3 border border-input rounded-md p-3"
                            classList={{
                              'cursor-pointer hover:bg-muted/50': !disabledReason(),
                              'opacity-60': Boolean(disabledReason()),
                            }}
                          >
                            <input
                              type="checkbox"
                              class="mt-1"
                              checked={selectedAdditionalSourceProjectIds().includes(sourceProject.id)}
                              disabled={Boolean(disabledReason())}
                              onChange={() => {
                                setSelectedAdditionalSourceProjectIds((currentValues) => {
                                  return togglePromptSelection(currentValues, sourceProject.id)
                                })
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
                                Content: {formatContentSettings(sourceProject)}
                              </p>
                              <p class="text-xs text-muted-foreground mt-1">
                                Summary prompts: {getSummaryPrompts(sourceProject).length} · Import routes:{' '}
                                {sourceProject.importRoutes.length}
                              </p>
                              <Show when={disabledReason()}>
                                <p class="text-xs text-red-600 mt-1">{disabledReason()}</p>
                              </Show>
                            </div>
                          </label>
                        )
                      }}
                    </For>
                  </div>
                </details>
              </Show>

              <Show when={summaryModeEnabled() && additionalProjectValidationError()}>
                <p class="text-sm text-red-600">{additionalProjectValidationError()}</p>
              </Show>
            </Show>

            <Show when={!isSourceProjectBacked()}>
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
                <label class="block text-sm font-medium mb-2">Models to Compare</label>
                <Show when={modelsQuery.isLoading}>
                  <p class="text-sm text-muted-foreground">Loading models...</p>
                </Show>
                <Show when={modelsQuery.isError}>
                  <p class="text-sm text-red-600">
                    {modelsQuery.error instanceof Error ? modelsQuery.error.message : 'Failed to load models'}
                  </p>
                </Show>
                <Show when={!modelsQuery.isLoading && !modelsQuery.isError}>
                  <Select.Root<{value: string; label: string}>
                    multiple
                    value={modelOptions().filter((option) => {
                      return selectedModelIds().includes(option.value)
                    })}
                    onChange={(values) => {
                      return setSelectedModelIds(
                        values.map((value) => {
                          return value.value
                        }),
                      )
                    }}
                    options={modelOptions()}
                    optionValue="value"
                    optionTextValue="label"
                    placeholder="All models"
                    name="comparison-project-models"
                    itemComponent={(itemProps) => {
                      return (
                        <Select.Item
                          item={itemProps.item}
                          class="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-muted data-[disabled]:opacity-50"
                        >
                          <Select.ItemLabel class="truncate">{itemProps.item.rawValue.label}</Select.ItemLabel>
                          <Select.ItemIndicator class="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="3"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              class="size-3"
                            >
                              <path d="M5 12l5 5l10 -10" />
                            </svg>
                          </Select.ItemIndicator>
                        </Select.Item>
                      )
                    }}
                  >
                    <Select.Trigger
                      class="group min-h-11 w-full rounded-md border border-input bg-background bg-white px-2 py-1.5 text-sm shadow-sm transition-[box-shadow,background-color] flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[expanded]:ring-2 data-[expanded]:ring-ring"
                      aria-label="Models to compare"
                    >
                      <div class="flex flex-wrap gap-2 grow">
                        <Show
                          when={selectedModelIds().length > 0}
                          fallback={<span class="text-muted-foreground">All models</span>}
                        >
                          <For each={selectedModelIds()}>
                            {(modelId) => {
                              const displayLabel =
                                modelOptions().find((option) => {
                                  return option.value === modelId
                                })?.label ?? modelId

                              return (
                                <span class="inline-flex items-center gap-1 rounded-md border border-input bg-muted/70 px-2 py-1 text-sm text-foreground">
                                  <span class="truncate max-w-[10rem]" title={displayLabel}>
                                    {displayLabel}
                                  </span>
                                  <button
                                    type="button"
                                    class="inline-flex size-4 items-center justify-center rounded hover:bg-muted-foreground/10"
                                    aria-label={`Remove ${displayLabel}`}
                                    onClick={() => {
                                      setSelectedModelIds((current) => {
                                        return current.filter((value) => {
                                          return value !== modelId
                                        })
                                      })
                                    }}
                                  >
                                    <svg
                                      xmlns="http://www.w3.org/2000/svg"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      stroke-width="2"
                                      stroke-linecap="round"
                                      stroke-linejoin="round"
                                      class="size-3"
                                    >
                                      <path d="M18 6L6 18" />
                                      <path d="M6 6l12 12" />
                                    </svg>
                                  </button>
                                </span>
                              )
                            }}
                          </For>
                        </Show>
                      </div>
                      <div class="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          class="inline-flex size-6 items-center justify-center rounded hover:bg-muted-foreground/10"
                          title="Clear selection"
                          aria-label="Clear selection"
                          onClick={() => {
                            return setSelectedModelIds([])
                          }}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            class="size-4 opacity-70"
                          >
                            <path d="M18 6L6 18" />
                            <path d="M6 6l12 12" />
                          </svg>
                        </button>
                        <Select.Icon>
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            class="size-4 opacity-60"
                          >
                            <path d="M6 9l6 6l6 -6" />
                          </svg>
                        </Select.Icon>
                      </div>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content class="z-50 min-w-56 rounded-md border bg-popover bg-white p-1 text-popover-foreground shadow-xl outline-none">
                        <Select.Listbox class="max-h-60 overflow-auto outline-none" />
                      </Select.Content>
                    </Select.Portal>
                  </Select.Root>
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
                        setHumanJudgmentMode('prompt')
                      }
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Compare with humans</p>
                    <p class="text-xs text-muted-foreground mt-1">{selectedHumanJudgmentModeLabel()}</p>
                  </div>
                </label>
                <Show when={compareWithHumans()}>
                  <div class="mt-4 grid gap-3 md:grid-cols-2">
                    <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer bg-background">
                      <input
                        type="radio"
                        name="human-judgment-mode"
                        class="mt-1"
                        checked={humanJudgmentMode() === 'prompt'}
                        onChange={() => {
                          return setHumanJudgmentMode('prompt')
                        }}
                      />
                      <div>
                        <p class="text-sm font-medium text-gray-900">Prompt mode</p>
                        <p class="text-xs text-muted-foreground mt-1">
                          Show one human column for each selected prompt.
                        </p>
                      </div>
                    </label>
                    <label
                      class="flex items-start gap-3 border border-input rounded-md p-3 bg-background"
                      classList={{'cursor-pointer': canUseSummaryMode(), 'opacity-50': !canUseSummaryMode()}}
                    >
                      <input
                        type="radio"
                        name="human-judgment-mode"
                        class="mt-1"
                        disabled={!canUseSummaryMode()}
                        checked={humanJudgmentMode() === 'summary'}
                        onChange={() => {
                          return setHumanJudgmentMode('summary')
                        }}
                      />
                      <div>
                        <p class="text-sm font-medium text-gray-900">Summary mode</p>
                        <p class="text-xs text-muted-foreground mt-1">Show overall human and LLM decision columns.</p>
                      </div>
                    </label>
                  </div>
                  <Show when={humanJudgmentMode() === 'summary' && comparisonProjectQuery.data?.summarySourceProject}>
                    {(summarySourceProject) => {
                      return (
                        <div class="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                          <p class="text-xs font-medium uppercase tracking-wide text-amber-800">
                            Summary Source Project
                          </p>
                          <p class="mt-1 text-sm font-medium text-gray-900">{summarySourceProject().name}</p>
                          <p class="mt-1 text-xs text-gray-600">{summarySourceProject().modelName}</p>
                        </div>
                      )
                    }}
                  </Show>
                </Show>
              </div>

              <div>
                <div class="flex items-center justify-between mb-2">
                  <label class="block text-sm font-medium">Prompts Used</label>
                  <span class="text-xs text-muted-foreground">
                    {selectedPromptIds().length} of {comparisonProjectQuery.data?.availablePrompts.length ?? 0} selected
                  </span>
                </div>
                <Show when={(comparisonProjectQuery.data?.availablePrompts.length ?? 0) === 0}>
                  <p class="text-sm text-muted-foreground">No prompts available.</p>
                </Show>
                <Show when={(comparisonProjectQuery.data?.availablePrompts.length ?? 0) > 0}>
                  <div class="space-y-3">
                    <For each={comparisonProjectQuery.data?.availablePrompts ?? []}>
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
                                <span class="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium bg-gray-50 text-gray-600">
                                  Created: {formatPromptCreatedAt(prompt.createdAt)}
                                </span>
                                <Show when={prompt.archived}>
                                  <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                                    Archived
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
                                      return togglePromptSelection(current, prompt.id)
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
            </Show>

            <div class="flex gap-3 pt-4">
              <Button type="submit" disabled={!canSubmit()}>
                {isLoading() ? 'Saving...' : 'Save Comparison Project'}
              </Button>
              <Button
                as={Link}
                to="/compare-judgments/$id"
                params={{id: comparisonProjectId()} as never}
                variant="outline"
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/compare-judgments/$id/edit')({component: EditComparisonProjectPage})
