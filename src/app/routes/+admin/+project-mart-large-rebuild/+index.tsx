import {createMutation, useQuery, useQueryClient} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {format, formatDistanceToNow, intervalToDuration, isValid, parseISO} from 'date-fns'
import {createEffect, createMemo, createSignal, For, Show} from 'solid-js'

import {apiClient} from '../../../../services/apiClient.ts'
import {fetchProjects} from '../../../../services/projectsService.ts'

type ProjectMartLargeRebuildStatus = {
  estimates: {
    currentPhaseProgressPercent: number
    estimatedRemainingCyclesAtBatchSize1: number
    estimatedRemainingMs: number | null
    overallProgressPercent: number
    remainingPhaseArticleCount: number
    scannedPhaseArticleCount: number
    scopeArticleCount: number
  }
  largeRebuild: {
    createdAt: string | null
    cursorArticleCreatedAt: string | null
    cursorArticleId: string | null
    lastCompletedAt: string | null
    lastError: string | null
    lastStartedAt: string | null
    operatorNote: string | null
    rebuildPhase: string | null
    refreshStatus: string | null
    refreshToken: number | null
    updatedAt: string | null
  } | null
  project: {archived: boolean; id: string; name: string}
  refreshState: {
    activeDirtyToken: number
    dirtyToken: number
    lastCompletedDirtyToken: number
    lastError: string | null
    refreshStatus: string
    workerId: string | null
  } | null
}

type ProjectMartLargeRebuildRunResult = {
  backoffCount: number
  batchSize: number
  completedCycles: number
  cycleResults: Array<{
    articleCount?: number
    error?: string
    nextCursor?: {articleCreatedAt: string | null; articleId: string} | null
    projectId: string | null
    status: 'completed' | 'failed' | 'idle' | 'progressed'
    workerId: string
  }>
  maxCycles: number
  status: 'completed' | 'failed'
  stopReason: 'completed' | 'failed' | 'idle' | 'max-cycles' | 'no-progress' | 'paused' | 'phase-changed'
  totalBackoffMs: number
  until: 'completed' | 'failed' | 'idle' | 'phase-change' | 'max-cycles'
  workerId: string
}

type ProjectMartLargeRebuildRunInput = {
  batchSize?: number
  maxCycles: number
  maxNoProgressBackoffs?: number
  projectId: string
  until?: 'completed' | 'failed' | 'idle' | 'phase-change' | 'max-cycles'
}

const phaseOrder = [
  'prompt_answer_fact',
  'review_answer_dictionary',
  'review_article_filter_member',
  'review_article_rollup',
  'review_article_serving',
] as const

const getLargeRebuildStatusQueryKey = (projectId: string) => {
  return ['admin', 'project-mart-large-rebuild-status', projectId] as const
}

const formatValue = (value: string | number | boolean | null | undefined) => {
  return value === null || value === undefined || value === '' ? '—' : String(value)
}

const formatTimestamp = (value: string | null | undefined) => {
  if (!value) {
    return '—'
  }

  const parsed = parseISO(value)
  return isValid(parsed) ? `${format(parsed, 'yyyy-MM-dd HH:mm:ss')} (${formatDistanceToNow(parsed)} ago)` : value
}

const formatDurationText = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) {
    return '—'
  }

  const duration = intervalToDuration({end: new Date(ms), start: new Date(0)})
  const parts = [
    duration.days ? `${duration.days}d` : null,
    duration.hours ? `${duration.hours}h` : null,
    duration.minutes ? `${duration.minutes}m` : null,
    duration.seconds ? `${duration.seconds}s` : null,
  ].filter(Boolean)

  return parts.length > 0 ? parts.slice(0, 2).join(' ') : '0s'
}

const fetchProjectMartLargeRebuildStatus = async (projectId: string): Promise<ProjectMartLargeRebuildStatus> => {
  const response = await apiClient.api.admin['project-mart-large-rebuild-status'].get({query: {projectId}})

  if (response.error || !response.data) {
    throw new Error('Failed to fetch project mart large rebuild status')
  }

  return response.data as ProjectMartLargeRebuildStatus
}

const runProjectMartLargeRebuild = async (
  input: ProjectMartLargeRebuildRunInput,
): Promise<ProjectMartLargeRebuildRunResult> => {
  const response = await apiClient.api.admin['project-mart-large-rebuild-run'].post(input)

  if (response.error || !response.data) {
    throw new Error('Failed to run project mart large rebuild cycles')
  }

  return response.data as ProjectMartLargeRebuildRunResult
}

const pauseProjectMartLargeRebuild = async (projectId: string) => {
  const response = await apiClient.api.admin['project-mart-large-rebuild-pause'].post({projectId})

  if (response.error || !response.data) {
    throw new Error('Failed to pause project mart large rebuild')
  }

  return response.data
}

const resumeProjectMartLargeRebuild = async (projectId: string) => {
  const response = await apiClient.api.admin['project-mart-large-rebuild-resume'].post({projectId})

  if (response.error || !response.data) {
    throw new Error('Failed to resume project mart large rebuild')
  }

  return response.data
}

const saveProjectMartLargeRebuildNote = async ({note, projectId}: {note: string | null; projectId: string}) => {
  const response = await apiClient.api.admin['project-mart-large-rebuild-note'].post({note, projectId})

  if (response.error || !response.data) {
    throw new Error('Failed to save project mart large rebuild note')
  }

  return response.data
}

const getPhaseVisualState = (currentPhase: string | null, refreshStatus: string | null, phase: string) => {
  const currentIndex = currentPhase ? phaseOrder.indexOf(currentPhase as (typeof phaseOrder)[number]) : -1
  const phaseIndex = phaseOrder.indexOf(phase as (typeof phaseOrder)[number])

  return refreshStatus === 'paused'
    ? phaseIndex < currentIndex
      ? 'completed'
      : phaseIndex === currentIndex
        ? 'paused'
        : 'pending'
    : currentIndex === -1
      ? 'pending'
      : phaseIndex < currentIndex
        ? 'completed'
        : phaseIndex === currentIndex
          ? 'current'
          : 'pending'
}

const StatusBadge = (props: {value: string | null | undefined}) => {
  const className = () => {
    return props.value === 'failed'
      ? 'bg-red-50 text-red-700 ring-red-200'
      : props.value === 'running'
        ? 'bg-amber-50 text-amber-700 ring-amber-200'
        : props.value === 'paused'
          ? 'bg-violet-50 text-violet-700 ring-violet-200'
          : props.value === 'idle'
            ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
            : props.value === 'completed'
              ? 'bg-blue-50 text-blue-700 ring-blue-200'
              : 'bg-stone-100 text-stone-700 ring-stone-200'
  }

  return (
    <span
      class={`inline-flex rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ring-1 ring-inset ${className()}`}
    >
      {formatValue(props.value)}
    </span>
  )
}

const TimelinePhase = (props: {currentPhase: string | null; phase: string; refreshStatus: string | null}) => {
  const visualState = () => {
    return getPhaseVisualState(props.currentPhase, props.refreshStatus, props.phase)
  }
  const className = () => {
    return visualState() === 'completed'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : visualState() === 'current'
        ? 'border-blue-300 bg-blue-50 text-blue-900'
        : visualState() === 'paused'
          ? 'border-violet-300 bg-violet-50 text-violet-900'
          : 'border-stone-200 bg-white text-stone-500'
  }

  return (
    <div class={`rounded-xl border px-4 py-3 shadow-sm ${className()}`}>
      <div class="text-xs font-semibold uppercase tracking-wide opacity-70">{visualState()}</div>
      <div class="mt-1 text-sm font-medium">{props.phase}</div>
    </div>
  )
}

const MetricCard = (props: {label: string; value: string | number}) => {
  return (
    <div class="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">{props.label}</div>
      <div class="mt-2 text-lg font-semibold text-stone-900">{props.value}</div>
    </div>
  )
}

const AdminProjectMartLargeRebuildPage = () => {
  const [selectedProjectId, setSelectedProjectId] = createSignal('')
  const [runSummary, setRunSummary] = createSignal<ProjectMartLargeRebuildRunResult | null>(null)
  const [customBatchSize, setCustomBatchSize] = createSignal('1')
  const [customMaxCycles, setCustomMaxCycles] = createSignal('25')
  const [customBackoffLimit, setCustomBackoffLimit] = createSignal('3')
  const [customUntil, setCustomUntil] = createSignal<'completed' | 'failed' | 'idle' | 'phase-change' | 'max-cycles'>(
    'max-cycles',
  )
  const [operatorNoteInput, setOperatorNoteInput] = createSignal('')
  const [loadedProjectIdForNote, setLoadedProjectIdForNote] = createSignal('')
  const queryClient = useQueryClient()

  const projectsQuery = useQuery(() => {
    return {queryFn: fetchProjects, queryKey: ['projects'], staleTime: 5 * 60 * 1000}
  })

  const statusQuery = useQuery(() => {
    const projectId = selectedProjectId().trim()

    return {
      enabled: projectId !== '',
      queryFn: () => {
        return fetchProjectMartLargeRebuildStatus(projectId)
      },
      queryKey: getLargeRebuildStatusQueryKey(projectId),
      refetchInterval: 5_000,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
    }
  })

  const refreshSelectedProject = async () => {
    const projectId = selectedProjectId().trim()

    return projectId === ''
      ? undefined
      : Promise.all([
          queryClient.invalidateQueries({queryKey: getLargeRebuildStatusQueryKey(projectId)}),
          statusQuery.refetch(),
        ])
  }

  createEffect(() => {
    const projectId = statusQuery.data?.project.id ?? ''

    if (projectId !== '' && projectId !== loadedProjectIdForNote()) {
      setOperatorNoteInput(statusQuery.data?.largeRebuild?.operatorNote ?? '')
      setLoadedProjectIdForNote(projectId)
    }
  })

  const runMutation = createMutation(() => {
    return {
      mutationFn: async (input: ProjectMartLargeRebuildRunInput) => {
        return runProjectMartLargeRebuild(input)
      },
      onSuccess: async (result: ProjectMartLargeRebuildRunResult) => {
        setRunSummary(result)
        await refreshSelectedProject()
      },
    }
  })

  const pauseMutation = createMutation(() => {
    return {
      mutationFn: async (projectId: string) => {
        return pauseProjectMartLargeRebuild(projectId)
      },
      onSuccess: async () => {
        await refreshSelectedProject()
      },
    }
  })

  const resumeMutation = createMutation(() => {
    return {
      mutationFn: async (projectId: string) => {
        return resumeProjectMartLargeRebuild(projectId)
      },
      onSuccess: async () => {
        await refreshSelectedProject()
      },
    }
  })

  const noteMutation = createMutation(() => {
    return {
      mutationFn: async (input: {note: string | null; projectId: string}) => {
        return saveProjectMartLargeRebuildNote(input)
      },
      onSuccess: async () => {
        await refreshSelectedProject()
      },
    }
  })

  const latestCycleResult = createMemo(() => {
    const summary = runSummary()
    return summary && summary.cycleResults.length > 0 ? summary.cycleResults[summary.cycleResults.length - 1] : null
  })

  const isActionPending = () => {
    return runMutation.isPending || pauseMutation.isPending || resumeMutation.isPending || noteMutation.isPending
  }

  const triggerRun = (input: Omit<ProjectMartLargeRebuildRunInput, 'projectId'>) => {
    const projectId = selectedProjectId().trim()

    return projectId === '' ? undefined : runMutation.mutate({projectId, ...input})
  }

  const triggerCustomRun = () => {
    const batchSize = Math.max(1, Number(customBatchSize()) || 1)
    const maxCycles = Math.max(1, Number(customMaxCycles()) || 1)
    const maxNoProgressBackoffs = Math.max(0, Number(customBackoffLimit()) || 0)

    return triggerRun({batchSize, maxCycles, maxNoProgressBackoffs, until: customUntil()})
  }

  const triggerPause = () => {
    const projectId = selectedProjectId().trim()
    return projectId === '' ? undefined : pauseMutation.mutate(projectId)
  }

  const triggerResume = () => {
    const projectId = selectedProjectId().trim()
    return projectId === '' ? undefined : resumeMutation.mutate(projectId)
  }

  const triggerSaveNote = () => {
    const projectId = selectedProjectId().trim()
    return projectId === ''
      ? undefined
      : noteMutation.mutate({note: operatorNoteInput().trim() === '' ? null : operatorNoteInput(), projectId})
  }

  return (
    <div class="min-h-screen mx-auto bg-stone-50 p-6">
      <div class="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold text-stone-900">Project Mart Large Rebuild Status</h1>
          <p class="mt-1 text-sm text-stone-500">
            Operator view for staged large rebuild progress, notes, custom run controls, pause and resume, and bounded
            execution.
          </p>
        </div>
        <Link
          to="/admin/jobs"
          class="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-100"
        >
          Back to Jobs
        </Link>
      </div>

      <div class="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <div class="flex flex-col gap-3">
          <div class="flex-1">
            <label class="block text-sm font-medium text-stone-700" for="project-id-input">
              Project
            </label>
            <select
              id="project-id-input"
              class="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
              disabled={projectsQuery.isLoading || projectsQuery.isError || (projectsQuery.data?.length ?? 0) === 0}
              value={selectedProjectId()}
              onChange={(event) => {
                setRunSummary(null)
                setSelectedProjectId(event.currentTarget.value)
              }}
            >
              <option value="">Select an active project</option>
              <For each={projectsQuery.data ?? []}>
                {(project) => {
                  return <option value={project.id}>{project.name}</option>
                }}
              </For>
            </select>
          </div>

          <Show when={projectsQuery.isLoading}>
            <div class="text-sm text-stone-500">Loading active projects…</div>
          </Show>

          <Show when={projectsQuery.isError}>
            <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              Failed to load active projects:{' '}
              {projectsQuery.error instanceof Error ? projectsQuery.error.message : 'Unknown error'}
            </div>
          </Show>

          <Show when={!projectsQuery.isLoading && !projectsQuery.isError && (projectsQuery.data?.length ?? 0) === 0}>
            <div class="text-sm text-stone-500">No active projects available.</div>
          </Show>
        </div>
      </div>

      <Show when={selectedProjectId().trim() !== ''}>
        <div class="mt-6 space-y-6">
          <Show when={statusQuery.isLoading}>
            <div class="rounded-2xl border border-stone-200 bg-white p-6 text-sm text-stone-500 shadow-sm">
              Loading large rebuild status…
            </div>
          </Show>

          <Show when={statusQuery.isError}>
            <div class="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-700 shadow-sm">
              <div class="font-semibold">Failed to load project status</div>
              <div class="mt-2 text-sm">{statusQuery.error?.message ?? ''}</div>
            </div>
          </Show>

          <Show when={!statusQuery.isLoading && !statusQuery.isError && statusQuery.data}>
            {(status) => {
              return (
                <>
                  <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <MetricCard label="Project" value={status().project.name} />
                    <MetricCard
                      label="Large Rebuild Status"
                      value={formatValue(status().largeRebuild?.refreshStatus)}
                    />
                    <MetricCard label="Large Rebuild Phase" value={formatValue(status().largeRebuild?.rebuildPhase)} />
                    <MetricCard label="Overall Progress" value={`${status().estimates.overallProgressPercent}%`} />
                  </div>

                  <div class="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
                    <div class="mb-3 flex items-center justify-between gap-4">
                      <div>
                        <h2 class="text-lg font-semibold text-stone-900">Run Controls</h2>
                        <p class="text-sm text-stone-500">
                          Run bounded staged rebuild cycles, or pause and resume safely between cycles.
                        </p>
                      </div>
                      <div class="flex gap-2">
                        <button
                          class="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
                          disabled={isActionPending() || status().largeRebuild?.refreshStatus === 'paused'}
                          onClick={triggerPause}
                        >
                          Pause
                        </button>
                        <button
                          class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                          disabled={isActionPending() || status().largeRebuild?.refreshStatus !== 'paused'}
                          onClick={triggerResume}
                        >
                          Resume
                        </button>
                      </div>
                    </div>
                    <div class="flex flex-wrap gap-3">
                      <button
                        class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
                        disabled={isActionPending()}
                        onClick={() => {
                          return triggerRun({maxCycles: 1, maxNoProgressBackoffs: 3, until: 'max-cycles'})
                        }}
                      >
                        Run 1 Cycle
                      </button>
                      <button
                        class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
                        disabled={isActionPending()}
                        onClick={() => {
                          return triggerRun({maxCycles: 10, maxNoProgressBackoffs: 3, until: 'max-cycles'})
                        }}
                      >
                        Run 10 Cycles
                      </button>
                      <button
                        class="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-cyan-700 disabled:opacity-50"
                        disabled={isActionPending()}
                        onClick={() => {
                          return triggerRun({maxCycles: 50, maxNoProgressBackoffs: 3, until: 'phase-change'})
                        }}
                      >
                        Run Until Phase Changes
                      </button>
                      <button
                        class="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-700 disabled:opacity-50"
                        disabled={isActionPending()}
                        onClick={() => {
                          return triggerRun({maxCycles: 200, maxNoProgressBackoffs: 3, until: 'completed'})
                        }}
                      >
                        Run Until Completed
                      </button>
                    </div>
                    <div class="mt-4 grid gap-3 md:grid-cols-4">
                      <div>
                        <label class="block text-xs font-semibold uppercase tracking-wide text-stone-500">
                          Custom batch size
                        </label>
                        <input
                          class="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                          value={customBatchSize()}
                          onInput={(event) => {
                            return setCustomBatchSize(event.currentTarget.value)
                          }}
                        />
                      </div>
                      <div>
                        <label class="block text-xs font-semibold uppercase tracking-wide text-stone-500">
                          Custom max cycles
                        </label>
                        <input
                          class="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                          value={customMaxCycles()}
                          onInput={(event) => {
                            return setCustomMaxCycles(event.currentTarget.value)
                          }}
                        />
                      </div>
                      <div>
                        <label class="block text-xs font-semibold uppercase tracking-wide text-stone-500">
                          No-progress backoff limit
                        </label>
                        <input
                          class="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                          value={customBackoffLimit()}
                          onInput={(event) => {
                            return setCustomBackoffLimit(event.currentTarget.value)
                          }}
                        />
                      </div>
                      <div>
                        <label class="block text-xs font-semibold uppercase tracking-wide text-stone-500">
                          Stop when
                        </label>
                        <select
                          class="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                          value={customUntil()}
                          onChange={(event) => {
                            return setCustomUntil(event.currentTarget.value as ProjectMartLargeRebuildRunInput['until'])
                          }}
                        >
                          <option value="max-cycles">max-cycles</option>
                          <option value="phase-change">phase-change</option>
                          <option value="completed">completed</option>
                          <option value="idle">idle</option>
                          <option value="failed">failed</option>
                        </select>
                      </div>
                    </div>
                    <div class="mt-3">
                      <button
                        class="rounded-lg bg-stone-800 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-stone-900 disabled:opacity-50"
                        disabled={isActionPending()}
                        onClick={triggerCustomRun}
                      >
                        Run Custom Job
                      </button>
                    </div>
                    <Show when={isActionPending()}>
                      <div class="mt-3 text-sm text-stone-500">Applying operator action…</div>
                    </Show>
                    <Show
                      when={
                        runMutation.isError || pauseMutation.isError || resumeMutation.isError || noteMutation.isError
                      }
                    >
                      <div class="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {runMutation.error?.message
                          ?? pauseMutation.error?.message
                          ?? resumeMutation.error?.message
                          ?? noteMutation.error?.message
                          ?? 'Operator action failed'}
                      </div>
                    </Show>
                    <Show when={runSummary()}>
                      {(summary) => {
                        return (
                          <div class="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4 text-sm text-stone-700">
                            <div class="flex flex-wrap gap-4">
                              <div>
                                <span class="font-semibold">Status:</span> {summary().status}
                              </div>
                              <div>
                                <span class="font-semibold">Stop reason:</span> {summary().stopReason}
                              </div>
                              <div>
                                <span class="font-semibold">Cycles:</span> {summary().completedCycles}
                              </div>
                              <div>
                                <span class="font-semibold">Batch size:</span> {summary().batchSize}
                              </div>
                              <div>
                                <span class="font-semibold">Backoffs:</span> {summary().backoffCount}
                              </div>
                              <div>
                                <span class="font-semibold">Backoff time:</span>{' '}
                                {formatDurationText(summary().totalBackoffMs)}
                              </div>
                            </div>
                            <Show when={latestCycleResult()}>
                              {(latest) => {
                                return (
                                  <div class="mt-3">
                                    <div class="font-semibold">Latest cycle result</div>
                                    <pre class="mt-2 overflow-x-auto rounded-lg bg-white p-3 text-xs text-stone-800">
                                      {JSON.stringify(latest(), null, 2)}
                                    </pre>
                                  </div>
                                )
                              }}
                            </Show>
                          </div>
                        )
                      }}
                    </Show>
                  </div>

                  <div class="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
                    <div class="mb-3 flex items-center justify-between gap-4">
                      <div>
                        <h2 class="text-lg font-semibold text-stone-900">Operator Notes</h2>
                        <p class="text-sm text-stone-500">
                          Persist maintenance notes separately from errors so crash diagnosis and operator intent do not
                          get conflated.
                        </p>
                      </div>
                      <button
                        class="rounded-lg bg-stone-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-stone-800 disabled:opacity-50"
                        disabled={isActionPending()}
                        onClick={triggerSaveNote}
                      >
                        Save Note
                      </button>
                    </div>
                    <textarea
                      class="min-h-28 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                      value={operatorNoteInput()}
                      onInput={(event) => {
                        return setOperatorNoteInput(event.currentTarget.value)
                      }}
                    />
                  </div>

                  <div class="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
                    <div class="mb-3 flex items-center justify-between gap-4">
                      <div>
                        <h2 class="text-lg font-semibold text-stone-900">Progress And Estimates</h2>
                        <p class="text-sm text-stone-500">
                          Cursor-aware remaining work and rough ETA from current staged rebuild state.
                        </p>
                      </div>
                      <div class="flex gap-2">
                        <StatusBadge value={status().refreshState?.refreshStatus} />
                        <StatusBadge value={status().largeRebuild?.refreshStatus} />
                      </div>
                    </div>
                    <div class="h-4 w-full overflow-hidden rounded-full bg-stone-100">
                      <div
                        class="h-full bg-blue-600 transition-all"
                        style={{width: `${status().estimates.overallProgressPercent}%`}}
                      />
                    </div>
                    <div class="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-4 text-sm text-stone-600">
                      <div>
                        <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                          Current Phase Progress
                        </div>
                        <div class="mt-1 font-medium text-stone-900">
                          {status().estimates.currentPhaseProgressPercent}%
                        </div>
                      </div>
                      <div>
                        <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">Scope Articles</div>
                        <div class="mt-1 font-medium text-stone-900">{status().estimates.scopeArticleCount}</div>
                      </div>
                      <div>
                        <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">Scanned In Phase</div>
                        <div class="mt-1 font-medium text-stone-900">{status().estimates.scannedPhaseArticleCount}</div>
                      </div>
                      <div>
                        <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                          Remaining In Phase
                        </div>
                        <div class="mt-1 font-medium text-stone-900">
                          {status().estimates.remainingPhaseArticleCount}
                        </div>
                      </div>
                      <div>
                        <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                          Remaining Cycles At Batch Size 1
                        </div>
                        <div class="mt-1 font-medium text-stone-900">
                          {status().estimates.estimatedRemainingCyclesAtBatchSize1}
                        </div>
                      </div>
                      <div>
                        <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                          Estimated Remaining Time
                        </div>
                        <div class="mt-1 font-medium text-stone-900">
                          {formatDurationText(status().estimates.estimatedRemainingMs)}
                        </div>
                      </div>
                      <div>
                        <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">Dirty Token</div>
                        <div class="mt-1 font-medium text-stone-900">
                          {formatValue(status().refreshState?.dirtyToken)}
                        </div>
                      </div>
                      <div>
                        <div class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                          Last Completed Token
                        </div>
                        <div class="mt-1 font-medium text-stone-900">
                          {formatValue(status().refreshState?.lastCompletedDirtyToken)}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
                    <h2 class="text-lg font-semibold text-stone-900">Phase Timeline</h2>
                    <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                      <For each={phaseOrder}>
                        {(phase) => {
                          return (
                            <TimelinePhase
                              currentPhase={status().largeRebuild?.rebuildPhase ?? null}
                              phase={phase}
                              refreshStatus={status().largeRebuild?.refreshStatus ?? null}
                            />
                          )
                        }}
                      </For>
                    </div>
                  </div>

                  <div class="grid gap-6 xl:grid-cols-2">
                    <div class="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
                      <h2 class="text-lg font-semibold text-stone-900">Large Rebuild State</h2>
                      <dl class="mt-4 space-y-4 text-sm">
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">Refresh Status</dt>
                          <dd class="mt-1">
                            <StatusBadge value={status().largeRebuild?.refreshStatus} />
                          </dd>
                        </div>
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Cursor Article ID
                          </dt>
                          <dd class="mt-1 font-mono text-stone-900">
                            {formatValue(status().largeRebuild?.cursorArticleId)}
                          </dd>
                        </div>
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Cursor Article Created At
                          </dt>
                          <dd class="mt-1 text-stone-900">
                            {formatTimestamp(status().largeRebuild?.cursorArticleCreatedAt)}
                          </dd>
                        </div>
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">Created At</dt>
                          <dd class="mt-1 text-stone-900">{formatTimestamp(status().largeRebuild?.createdAt)}</dd>
                        </div>
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">Last Started At</dt>
                          <dd class="mt-1 text-stone-900">{formatTimestamp(status().largeRebuild?.lastStartedAt)}</dd>
                        </div>
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Last Completed At
                          </dt>
                          <dd class="mt-1 text-stone-900">{formatTimestamp(status().largeRebuild?.lastCompletedAt)}</dd>
                        </div>
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">Operator Note</dt>
                          <dd class="mt-1 whitespace-pre-wrap text-stone-900">
                            {formatValue(status().largeRebuild?.operatorNote)}
                          </dd>
                        </div>
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Last Error / Note
                          </dt>
                          <dd class="mt-1 whitespace-pre-wrap text-stone-900">
                            {formatValue(status().largeRebuild?.lastError)}
                          </dd>
                        </div>
                      </dl>
                    </div>

                    <div class="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
                      <h2 class="text-lg font-semibold text-stone-900">Refresh Ledger State</h2>
                      <dl class="mt-4 space-y-4 text-sm">
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">Project ID</dt>
                          <dd class="mt-1 font-mono text-stone-900">{status().project.id}</dd>
                        </div>
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Active Refresh Token
                          </dt>
                          <dd class="mt-1 text-stone-900">{formatValue(status().refreshState?.activeDirtyToken)}</dd>
                        </div>
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">
                            Large Rebuild Token
                          </dt>
                          <dd class="mt-1 text-stone-900">{formatValue(status().largeRebuild?.refreshToken)}</dd>
                        </div>
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">Worker ID</dt>
                          <dd class="mt-1 font-mono text-stone-900">{formatValue(status().refreshState?.workerId)}</dd>
                        </div>
                        <div>
                          <dt class="text-xs font-semibold uppercase tracking-wide text-stone-500">Ledger Error</dt>
                          <dd class="mt-1 whitespace-pre-wrap text-stone-900">
                            {formatValue(status().refreshState?.lastError)}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </div>
                </>
              )
            }}
          </Show>
        </div>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/project-mart-large-rebuild/')({
  component: AdminProjectMartLargeRebuildPage,
})
