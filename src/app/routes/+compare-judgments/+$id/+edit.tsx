import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createEffect, createSignal, For, Show} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {
  type ComparisonProjectEditFormData,
  fetchComparisonProjectEditFormData,
  updateComparisonProject,
  type UpdateComparisonProjectInput,
} from '../../../../services/comparisonProjectsService'

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

const getSelectedPromptIds = (comparisonProject: ComparisonProjectEditFormData) => {
  return [...comparisonProject.promptSelections]
    .sort((left, right) => {
      return left.order - right.order
    })
    .map((selection) => {
      return selection.promptId
    })
}

const EditComparisonProjectPage = () => {
  const navigate = useNavigate()
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
  const [comparisonProjectName, setComparisonProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [compareWithHumans, setCompareWithHumans] = createSignal(false)
  const [selectedPromptIds, setSelectedPromptIds] = createSignal<string[]>([])
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [initializedComparisonProjectId, setInitializedComparisonProjectId] = createSignal<string | null>(null)

  createEffect(() => {
    const comparisonProject = comparisonProjectQuery.data

    if (!comparisonProject || initializedComparisonProjectId() === comparisonProject.id) {
      return
    }

    setComparisonProjectName(comparisonProject.name)
    setDescription(comparisonProject.description ?? '')
    setCompareWithHumans(comparisonProject.compareWithHumans)
    setSelectedPromptIds(getSelectedPromptIds(comparisonProject))
    setInitializedComparisonProjectId(comparisonProject.id)
  })

  const handleSubmit = async (event: Event) => {
    event.preventDefault()
    setError(null)

    const updateComparisonProjectInput: UpdateComparisonProjectInput = {
      name: comparisonProjectName().trim(),
      description: description().trim() || null,
      compareWithHumans: compareWithHumans(),
      promptSelections: selectedPromptIds().map((promptId, index) => {
        return {promptId, order: index}
      }),
    }

    setIsLoading(true)

    try {
      await updateComparisonProject(comparisonProjectId(), updateComparisonProjectInput)
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
        <h1 class="text-3xl font-bold">Edit Comparison Project</h1>
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

            <div class="flex gap-3 pt-4">
              <Button type="submit" disabled={!comparisonProjectName().trim() || isLoading()}>
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
