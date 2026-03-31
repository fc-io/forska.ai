import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {formatDate, formatDistanceToNow} from 'date-fns'
import {createMemo, createSignal, For, Show, Suspense} from 'solid-js'

import {RuntimeModelNotice} from '../../../../components/main/runtimeModelNotice.tsx'
import {TokenUsageTimeline} from '../../../../components/TokenUsageTimeline'
import {getTotalTokenUsage, pauseJudgmentsJob, startJudgmentsJob} from '../../../../services/judgmentsJobsService'
import {fetchProjects} from '../../../../services/projectsService'
import {getSglangRuntimeModelNotice} from '../../../../utils/getSglangRuntimeModelNotice.ts'
import {fetchProviderConnections} from '../+models/providerConnectionsClient.ts'
import {
  formatNumber,
  formatStatus,
  getActionErrorMessage,
  getHealthBadgeColor,
  getJudgmentsJobsQuery,
  getStatusColor,
  isHealthyBadge,
  type JobHealthBadge,
} from './jobsPageShared'

const TokenUsageTimelineCardFallback = () => {
  return (
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div class="mb-6">
        <h2 class="text-lg font-semibold text-gray-900">Token Usage Timeline</h2>
        <div class="text-sm text-gray-400 mt-1">Loading timeline...</div>
      </div>
      <div class="h-64 flex items-center justify-center">
        <p class="text-gray-500">Loading token usage data...</p>
      </div>
    </div>
  )
}

const tokenUsageQueryKey = ['total-token-usage'] as const

const getTokenUsageQuery = () => {
  return {queryKey: tokenUsageQueryKey, queryFn: getTotalTokenUsage, refetchInterval: 30000, refetchOnWindowFocus: true}
}

const TokenUsageSummaryFallback = () => {
  return <span class="text-gray-400">Loading token totals...</span>
}

const TokenUsageSummary = () => {
  const tokenUsage = useQuery(getTokenUsageQuery)

  return (
    <Show when={!tokenUsage.isLoading} fallback={<TokenUsageSummaryFallback />}>
      <>
        <span>
          <span class="font-semibold text-purple-600">{formatNumber(tokenUsage.data?.totalTokens ?? 0)}</span> total
          tokens
        </span>
        <span>
          <span class="font-semibold text-indigo-600">{formatNumber(tokenUsage.data?.totalPromptTokens ?? 0)}</span>{' '}
          prompt
        </span>
        <span>
          <span class="font-semibold text-cyan-600">{formatNumber(tokenUsage.data?.totalCompletionTokens ?? 0)}</span>{' '}
          completion
        </span>
      </>
    </Show>
  )
}

const JudgmentsJobsCountsFallback = () => {
  return <span class="border-l border-gray-300 pl-6 text-gray-400">Loading jobs...</span>
}

const JudgmentsJobsCounts = () => {
  const jobs = useQuery(getJudgmentsJobsQuery)
  const counts = createMemo(() => {
    const data = jobs.data ?? []
    return data.reduce(
      (acc, job) => {
        const status = job.status
        const running = status === 'running' ? acc.running + 1 : acc.running
        const completed = status === 'completed' ? acc.completed + 1 : acc.completed
        const failed = status === 'failed' ? acc.failed + 1 : acc.failed
        return {running, completed, failed}
      },
      {running: 0, completed: 0, failed: 0},
    )
  })

  return (
    <Show when={!jobs.isLoading} fallback={<JudgmentsJobsCountsFallback />}>
      <>
        <span class="border-l border-gray-300 pl-6">
          <span class="font-semibold text-gray-900">{jobs.data?.length ?? 0}</span> total jobs
        </span>
        <span>
          <span class="font-semibold text-blue-600">{counts().running}</span> running
        </span>
        <span>
          <span class="font-semibold text-green-600">{counts().completed}</span> completed
        </span>
        <span>
          <span class="font-semibold text-red-600">{counts().failed}</span> failed
        </span>
      </>
    </Show>
  )
}

const HealthSummaryStripFallback = () => {
  return (
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <div class="text-sm text-gray-400">Loading health summary...</div>
    </div>
  )
}

const HealthSummaryStrip = () => {
  const jobs = useQuery(getJudgmentsJobsQuery)
  const counts = createMemo(() => {
    const data = jobs.data ?? []

    return data.reduce(
      (acc, job) => {
        return {
          draining: job.storageState === 'draining' ? acc.draining + 1 : acc.draining,
          quarantined: job.storageState === 'quarantined' ? acc.quarantined + 1 : acc.quarantined,
          retainedOutbox: job.health.badges.includes('Retained Outbox') ? acc.retainedOutbox + 1 : acc.retainedOutbox,
          staleImport: job.health.badges.includes('Stale Import') ? acc.staleImport + 1 : acc.staleImport,
        }
      },
      {draining: 0, quarantined: 0, retainedOutbox: 0, staleImport: 0},
    )
  })

  return (
    <Show when={!jobs.isLoading} fallback={<HealthSummaryStripFallback />}>
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div class="flex items-center gap-3 flex-wrap text-sm text-gray-600">
          <span class="font-medium text-gray-900">Health Summary</span>
          <span class="rounded-full bg-amber-50 px-3 py-1 text-amber-700 ring-1 ring-inset ring-amber-200">
            {counts().draining} draining
          </span>
          <span class="rounded-full bg-red-50 px-3 py-1 text-red-700 ring-1 ring-inset ring-red-200">
            {counts().quarantined} quarantined
          </span>
          <span class="rounded-full bg-violet-50 px-3 py-1 text-violet-700 ring-1 ring-inset ring-violet-200">
            {counts().retainedOutbox} retained outbox
          </span>
          <span class="rounded-full bg-fuchsia-50 px-3 py-1 text-fuchsia-700 ring-1 ring-inset ring-fuchsia-200">
            {counts().staleImport} stale import
          </span>
        </div>
      </div>
    </Show>
  )
}

const JudgmentsJobsTableFallback = () => {
  return (
    <div>
      <div class="text-sm text-gray-500 mb-2">Loading jobs...</div>
      <div class="overflow-x-auto bg-white rounded-lg shadow">
        <table class="min-w-full divide-y divide-gray-200">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Job ID</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Project</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Health</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Updated</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody class="bg-white divide-y divide-gray-200">
            <For each={[0, 1, 2, 3, 4]}>
              {() => {
                return (
                  <tr>
                    <td class="px-6 py-4 whitespace-nowrap">
                      <div class="h-4 w-20 animate-pulse rounded bg-gray-200" />
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                      <div class="h-4 w-32 animate-pulse rounded bg-gray-200" />
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                      <div class="h-4 w-16 animate-pulse rounded bg-gray-200" />
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                      <div class="h-4 w-32 animate-pulse rounded bg-gray-200" />
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                      <div class="h-4 w-28 animate-pulse rounded bg-gray-200" />
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                      <div class="h-4 w-28 animate-pulse rounded bg-gray-200" />
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                      <div class="h-4 w-20 animate-pulse rounded bg-gray-200" />
                    </td>
                  </tr>
                )
              }}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  )
}

const JudgmentsJobsTable = () => {
  const jobs = useQuery(getJudgmentsJobsQuery)
  const [startingJobs, setStartingJobs] = createSignal<Set<string>>(new Set())
  const [startJobErrors, setStartJobErrors] = createSignal<Record<string, string>>({})
  const projects = useQuery(() => {
    return {queryKey: ['projects'], queryFn: fetchProjects, staleTime: 5 * 60 * 1000, suspense: false}
  })
  const providerConnections = useQuery(() => {
    return {
      queryKey: ['provider-connections', 'admin-jobs'],
      queryFn: fetchProviderConnections,
      staleTime: 60 * 1000,
      suspense: false,
    }
  })
  const projectById = createMemo(() => {
    return new Map(
      (projects.data ?? []).map((project) => {
        return [project.id, project] as const
      }),
    )
  })
  const providerModelById = createMemo(() => {
    return new Map(
      (providerConnections.data?.connections ?? []).flatMap((connection) => {
        return connection.models.map((model) => {
          return [model.id, model] as const
        })
      }),
    )
  })
  const getJobRuntimeNotice = (job: {projectId: string}) => {
    const project = projectById().get(job.projectId)
    const providerModel = project ? providerModelById().get(project.modelId) : null

    return providerModel
      ? getSglangRuntimeModelNotice({
          candidateModelNames: [providerModel.remoteModelId, providerModel.modelName],
          getMismatchMessage: (runtimeLabel) => {
            return `Active SGLang runtime model: ${runtimeLabel}. Starting this job will be blocked until it matches the project's model.`
          },
          providerKind: providerModel.provider,
          runtime: providerConnections.data?.runtime ?? null,
        })
      : null
  }
  const clearStartJobError = (jobId: string) => {
    setStartJobErrors((prev) => {
      const {[jobId]: _removed, ...rest} = prev

      return rest
    })
  }
  const handleStartJob = async (jobId: string) => {
    clearStartJobError(jobId)
    setStartingJobs((prev) => {
      return new Set([...prev, jobId])
    })

    try {
      await startJudgmentsJob(jobId)
      await jobs.refetch()
    } catch (error) {
      setStartJobErrors((prev) => {
        return {...prev, [jobId]: getActionErrorMessage(error, 'Failed to start job')}
      })
    } finally {
      setStartingJobs((prev) => {
        const next = new Set(prev)
        next.delete(jobId)
        return next
      })
    }
  }

  return (
    <div class="space-y-4">
      <Show when={jobs.isLoading}>
        <JudgmentsJobsTableFallback />
      </Show>

      <Show when={!jobs.isLoading}>
        <Show when={jobs.isError}>
          <div class="p-4 rounded-md bg-red-50 border border-red-200">
            <p class="text-red-600">Failed to load judgment jobs</p>
            <button
              onClick={() => {
                return void jobs.refetch()
              }}
              class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={!jobs.isError && (jobs.data?.length ?? 0) === 0}>
          <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-12">
            <div class="text-center">
              <svg class="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
              <h3 class="mt-2 text-sm font-medium text-gray-900">No judgment jobs</h3>
              <p class="mt-1 text-sm text-gray-500">No judgment jobs have been created yet.</p>
              <p class="mt-1 text-sm text-gray-500">
                Jobs will appear here once they are initiated from project pages.
              </p>
            </div>
          </div>
        </Show>

        <Show when={!jobs.isError && (jobs.data?.length ?? 0) > 0}>
          <div class="text-sm text-gray-500 mb-2">Last updated: {formatDistanceToNow(jobs.dataUpdatedAt)} ago</div>
          <div class="overflow-x-auto bg-white rounded-lg shadow">
            <table class="min-w-full divide-y divide-gray-200">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Job ID</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Project
                  </th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Health</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Updated
                  </th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <For
                  each={jobs.data?.slice().sort((a, b) => {
                    return (a.projectName ?? 'Unknown Project').localeCompare(b.projectName ?? 'Unknown Project')
                  })}
                >
                  {(job) => {
                    return (
                      <tr class="hover:bg-gray-50">
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          <Link
                            to="/admin/jobs/$id"
                            params={{id: job.id}}
                            class="font-mono text-xs text-blue-600 hover:text-blue-800 hover:underline"
                          >
                            {job.id.slice(0, 8)}...
                          </Link>
                        </td>
                        <td class="px-6 py-4 text-sm text-gray-900">
                          <div class="space-y-2">
                            <Link
                              to="/admin/jobs/$id"
                              params={{id: job.id}}
                              class="text-blue-600 hover:text-blue-800 hover:underline"
                            >
                              {job.projectName || 'Unknown Project'}
                            </Link>
                            <RuntimeModelNotice notice={getJobRuntimeNotice(job)} />
                          </div>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm">
                          <span
                            class={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(
                              job.status,
                            )}`}
                          >
                            {formatStatus(job.status)}
                          </span>
                        </td>
                        <td class="px-6 py-4 text-sm text-gray-900">
                          <div class="flex flex-wrap gap-2">
                            <For each={job.health.badges as JobHealthBadge[]}>
                              {(badge) => {
                                const badgeClass = `inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${getHealthBadgeColor(
                                  badge,
                                )}`

                                return isHealthyBadge(badge) ? (
                                  <span class={badgeClass}>{badge}</span>
                                ) : (
                                  <Link
                                    to="/admin/jobs/$id"
                                    params={{id: job.id}}
                                    class={`${badgeClass} hover:opacity-80`}
                                  >
                                    {badge}
                                  </Link>
                                )
                              }}
                            </For>
                          </div>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {job.createdAt ? formatDate(new Date(job.createdAt), 'yyyy-MM-dd HH:mm') : 'N/A'}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                          {job.updatedAt ? formatDate(new Date(job.updatedAt), 'yyyy-MM-dd HH:mm') : 'N/A'}
                        </td>
                        <td class="px-6 py-4 text-sm text-gray-900">
                          <div class="flex flex-col gap-2">
                            <div class="flex gap-2">
                              <Show when={job.status === 'running'}>
                                <button
                                  class="text-sm text-yellow-600 hover:text-yellow-800"
                                  onClick={() => {
                                    void pauseJudgmentsJob(job.id).then(() => {
                                      return void jobs.refetch()
                                    })
                                  }}
                                >
                                  Pause
                                </button>
                              </Show>
                              <Show when={job.status === 'paused'}>
                                <button
                                  class="text-sm text-green-600 hover:text-green-800"
                                  disabled={startingJobs().has(job.id)}
                                  onClick={() => {
                                    return void handleStartJob(job.id)
                                  }}
                                >
                                  {startingJobs().has(job.id) ? 'Starting...' : 'Start'}
                                </button>
                              </Show>
                              <Show when={job.status === 'failed'}>
                                <button class="text-sm text-blue-600 hover:text-blue-800">Retry</button>
                              </Show>
                            </div>
                            <Show when={startJobErrors()[job.id]}>
                              {(message) => {
                                return (
                                  <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                                    {message()}
                                  </div>
                                )
                              }}
                            </Show>
                          </div>
                        </td>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
    </div>
  )
}

const AdminJobs = () => {
  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">Judgment Jobs</h1>
        <div class="flex items-center gap-3">
          <a
            href="/admin/jobs/health"
            class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 shadow-sm hover:bg-amber-100"
          >
            Health Triage
          </a>
          <Link
            to="/admin/duckdb-append"
            class="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-100"
          >
            DuckDB Append Metrics
          </Link>
        </div>
      </div>

      <div class="mb-6">
        <Suspense fallback={<TokenUsageTimelineCardFallback />}>
          <TokenUsageTimeline allJobs={true} />
        </Suspense>
      </div>

      <div class="space-y-4">
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div class="flex gap-6 text-sm text-gray-600 flex-wrap">
            <Suspense fallback={<TokenUsageSummaryFallback />}>
              <TokenUsageSummary />
            </Suspense>
            <Suspense fallback={<JudgmentsJobsCountsFallback />}>
              <JudgmentsJobsCounts />
            </Suspense>
          </div>
        </div>

        <Suspense fallback={<HealthSummaryStripFallback />}>
          <HealthSummaryStrip />
        </Suspense>

        <Suspense fallback={<JudgmentsJobsTableFallback />}>
          <JudgmentsJobsTable />
        </Suspense>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/jobs/')({component: AdminJobs})
