import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createSignal, For, Show} from 'solid-js'
import {createStore} from 'solid-js/store'

import {Button} from '../../../components/ui/button'
import {apiClient} from '../../../services/apiClient'
import {fetchSession} from '../../../services/fetchSession'
import {handleApiResponse} from '../../../services/utils/handleApiResponse'

type PromptItem = {id: string; content: string; promptHeading: string; type: string}

type ParsedDateResult = {date: Date | null; normalized: string | null; error: string | null}

type DataSourceOption = {id: string; title: string; description: string | null}

type DataSourcesResponse = {data: DataSourceOption[]}

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
  const dataSourcesQuery = useQuery(() => {
    return {
      queryKey: ['datasources'],
      queryFn: async () => {
        const response = await apiClient.api.datasources.get()
        const result = handleApiResponse<DataSourcesResponse>(response, 'Failed to load data sources')
        return result.data ?? []
      },
      staleTime: 1000 * 60 * 5,
    }
  })
  const navigate = useNavigate()
  const [projectName, setProjectName] = createSignal('')
  const [description, setDescription] = createSignal('')
  const [dateFrom, setDateFrom] = createSignal('')
  const [dateTo, setDateTo] = createSignal('')
  const [prompts, setPrompts] = createStore<PromptItem[]>([
    {id: crypto.randomUUID(), content: '', promptHeading: '', type: ''},
  ])
  const [selectedDataSourceIds, setSelectedDataSourceIds] = createSignal<string[]>([])
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const availableDataSources = () => {
    return dataSourcesQuery.data ?? []
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

  const toggleDataSourceSelection = (id: string) => {
    setSelectedDataSourceIds((current) => {
      const hasId = current.includes(id)
      return hasId
        ? current.filter((value) => {
            return value !== id
          })
        : [...current, id]
    })
  }

  const createProject = async (
    name: string,
    description: string,
    promptItems: PromptItem[],
    dataSourceIds: string[],
    startDate?: string,
    endDate?: string,
  ) => {
    // Filter valid prompts
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

    if (!sessionQuery.data?.user.id) {
      throw new Error('User must be authenticated to create a project')
    }

    const uniqueDataSourceIds = [...new Set(dataSourceIds)]

    const response = await apiClient.api.projects.post({
      name,
      description: description.trim() || undefined,
      ownerId: sessionQuery.data.user.id,
      prompts: validPrompts,
      dateFrom: startDate,
      dateTo: endDate,
      dataSourceIds: uniqueDataSourceIds.length > 0 ? uniqueDataSourceIds : undefined,
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
      await createProject(
        projectName(),
        description(),
        prompts,
        selectedDataSourceIds(),
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
        <Button as={Link} href="/projects" variant="outline" size="sm">
          ← Back to Projects
        </Button>
        <h1 class="text-3xl font-bold">Create New Project</h1>
      </div>

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
            <p class="block text-sm font-medium mb-2">Data Sources</p>
            <Show when={dataSourcesQuery.isLoading}>
              <p class="text-sm text-muted-foreground">Loading data sources...</p>
            </Show>
            <Show when={dataSourcesQuery.isError}>
              <p class="text-sm text-red-600">
                {dataSourcesQuery.error instanceof Error
                  ? dataSourcesQuery.error.message
                  : 'Failed to load data sources'}
              </p>
            </Show>
            <Show
              when={!dataSourcesQuery.isLoading && !dataSourcesQuery.isError && availableDataSources().length === 0}
            >
              <p class="text-sm text-muted-foreground">No data sources available.</p>
            </Show>
            <Show
              when={!dataSourcesQuery.isLoading && !dataSourcesQuery.isError && availableDataSources().length > 0}
            >
              <div class="space-y-2">
                <For each={availableDataSources()}>
                  {(source) => {
                    return (
                      <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer">
                        <input
                          type="checkbox"
                          class="mt-1"
                          checked={selectedDataSourceIds().includes(source.id)}
                          onChange={() => {
                            return toggleDataSourceSelection(source.id)
                          }}
                        />
                        <div class="flex-1">
                          <p class="text-sm font-medium text-gray-900">{source.title}</p>
                          <Show when={source.description}>
                            {(descriptionText) => {
                              return <p class="text-sm text-muted-foreground">{descriptionText()}</p>
                            }}
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

          <div class="flex gap-3 pt-4">
            <Button type="submit" disabled={!projectName().trim() || isLoading()}>
              {isLoading() ? 'Creating...' : 'Create Project'}
            </Button>
            <Button as={Link} href="/projects" variant="outline">
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/projects/create')({component: CreateProject})
