import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createEffect, createSignal, For, Show, Suspense} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {fetchProjectWithPrompts} from '../../../../services/projectsService'
import {env} from '../../../utils/client-env'

type PromptInfo = {id: string; promptHeading: string | null; originalText: string; type: string | null}

const parseArktypeOptions = (typeStr: string | null): string[] => {
  if (!typeStr) return []
  const matches = typeStr.match(/['"]([^'"]+)['"]/g)
  return (
    matches?.map((m) => {
      return m.slice(1, -1)
    }) ?? []
  )
}

const getFilenameFromResponse = (response: Response, fallbackFilename: string): string => {
  const contentDisposition = response.headers.get('Content-Disposition')
  const filenameMatch = contentDisposition ? contentDisposition.match(/filename="([^"]+)"/) : null
  const filenameFromHeader = filenameMatch && filenameMatch[1] ? filenameMatch[1] : null
  return filenameFromHeader ?? fallbackFilename
}

const downloadResponseAsCsv = async (response: Response, fallbackFilename: string): Promise<void> => {
  const filename = getFilenameFromResponse(response, fallbackFilename)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

const ExportData = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string}).id

  // Fetch current project info with prompts
  const projectData = useQuery(() => {
    return {
      queryKey: ['project', projectId, 'with-prompts'],
      queryFn: () => {
        return fetchProjectWithPrompts(projectId)
      },
      refetchOnWindowFocus: false,
    }
  })

  // Map of promptId -> selected (boolean)
  const [selectedPrompts, setSelectedPrompts] = createSignal<Record<string, boolean>>({})
  const [includeExplanation, setIncludeExplanation] = createSignal(false)
  const [includeQuotes, setIncludeQuotes] = createSignal(false)
  const [includeJournal, setIncludeJournal] = createSignal(false)
  const [includeSummary, setIncludeSummary] = createSignal(false)
  const [includeArticleId, setIncludeArticleId] = createSignal(false)
  const [includeArticleLink, setIncludeArticleLink] = createSignal(false)
  const [includeArticleAuthors, setIncludeArticleAuthors] = createSignal(false)
  const [includeArticleCreatedAt, setIncludeArticleCreatedAt] = createSignal(false)
  const [includeArticleUpdatedAt, setIncludeArticleUpdatedAt] = createSignal(false)
  const [includePromptType, setIncludePromptType] = createSignal(false)
  const [includePromptContent, setIncludePromptContent] = createSignal(false)
  const [isExporting, setIsExporting] = createSignal(false)
  const [isExportingPrompts, setIsExportingPrompts] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [hasInitializedPrompts, setHasInitializedPrompts] = createSignal(false)
  const [promptAnswerFilters, setPromptAnswerFilters] = createSignal<Record<string, string[]>>({})
  const [hasInitializedFilters, setHasInitializedFilters] = createSignal(false)
  const [isFilterExpanded, setIsFilterExpanded] = createSignal(false)

  const togglePromptSelection = (promptId: string) => {
    setSelectedPrompts((current) => {
      const isSelected = current[promptId] ?? false
      if (isSelected) {
        const {[promptId]: _, ...rest} = current
        return rest
      }
      return {...current, [promptId]: true}
    })
  }

  // Get prompts from the current project (only enabled ones)
  const availablePrompts = (): PromptInfo[] => {
    const data = projectData.data
    if (!data || !Array.isArray(data.prompts)) {
      return []
    }
    return data.prompts
      .filter((p: {enabled?: boolean}) => {
        return p.enabled === true
      })
      .map((p: {id: string; promptHeading?: string | null; originalText: string; type?: string | null}) => {
        return {id: p.id, promptHeading: p.promptHeading ?? null, originalText: p.originalText, type: p.type ?? null}
      })
  }

  const promptsWithOptions = () => {
    return availablePrompts().map((p) => {
      return {...p, options: parseArktypeOptions(p.type)}
    })
  }

  const toggleAnswerFilter = (promptId: string, answerType: string) => {
    setPromptAnswerFilters((current) => {
      const currentTypes = current[promptId] ?? []
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

  const isAnswerFilterSelected = (promptId: string, answerType: string) => {
    const types = promptAnswerFilters()[promptId] ?? []
    return types.includes(answerType)
  }

  const isAllFiltersSelected = () => {
    const prompts = promptsWithOptions().filter((p) => {
      return p.options.length > 0
    })
    if (prompts.length === 0) return false
    const filters = promptAnswerFilters()
    return prompts.every((p) => {
      const selected = filters[p.id] ?? []
      return p.options.every((opt) => {
        return selected.includes(opt)
      })
    })
  }

  const toggleAllFilters = (select: boolean) => {
    const prompts = promptsWithOptions().filter((p) => {
      return p.options.length > 0
    })
    if (select) {
      const newFilters: Record<string, string[]> = {}
      for (const prompt of prompts) {
        newFilters[prompt.id] = [...prompt.options]
      }
      setPromptAnswerFilters(newFilters)
    } else {
      setPromptAnswerFilters({})
    }
  }

  // Prompt Header section helpers
  const isAllPromptHeaderSelected = () => {
    return includePromptType() && includePromptContent()
  }
  const toggleAllPromptHeader = (select: boolean) => {
    setIncludePromptType(select)
    setIncludePromptContent(select)
  }

  // Article section helpers
  const isAllArticleSelected = () => {
    return (
      includeArticleId()
      && includeArticleLink()
      && includeArticleAuthors()
      && includeSummary()
      && includeJournal()
      && includeArticleCreatedAt()
      && includeArticleUpdatedAt()
    )
  }
  const toggleAllArticle = (select: boolean) => {
    setIncludeArticleId(select)
    setIncludeArticleLink(select)
    setIncludeArticleAuthors(select)
    setIncludeSummary(select)
    setIncludeJournal(select)
    setIncludeArticleCreatedAt(select)
    setIncludeArticleUpdatedAt(select)
  }

  // Prompts section helpers
  const isAllPromptsSelected = () => {
    const prompts = availablePrompts()
    if (prompts.length === 0) return false
    const selected = selectedPrompts()
    return prompts.every((p) => {
      return selected[p.id] === true
    })
  }
  const toggleAllPrompts = (select: boolean) => {
    if (select) {
      const newSelected: Record<string, boolean> = {}
      for (const prompt of availablePrompts()) {
        newSelected[prompt.id] = true
      }
      setSelectedPrompts(newSelected)
    } else {
      setSelectedPrompts({})
    }
  }

  // Additional Columns section helpers
  const isAllAdditionalColumnsSelected = () => {
    return includeExplanation() && includeQuotes()
  }
  const toggleAllAdditionalColumns = (select: boolean) => {
    setIncludeExplanation(select)
    setIncludeQuotes(select)
  }

  // Auto-select all prompts on load (only once)
  createEffect(() => {
    const prompts = availablePrompts()
    if (prompts.length > 0 && !hasInitializedPrompts()) {
      const newSelectedPrompts: Record<string, boolean> = {}
      for (const prompt of prompts) {
        newSelectedPrompts[prompt.id] = true
      }
      setSelectedPrompts(newSelectedPrompts)
      setHasInitializedPrompts(true)
    }
  })

  // Mark filters as initialized when prompts are loaded
  // NOTE: We intentionally do NOT auto-select answer filters to match the behavior
  // of the reviews page, which shows all articles regardless of answer values
  createEffect(() => {
    const prompts = promptsWithOptions()
    if (prompts.length > 0 && !hasInitializedFilters()) {
      setHasInitializedFilters(true)
    }
  })

  const handleExport = async () => {
    setError(null)
    setIsExporting(true)

    try {
      const selectedPromptIds = Object.keys(selectedPrompts())
      const promptSelections = Object.entries(promptAnswerFilters())
        .filter(([_, types]) => {
          return types.length > 0
        })
        .map(([promptId, types]) => {
          return {promptId, types}
        })

      // Use native fetch for streaming response
      const response = await fetch(`${env.VITE_SERVER_API}/api/projects/${projectId}/export`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'include',
        body: JSON.stringify({
          promptIds: selectedPromptIds,
          promptSelections,
          sourceProjectIds: [projectId],
          includeExplanation: includeExplanation(),
          includeQuotes: includeQuotes(),
          includeJournal: includeJournal(),
          includeSummary: includeSummary(),
          includeArticleId: includeArticleId(),
          includeArticleLink: includeArticleLink(),
          includeArticleAuthors: includeArticleAuthors(),
          includeArticleCreatedAt: includeArticleCreatedAt(),
          includeArticleUpdatedAt: includeArticleUpdatedAt(),
          includePromptType: includePromptType(),
          includePromptContent: includePromptContent(),
        }),
      })

      if (!response.ok) {
        throw new Error('Export failed')
      }

      const filename = `export-${projectId}.csv`
      await downloadResponseAsCsv(response, filename)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred'
      setError(errorMessage)
    } finally {
      setIsExporting(false)
    }
  }

  const handleExportPrompts = async () => {
    setError(null)
    setIsExportingPrompts(true)

    try {
      const selectedPromptIds = Object.keys(selectedPrompts())

      const response = await fetch(`${env.VITE_SERVER_API}/api/projects/${projectId}/export-prompts`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'include',
        body: JSON.stringify({promptIds: selectedPromptIds}),
      })

      if (!response.ok) {
        throw new Error('Prompt export failed')
      }

      const filename = `prompts-${projectId}.csv`
      await downloadResponseAsCsv(response, filename)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred'
      setError(errorMessage)
    } finally {
      setIsExportingPrompts(false)
    }
  }

  const formatDate = (date: Date | string | null | undefined) => {
    if (!date) {
      return null
    }
    const d = typeof date === 'string' ? new Date(date) : date
    return format(d, 'yyyy-MM-dd')
  }

  return (
    <div class="p-6 max-w-4xl mx-auto">
      <div class="flex items-center gap-4 mb-6">
        <Button as={Link} to="/projects/$id" params={{id: projectId} as never} variant="outline" size="sm">
          ← Back to Project
        </Button>
        <h1 class="text-3xl font-bold">Export data</h1>
      </div>

      <Suspense fallback={<div class="text-center py-8">Loading...</div>}>
        <div class="bg-card border rounded-lg p-6">
          <Show when={error()}>
            <div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">{error()}</div>
          </Show>

          {/* Project Info */}
          <Show when={projectData.data}>
            {(data) => {
              const project = data().project
              return (
                <div class="mb-6 space-y-3">
                  <div>
                    <p class="text-sm font-medium text-muted-foreground">Project Name</p>
                    <p class="text-lg font-semibold">{project.name}</p>
                  </div>
                  <div class="grid grid-cols-2 gap-4">
                    <Show when={project.dateFrom}>
                      <div>
                        <p class="text-sm font-medium text-muted-foreground">Date From</p>
                        <p class="text-sm">{formatDate(project.dateFrom)}</p>
                      </div>
                    </Show>
                    <Show when={project.dateTo}>
                      <div>
                        <p class="text-sm font-medium text-muted-foreground">Date To</p>
                        <p class="text-sm">{formatDate(project.dateTo)}</p>
                      </div>
                    </Show>
                  </div>
                </div>
              )
            }}
          </Show>

          {/* Select Prompts */}
          <Show when={projectData.isLoading}>
            <p class="text-sm text-muted-foreground">Loading prompts...</p>
          </Show>
          <Show when={projectData.isError}>
            <p class="text-sm text-red-600">
              {projectData.error instanceof Error ? projectData.error.message : 'Failed to load project'}
            </p>
          </Show>
          <Show when={!projectData.isLoading && !projectData.isError && availablePrompts().length === 0}>
            <p class="text-sm text-muted-foreground">No prompts available for this project.</p>
          </Show>
          <Show when={!projectData.isLoading && !projectData.isError && availablePrompts().length > 0}>
            <div class="mb-6">
              <div class="flex items-center justify-between mb-2">
                <p class="block text-sm font-medium">Prompt Header</p>
                <button
                  type="button"
                  class="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                  onClick={() => {
                    return toggleAllPromptHeader(!isAllPromptHeaderSelected())
                  }}
                >
                  {isAllPromptHeaderSelected() ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              <p class="text-xs text-muted-foreground mb-3">Optionally add prompt metadata inside the header cells.</p>
              <div class="space-y-2">
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={includePromptType()}
                    onChange={(e) => {
                      setIncludePromptType(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Include Prompt Type in Headers</p>
                  </div>
                </label>
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={includePromptContent()}
                    onChange={(e) => {
                      setIncludePromptContent(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Include Prompt Content in Headers</p>
                  </div>
                </label>
              </div>
            </div>
            <div class="mb-6">
              <div class="flex items-center justify-between mb-2">
                <p class="block text-sm font-medium">Article</p>
                <button
                  type="button"
                  class="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                  onClick={() => {
                    return toggleAllArticle(!isAllArticleSelected())
                  }}
                >
                  {isAllArticleSelected() ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              <div class="space-y-2">
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={includeArticleId()}
                    onChange={(e) => {
                      setIncludeArticleId(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Include Article ID</p>
                  </div>
                </label>
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={includeArticleLink()}
                    onChange={(e) => {
                      setIncludeArticleLink(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Include Article Link (external)</p>
                  </div>
                </label>
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={includeArticleAuthors()}
                    onChange={(e) => {
                      setIncludeArticleAuthors(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Include Article Authors</p>
                  </div>
                </label>
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={includeSummary()}
                    onChange={(e) => {
                      setIncludeSummary(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Include Abstract/Summary</p>
                  </div>
                </label>
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={includeJournal()}
                    onChange={(e) => {
                      setIncludeJournal(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Include Journal</p>
                  </div>
                </label>
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={includeArticleCreatedAt()}
                    onChange={(e) => {
                      setIncludeArticleCreatedAt(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Include Article Created At</p>
                  </div>
                </label>
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={includeArticleUpdatedAt()}
                    onChange={(e) => {
                      setIncludeArticleUpdatedAt(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Include Article Updated At</p>
                  </div>
                </label>
              </div>
            </div>
            <div class="mb-6">
              <div class="flex items-center justify-between mb-2">
                <p class="block text-sm font-medium">Select Prompts to Export</p>
                <button
                  type="button"
                  class="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                  onClick={() => {
                    return toggleAllPrompts(!isAllPromptsSelected())
                  }}
                >
                  {isAllPromptsSelected() ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              <p class="text-xs text-muted-foreground mb-3">
                Select which prompts to include in the export. Each selected prompt will be a column in the CSV.
              </p>
              <div class="space-y-2">
                <For each={availablePrompts()}>
                  {(prompt) => {
                    return (
                      <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                        <input
                          type="checkbox"
                          class="mt-1"
                          checked={selectedPrompts()[prompt.id] ?? false}
                          onChange={() => {
                            togglePromptSelection(prompt.id)
                          }}
                        />
                        <div class="flex-1">
                          <p class="text-sm font-medium text-gray-900">{prompt.promptHeading || 'Untitled Prompt'}</p>
                        </div>
                      </label>
                    )
                  }}
                </For>
              </div>
            </div>

            {/* Additional Export Options */}
            <div class="mb-6">
              <div class="flex items-center justify-between mb-2">
                <p class="block text-sm font-medium">Additional Columns</p>
                <button
                  type="button"
                  class="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                  onClick={() => {
                    return toggleAllAdditionalColumns(!isAllAdditionalColumnsSelected())
                  }}
                >
                  {isAllAdditionalColumnsSelected() ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              <p class="text-xs text-muted-foreground mb-3">
                Optionally include explanation and quotes for each prompt answer.
              </p>
              <div class="space-y-2">
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={includeExplanation()}
                    onChange={(e) => {
                      setIncludeExplanation(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Include Explanation</p>
                    <p class="text-xs text-muted-foreground">Adds an explanation column for each selected prompt</p>
                  </div>
                </label>
                <label class="flex items-start gap-3 border border-input rounded-md p-3 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={includeQuotes()}
                    onChange={(e) => {
                      setIncludeQuotes(e.currentTarget.checked)
                    }}
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900">Include Quotes</p>
                    <p class="text-xs text-muted-foreground">Adds a quotes column for each selected prompt</p>
                  </div>
                </label>
              </div>
            </div>
          </Show>

          {/* Filter on Prompt Answers */}
          <Show
            when={promptsWithOptions().some((p) => {
              return p.options.length > 0
            })}
          >
            <div class="mb-6 border border-input rounded-lg">
              <div class="flex items-center justify-between p-4">
                <button
                  type="button"
                  class="flex items-center gap-2 text-left hover:text-muted-foreground"
                  onClick={() => {
                    setIsFilterExpanded(!isFilterExpanded())
                  }}
                >
                  <span class="text-muted-foreground">{isFilterExpanded() ? '▼' : '▶'}</span>
                  <span class="text-sm font-medium">Filter on Prompt Answers</span>
                </button>
                <button
                  type="button"
                  class="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                  onClick={() => {
                    toggleAllFilters(!isAllFiltersSelected())
                  }}
                >
                  {isAllFiltersSelected() ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              <Show when={isFilterExpanded()}>
                <div class="px-4 pb-4">
                  <p class="text-xs text-muted-foreground mb-3">
                    Filter which articles to include based on their prompt answers. Articles must match ALL selected
                    prompt/answer combinations. By default, no filtering is applied (all articles are included).
                    Selecting all options for a prompt is equivalent to not filtering on that prompt.
                  </p>
                  <div class="space-y-4">
                    <For
                      each={promptsWithOptions().filter((p) => {
                        return p.options.length > 0
                      })}
                    >
                      {(prompt) => {
                        return (
                          <div class="border border-input rounded-md p-4">
                            <p class="text-sm font-medium text-gray-900 mb-3">
                              {prompt.promptHeading || 'Untitled Prompt'}
                            </p>
                            <div class="flex flex-wrap gap-3">
                              <For each={prompt.options}>
                                {(answerType) => {
                                  return (
                                    <label class="flex items-center gap-2 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={isAnswerFilterSelected(prompt.id, answerType)}
                                        onChange={() => {
                                          toggleAnswerFilter(prompt.id, answerType)
                                        }}
                                      />
                                      <span class="text-sm">{answerType}</span>
                                    </label>
                                  )
                                }}
                              </For>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          </Show>

          {/* Export Button */}
          <div class="flex gap-3 pt-4">
            <Button
              onClick={() => {
                return void handleExport()
              }}
              disabled={isExporting() || isExportingPrompts()}
            >
              {isExporting() ? 'Exporting...' : 'Export to CSV'}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                return void handleExportPrompts()
              }}
              disabled={isExporting() || isExportingPrompts()}
            >
              {isExportingPrompts() ? 'Exporting Prompts...' : 'Export Prompt Info'}
            </Button>
          </div>
        </div>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/export')({component: ExportData})
