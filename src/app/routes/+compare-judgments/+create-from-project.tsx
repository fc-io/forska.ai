import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {createMemo, createSignal, For, Show} from 'solid-js'

import {Button} from '../../../components/ui/button'
import {
  type ComparisonProjectSource,
  createComparisonProjectFromProject,
  type CreateComparisonProjectFromProjectInput,
  fetchComparisonProjectSources,
} from '../../../services/comparisonProjectsService'

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

const formatContentSettings = (sourceProject: ComparisonProjectSource) => {
  const parts = [
    sourceProject.useTitle ? 'title' : null,
    sourceProject.useAbstract ? 'abstract' : null,
    sourceProject.useFulltextNoImages ? 'fulltext (no images)' : sourceProject.useFulltext ? 'fulltext' : null,
  ].filter(Boolean) as string[]

  return parts.length > 0 ? parts.join(' + ') : 'none'
}

const CreateCompareJudgmentsFromProjectPage = () => {
  const navigate = useNavigate()
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
  const [dateFrom, setDateFrom] = createSignal('')
  const [dateTo, setDateTo] = createSignal('')
  const [compareWithHumans, setCompareWithHumans] = createSignal(false)
  const [summaryModeEnabled, setSummaryModeEnabled] = createSignal(false)
  const [selectedSourceProjectId, setSelectedSourceProjectId] = createSignal('')
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const selectedSourceProject = createMemo(() => {
    return (sourcesQuery.data ?? []).find((sourceProject) => {
      return sourceProject.id === selectedSourceProjectId()
    })
  })
  const summaryModeUnavailableReason = createMemo(() => {
    if (sourcesQuery.isLoading) {
      return 'Select a source project after projects finish loading.'
    }

    if (sourcesQuery.isError) {
      return sourcesQuery.error instanceof Error ? sourcesQuery.error.message : 'Failed to load projects'
    }

    if (!selectedSourceProjectId()) {
      return 'Select a source project to check summary support.'
    }

    return selectedSourceProject()?.isSummaryCapable ? null : 'Selected project is not summary-capable.'
  })
  const canSubmit = createMemo(() => {
    return Boolean(comparisonProjectName().trim() && selectedSourceProjectId() && !isLoading())
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

    if (!selectedSourceProjectId().trim()) {
      setError('Select one project to import from')
      return
    }

    const summaryValidationError = summaryModeEnabled() ? summaryModeUnavailableReason() : null
    if (summaryValidationError) {
      setError(summaryValidationError)
      return
    }

    const createComparisonProjectInput: CreateComparisonProjectFromProjectInput = {
      name: comparisonProjectName().trim(),
      description: description().trim() || undefined,
      compareWithHumans: compareWithHumans(),
      humanJudgmentMode: summaryModeEnabled() ? 'summary' : 'prompt',
      summarySourceProjectId: summaryModeEnabled() ? selectedSourceProjectId() : null,
      dateFrom: startDateResult.normalized ?? undefined,
      dateTo: endDateResult.normalized ?? undefined,
      sourceProjectId: selectedSourceProjectId(),
    }

    setIsLoading(true)

    try {
      await createComparisonProjectFromProject(createComparisonProjectInput)
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
        <h1 class="text-3xl font-bold">Compare Project</h1>
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
                  Use the selected source project's overall human decisions for comparison.
                </p>
                <Show when={summaryModeUnavailableReason()}>
                  <p class="text-xs text-muted-foreground mt-1">{summaryModeUnavailableReason()}</p>
                </Show>
              </div>
            </label>
          </div>

          <div>
            <p class="block text-sm font-medium mb-2">Import from Project</p>
            <Show when={sourcesQuery.isLoading}>
              <p class="text-sm text-muted-foreground">Loading projects...</p>
            </Show>
            <Show when={sourcesQuery.isError}>
              <p class="text-sm text-red-600">
                {sourcesQuery.error instanceof Error ? sourcesQuery.error.message : 'Failed to load projects'}
              </p>
            </Show>
            <Show when={!sourcesQuery.isLoading && !sourcesQuery.isError && (sourcesQuery.data?.length ?? 0) === 0}>
              <p class="text-sm text-muted-foreground">No source projects with prompts available.</p>
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

                            if (!sourceProject.isSummaryCapable) {
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
                            Prompts: {sourceProject.prompts.length} · Import routes: {sourceProject.importRoutes.length}
                          </p>
                          <p
                            class="text-xs mt-1"
                            classList={{
                              'text-emerald-700': sourceProject.isSummaryCapable,
                              'text-muted-foreground': !sourceProject.isSummaryCapable,
                            }}
                          >
                            {sourceProject.isSummaryCapable
                              ? 'Summary mode available'
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

export const Route = createFileRoute('/compare-judgments/create-from-project')({
  component: CreateCompareJudgmentsFromProjectPage,
})
