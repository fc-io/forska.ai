import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {format} from 'date-fns'
import {createEffect, createSignal, For, Show, Suspense} from 'solid-js'

import {Button} from '../../../../components/ui/button'
import {fetchProjectWithPrompts} from '../../../../services/projectsService'
import {env} from '../../../utils/client-env'

type PromptInfo = {id: string; promptHeading: string | null; originalText: string; type: string | null}

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
  const [includePromptType, setIncludePromptType] = createSignal(false)
  const [includePromptContent, setIncludePromptContent] = createSignal(false)
  const [isExporting, setIsExporting] = createSignal(false)
  const [isExportingPrompts, setIsExportingPrompts] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

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

  const hasAnyPromptSelected = () => {
    return Object.keys(selectedPrompts()).length > 0
  }

  // Auto-select all prompts on load
  createEffect(() => {
    const prompts = availablePrompts()
    if (prompts.length > 0 && Object.keys(selectedPrompts()).length === 0) {
      const newSelectedPrompts: Record<string, boolean> = {}
      for (const prompt of prompts) {
        newSelectedPrompts[prompt.id] = true
      }
      setSelectedPrompts(newSelectedPrompts)
    }
  })

  const handleExport = async () => {
    setError(null)
    setIsExporting(true)

    try {
      const selectedPromptIds = Object.keys(selectedPrompts())
      if (selectedPromptIds.length === 0) {
        setError('Please select at least one prompt to export')
        setIsExporting(false)
        return
      }

      // Use native fetch for streaming response
      const response = await fetch(`${env.VITE_SERVER_API}/api/projects/${projectId}/export`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'include',
        body: JSON.stringify({
          promptIds: selectedPromptIds,
          sourceProjectIds: [projectId],
          includeExplanation: includeExplanation(),
          includeQuotes: includeQuotes(),
          includeJournal: includeJournal(),
          includeSummary: includeSummary(),
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
      if (selectedPromptIds.length === 0) {
        setError('Please select at least one prompt to export')
        setIsExportingPrompts(false)
        return
      }

      const response = await fetch(`${env.VITE_SERVER_API}/api/projects/${projectId}/export-prompts`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'include',
        body: JSON.stringify({
          promptIds: selectedPromptIds,
        }),
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
        <Button as={Link} to="/projects/$id" params={{id: projectId}} variant="outline" size="sm">
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
              <p class="block text-sm font-medium mb-2">Prompt Header</p>
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
              <p class="block text-sm font-medium mb-2">Article</p>
              <div class="space-y-2">
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
              </div>
            </div>
            <div class="mb-6">
              <p class="block text-sm font-medium mb-2">Select Prompts to Export</p>
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
              <p class="block text-sm font-medium mb-2">Additional Columns</p>
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

          {/* Export Button */}
          <div class="flex gap-3 pt-4">
            <Button
              onClick={() => {
                return void handleExport()
              }}
              disabled={!hasAnyPromptSelected() || isExporting() || isExportingPrompts()}
            >
              {isExporting() ? 'Exporting...' : 'Export to CSV'}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                return void handleExportPrompts()
              }}
              disabled={!hasAnyPromptSelected() || isExporting() || isExportingPrompts()}
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
