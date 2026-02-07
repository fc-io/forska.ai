import {useMutation, useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {createMemo, createSignal, For, Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'

type Project = {id: string; name: string; archived: boolean; modelName: string | null}

type DiagnoseResult = {
  project: {
    id: string
    name: string
    modelId: string
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
  }
  scope: {
    enabledPromptCount: number
    enabledPromptIds: string[]
    importRoutes: string[]
    importRouteNamesByRoute?: Record<string, string | null>
    curatedArticleCount: number
  }
  postgres: {articlesInScope: number; judgmentsInScope: number; judgmentsTotalMatchingSettings: number}
  clickhouse: {articlesInScope: number; judgmentsInScope: number}
  analysis: {
    expectedJudgments: number
    remainingToRun: number
    missingInClickhouse: number
    articlesFullyCovered: number
    articlesRemaining: number
  }
  error?: string
}

const formatImportRoute = (route: string, name: string | null | undefined): string => {
  const trimmedName = name?.trim() ?? ''
  return trimmedName && trimmedName !== route ? `${trimmedName} (${route})` : trimmedName || route
}

const formatImportRoutes = (routes: string[], namesByRoute?: Record<string, string | null>): string => {
  return routes
    .map((route) => {
      return formatImportRoute(route, namesByRoute?.[route] ?? null)
    })
    .join(', ')
}

const fetchProjects = async (includeArchived: boolean): Promise<Project[]> => {
  const activeResponse = await apiClient.api.projects.get()
  if (activeResponse.error) {
    throw new Error('Failed to fetch projects')
  }

  const activeData = activeResponse.data?.data ?? []
  const archivedResponse = includeArchived ? await apiClient.api.projects.archived.get() : null
  const archivedData = archivedResponse?.data?.data ?? []

  return [...activeData, ...archivedData]
}

const AdminDiagnoseUnassessed = () => {
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null)
  const [includeArchived, setIncludeArchived] = createSignal(false)
  const [formError, setFormError] = createSignal<string | null>(null)

  const diagnoseMutation = useMutation(() => {
    return {
      mutationFn: async (projectId: string): Promise<DiagnoseResult> => {
        const response = await apiClient.api.admin['diagnose-unassessed'].get({query: {projectId}})
        if (response.error) {
          throw new Error('Failed to fetch diagnosis')
        }
        if (!response.data) {
          throw new Error('No data returned')
        }
        return response.data as DiagnoseResult
      },
    }
  })

  const projectsQuery = useQuery(() => {
    return {
      queryKey: ['projects', {includeArchived: includeArchived()}],
      queryFn: () => {
        return fetchProjects(includeArchived())
      },
    }
  })

  const sortedProjects = createMemo(() => {
    const list = projectsQuery.data ?? []
    return [...list].sort((a, b) => {
      return a.name.localeCompare(b.name)
    })
  })

  const diagnosis = createMemo(() => {
    const data = diagnoseMutation.data
    return data && !data.error ? data : null
  })

  const handleDiagnose = () => {
    const id = selectedProjectId()
    if (!id) {
      setFormError('Please select a project')
      return
    }

    setFormError(null)
    diagnoseMutation.mutate(id)
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="mb-6">
        <h1 class="text-2xl font-bold">Diagnose Unassessed Articles</h1>
        <p class="text-sm text-gray-600 mt-1">
          Compare PostgreSQL and ClickHouse data to identify why articles show as unassessed
        </p>
      </div>

      <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        <div class="flex gap-4 items-center mb-4">
          <label class="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={includeArchived()}
              onChange={(e) => {
                setIncludeArchived(e.currentTarget.checked)
              }}
              class="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Include archived projects
          </label>
        </div>

        <div class="flex gap-4 items-end">
          <div class="flex-1">
            <label class="block text-sm font-medium text-gray-700 mb-1">Select Project</label>
            <select
              value={selectedProjectId() ?? ''}
              onChange={(e) => {
                setSelectedProjectId(e.currentTarget.value || null)
              }}
              disabled={projectsQuery.isLoading}
              class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
            >
              <option value="">{projectsQuery.isLoading ? 'Loading projects...' : '-- Select a project --'}</option>
              <For each={sortedProjects()}>
                {(project) => {
                  return (
                    <option value={project.id}>
                      {project.name}
                      {project.archived ? ' (archived)' : ''}
                      {project.modelName ? ` — ${project.modelName}` : ''}
                    </option>
                  )
                }}
              </For>
            </select>
          </div>
          <button
            onClick={() => {
              handleDiagnose()
            }}
            disabled={diagnoseMutation.isPending || !selectedProjectId()}
            class="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            {diagnoseMutation.isPending ? 'Diagnosing...' : 'Diagnose'}
          </button>
        </div>
      </div>

      <Show when={formError() || diagnoseMutation.isError || diagnoseMutation.data?.error}>
        <div class="p-4 rounded-md bg-red-50 border border-red-200 mb-6">
          <p class="text-red-600">
            {formError()
              || (diagnoseMutation.error instanceof Error ? diagnoseMutation.error.message : null)
              || diagnoseMutation.data?.error}
          </p>
        </div>
      </Show>

      <Show when={diagnosis()}>
        {(r) => {
          return (
            <div class="space-y-6">
              {/* Project Info */}
              <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <h2 class="text-lg font-semibold mb-4">Project: {r().project.name}</h2>
                <div class="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span class="text-gray-500">Model ID:</span>
                    <span class="ml-2 font-mono text-xs">{r().project.modelId}</span>
                  </div>
                  <div>
                    <span class="text-gray-500">Content Settings:</span>
                    <span class="ml-2">
                      {[
                        r().project.useTitle && 'Title',
                        r().project.useAbstract && 'Abstract',
                        r().project.useFulltext && 'Fulltext',
                        r().project.useFulltextNoImages && 'Fulltext (no images)',
                      ]
                        .filter(Boolean)
                        .join(', ') || 'None'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Scope */}
              <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <h2 class="text-lg font-semibold mb-4">Scope</h2>
                <div class="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span class="text-gray-500">Enabled Prompts:</span>
                    <span class="ml-2 font-semibold">{r().scope.enabledPromptCount}</span>
                  </div>
                  <div>
                    <span class="text-gray-500">Curated Articles:</span>
                    <span class="ml-2 font-semibold">{r().scope.curatedArticleCount.toLocaleString()}</span>
                  </div>
                  <div class="col-span-2">
                    <span class="text-gray-500">Import Routes:</span>
                    <span class="ml-2">
                      {r().scope.importRoutes.length > 0
                        ? formatImportRoutes(r().scope.importRoutes, r().scope.importRouteNamesByRoute)
                        : 'None'}
                    </span>
                  </div>
                </div>
                <Show when={r().scope.enabledPromptIds.length > 0 && r().scope.enabledPromptIds.length <= 10}>
                  <div class="mt-4">
                    <p class="text-sm text-gray-500 mb-2">Prompt IDs:</p>
                    <div class="flex flex-wrap gap-1">
                      <For each={r().scope.enabledPromptIds}>
                        {(id) => {
                          return (
                            <span class="px-2 py-0.5 bg-gray-100 rounded text-xs font-mono">{id.slice(0, 8)}...</span>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>

              {/* Key Numbers */}
              <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <h2 class="text-lg font-semibold mb-4">Analysis</h2>

                <div class="grid grid-cols-2 gap-6 mb-6">
                  <div class="p-4 bg-blue-50 rounded-lg">
                    <p class="text-sm text-blue-600 mb-1">Expected (full coverage)</p>
                    <p class="text-2xl font-bold text-blue-700">{r().analysis.expectedJudgments.toLocaleString()}</p>
                    <p class="text-xs text-blue-500 mt-1">
                      {r().postgres.articlesInScope.toLocaleString()} articles x {r().scope.enabledPromptCount} prompts
                    </p>
                  </div>
                  <div class="p-4 bg-green-50 rounded-lg">
                    <p class="text-sm text-green-600 mb-1">Actual (PostgreSQL, in scope)</p>
                    <p class="text-2xl font-bold text-green-700">{r().postgres.judgmentsInScope.toLocaleString()}</p>
                    <p class="text-xs text-green-500 mt-1">
                      {((r().postgres.judgmentsInScope / r().analysis.expectedJudgments) * 100).toFixed(1)}% coverage
                    </p>
                  </div>
                </div>

                <div class="grid grid-cols-3 gap-4 mb-6">
                  <div class="p-4 bg-gray-50 rounded-lg text-center">
                    <p class="text-sm text-gray-500">Articles in PG</p>
                    <p class="text-xl font-semibold">{r().postgres.articlesInScope.toLocaleString()}</p>
                  </div>
                  <div class="p-4 bg-gray-50 rounded-lg text-center">
                    <p class="text-sm text-gray-500">Articles in CH</p>
                    <p class="text-xl font-semibold">{r().clickhouse.articlesInScope.toLocaleString()}</p>
                  </div>
                  <div class="p-4 bg-gray-50 rounded-lg text-center">
                    <p class="text-sm text-gray-500">Judgments in CH</p>
                    <p class="text-xl font-semibold">{r().clickhouse.judgmentsInScope.toLocaleString()}</p>
                  </div>
                </div>

                {/* Problem Summary */}
                <div class="space-y-3">
                  <Show when={r().analysis.remainingToRun > 0}>
                    <div class="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                      <p class="text-blue-700 font-medium">
                        {r().analysis.remainingToRun.toLocaleString()} judgments remaining to run
                      </p>
                      <p class="text-sm text-blue-600 mt-1">
                        {r().analysis.articlesRemaining.toLocaleString()} articles still need judgments. The judgment
                        job will create these.
                      </p>
                    </div>
                  </Show>

                  <Show when={r().analysis.missingInClickhouse > 0}>
                    <div class="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                      <p class="text-yellow-700 font-medium">
                        Missing {r().analysis.missingInClickhouse.toLocaleString()} judgments in ClickHouse
                      </p>
                      <p class="text-sm text-yellow-600 mt-1">
                        These judgments exist in PostgreSQL but not in ClickHouse. PeerDB is responsible for syncing;
                        check `/admin/sync-stats` for lag and health.
                      </p>
                    </div>
                  </Show>

                  <Show when={r().clickhouse.articlesInScope < r().postgres.articlesInScope}>
                    <div class="p-4 bg-red-50 border border-red-200 rounded-lg">
                      <p class="text-red-700 font-medium">
                        Missing {(r().postgres.articlesInScope - r().clickhouse.articlesInScope).toLocaleString()}{' '}
                        articles in ClickHouse
                      </p>
                      <p class="text-sm text-red-600 mt-1 mb-3">
                        Articles exist in PostgreSQL but not in ClickHouse. The job uses ClickHouse to find unassessed
                        articles, so these won't be picked up. PeerDB is responsible for syncing; check
                        `/admin/sync-stats`.
                      </p>
                    </div>
                  </Show>

                  <Show
                    when={
                      r().analysis.remainingToRun === 0
                      && r().analysis.missingInClickhouse === 0
                      && r().clickhouse.articlesInScope >= r().postgres.articlesInScope
                    }
                  >
                    <div class="p-4 bg-green-50 border border-green-200 rounded-lg">
                      <p class="text-green-700 font-medium">All articles have full judgment coverage!</p>
                    </div>
                  </Show>
                </div>
              </div>
            </div>
          )
        }}
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/diagnose-unassessed/')({component: AdminDiagnoseUnassessed})
