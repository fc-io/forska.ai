import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {formatDate, formatDistanceToNow} from 'date-fns'
import {createMemo, createSignal, For, Show} from 'solid-js'

import {type JudgmentJobRepairAction, runJudgmentsJobRepairAction} from '../../../../services/judgmentsJobsService'
import {
  formatStatus,
  getActionErrorMessage,
  getHealthBadgeColor,
  getJobRiskScore,
  getJudgmentsJobsQuery,
  getStatusColor,
  isRiskyJudgmentJob,
  type JobHealthBadge,
  type JobHealthFilter,
  jobMatchesHealthFilter,
  judgmentJobsHealthFilterLabels,
} from './jobsPageShared'

const batchSafeRepairActions: Array<{action: JudgmentJobRepairAction; label: string}> = [
  {action: 'preflight', label: 'Preflight'},
  {action: 'checkpoint', label: 'Checkpoint WAL'},
  {action: 'repair_orphaned_queue', label: 'Repair Orphaned Queue'},
  {action: 'drain', label: 'Drain Storage'},
  {action: 'repair', label: 'Repair All Storage'},
]

const healthFilters = Object.entries(judgmentJobsHealthFilterLabels).map(([value, label]) => {
  return {label, value: value as JobHealthFilter}
})

const HealthJobsPage = () => {
  const jobs = useQuery(getJudgmentsJobsQuery)
  const [activeFilters, setActiveFilters] = createSignal<Set<JobHealthFilter>>(new Set())
  const [repairingActionByJobId, setRepairingActionByJobId] = createSignal<
    Record<string, JudgmentJobRepairAction | null>
  >({})
  const [actionErrorByJobId, setActionErrorByJobId] = createSignal<Record<string, string>>({})
  const [actionNoticeByJobId, setActionNoticeByJobId] = createSignal<Record<string, string>>({})

  const filteredJobs = createMemo(() => {
    const filters = activeFilters()
    const visibleJobs = (jobs.data ?? []).filter((job) => {
      return (
        filters.size === 0
        || Array.from(filters).some((filter) => {
          return jobMatchesHealthFilter(job, filter)
        })
      )
    })

    return visibleJobs.slice().sort((left, right) => {
      const riskDelta = getJobRiskScore(right) - getJobRiskScore(left)

      if (riskDelta !== 0) {
        return riskDelta
      }

      return new Date(right.updatedAt ?? 0).getTime() - new Date(left.updatedAt ?? 0).getTime()
    })
  })

  const counts = createMemo(() => {
    const data = jobs.data ?? []

    return {
      risky: data.filter((job) => {
        return isRiskyJudgmentJob(job)
      }).length,
      total: data.length,
      visible: filteredJobs().length,
    }
  })

  const toggleFilter = (filter: JobHealthFilter) => {
    setActiveFilters((previous) => {
      const next = new Set(previous)

      if (next.has(filter)) {
        next.delete(filter)
        return next
      }

      next.add(filter)
      return next
    })
  }

  const clearActionState = (jobId: string) => {
    setActionErrorByJobId((previous) => {
      const {[jobId]: _removed, ...rest} = previous
      return rest
    })
    setActionNoticeByJobId((previous) => {
      const {[jobId]: _removed, ...rest} = previous
      return rest
    })
  }

  const handleRepairAction = async ({action, jobId}: {action: JudgmentJobRepairAction; jobId: string}) => {
    clearActionState(jobId)
    setRepairingActionByJobId((previous) => {
      return {...previous, [jobId]: action}
    })

    try {
      const result = await runJudgmentsJobRepairAction({action, jobId})
      setActionNoticeByJobId((previous) => {
        return {...previous, [jobId]: result.message}
      })
      await jobs.refetch()
    } catch (error) {
      setActionErrorByJobId((previous) => {
        return {...previous, [jobId]: getActionErrorMessage(error, `Failed to ${action} local storage`)}
      })
    } finally {
      setRepairingActionByJobId((previous) => {
        return {...previous, [jobId]: null}
      })
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div class="space-y-2">
          <div class="flex items-center gap-3">
            <h1 class="text-2xl font-bold text-gray-900">Judgment Job Health</h1>
            <span class="rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
              {counts().risky} risky
            </span>
          </div>
          <p class="max-w-3xl text-sm text-gray-600">
            Risky jobs are sorted first. This page stays focused on local storage reliability and only exposes
            batch-safe repair actions.
          </p>
        </div>
        <a
          href="/admin/jobs"
          class="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-100"
        >
          Back to Jobs
        </a>
      </div>

      <div class="mb-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div class="flex flex-wrap items-center gap-3 text-sm text-gray-600">
          <span class="font-medium text-gray-900">Filters</span>
          <For each={healthFilters}>
            {(filter) => {
              const isActive = () => {
                return activeFilters().has(filter.value)
              }

              return (
                <button
                  class={
                    isActive()
                      ? 'rounded-full bg-slate-900 px-3 py-1 text-white'
                      : 'rounded-full bg-gray-100 px-3 py-1 text-gray-700 hover:bg-gray-200'
                  }
                  onClick={() => {
                    return toggleFilter(filter.value)
                  }}
                >
                  {filter.label}
                </button>
              )
            }}
          </For>
          <Show when={activeFilters().size > 0}>
            <button
              class="rounded-full border border-gray-300 px-3 py-1 text-gray-700 hover:bg-gray-100"
              onClick={() => {
                setActiveFilters(new Set<JobHealthFilter>())
              }}
            >
              Clear Filters
            </button>
          </Show>
        </div>
        <div class="mt-3 flex flex-wrap gap-6 text-sm text-gray-600">
          <span>
            <span class="font-semibold text-gray-900">{counts().visible}</span> visible
          </span>
          <span>
            <span class="font-semibold text-gray-900">{counts().total}</span> total
          </span>
          <Show when={!jobs.isLoading && jobs.dataUpdatedAt > 0}>
            <span>Last updated: {formatDistanceToNow(jobs.dataUpdatedAt)} ago</span>
          </Show>
        </div>
      </div>

      <Show when={jobs.isLoading}>
        <div class="rounded-lg border border-gray-200 bg-white p-6 text-gray-500 shadow-sm">
          Loading health triage...
        </div>
      </Show>

      <Show when={jobs.isError}>
        <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          <p>Failed to load judgment job health.</p>
          <button
            class="mt-3 rounded-md bg-red-600 px-4 py-2 text-white hover:bg-red-700"
            onClick={() => {
              return void jobs.refetch()
            }}
          >
            Retry
          </button>
        </div>
      </Show>

      <Show when={!jobs.isLoading && !jobs.isError && filteredJobs().length === 0}>
        <div class="rounded-lg border border-gray-200 bg-white p-12 text-center shadow-sm">
          <h2 class="text-lg font-semibold text-gray-900">No matching risky jobs</h2>
          <p class="mt-2 text-sm text-gray-500">Adjust the health filters or return to the full jobs list.</p>
        </div>
      </Show>

      <Show when={!jobs.isLoading && !jobs.isError && filteredJobs().length > 0}>
        <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
              <tr>
                <th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Job</th>
                <th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                <th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Health</th>
                <th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Updated</th>
                <th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Batch-Safe Actions
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 bg-white">
              <For each={filteredJobs()}>
                {(job) => {
                  const repairingAction = () => {
                    return repairingActionByJobId()[job.id] ?? null
                  }

                  return (
                    <tr class={isRiskyJudgmentJob(job) ? 'bg-amber-50/40 hover:bg-amber-50' : 'hover:bg-gray-50'}>
                      <td class="px-6 py-4 text-sm text-gray-900">
                        <div class="space-y-1">
                          <Link
                            to="/admin/jobs/$id"
                            params={{id: job.id}}
                            class="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                          >
                            {job.projectName || 'Unknown Project'}
                          </Link>
                          <div>
                            <Link
                              to="/admin/jobs/$id"
                              params={{id: job.id}}
                              class="font-mono text-xs text-blue-600 hover:text-blue-800 hover:underline"
                            >
                              {job.id}
                            </Link>
                          </div>
                        </div>
                      </td>
                      <td class="px-6 py-4 whitespace-nowrap text-sm">
                        <span
                          class={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${getStatusColor(job.status)}`}
                        >
                          {formatStatus(job.status)}
                        </span>
                      </td>
                      <td class="px-6 py-4 text-sm text-gray-900">
                        <div class="flex flex-wrap gap-2">
                          <For each={job.health.badges as JobHealthBadge[]}>
                            {(badge) => {
                              return (
                                <span
                                  class={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${getHealthBadgeColor(
                                    badge,
                                  )}`}
                                >
                                  {badge}
                                </span>
                              )
                            }}
                          </For>
                        </div>
                      </td>
                      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        <div>{job.updatedAt ? formatDate(new Date(job.updatedAt), 'yyyy-MM-dd HH:mm') : 'N/A'}</div>
                        <Show when={job.updatedAt}>
                          {(updatedAt) => {
                            return (
                              <div class="mt-1 text-xs text-gray-400">
                                {formatDistanceToNow(new Date(updatedAt()))} ago
                              </div>
                            )
                          }}
                        </Show>
                      </td>
                      <td class="px-6 py-4 text-sm text-gray-900">
                        <div class="flex flex-wrap gap-2">
                          <For each={batchSafeRepairActions}>
                            {(button) => {
                              return (
                                <button
                                  class="rounded-md bg-slate-700 px-3 py-2 text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                                  disabled={Boolean(repairingAction())}
                                  onClick={() => {
                                    return void handleRepairAction({action: button.action, jobId: job.id})
                                  }}
                                >
                                  {repairingAction() === button.action ? `${button.label}...` : button.label}
                                </button>
                              )
                            }}
                          </For>
                          <Link
                            to="/admin/jobs/$id"
                            params={{id: job.id}}
                            class="rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 hover:bg-gray-100"
                          >
                            Full Details
                          </Link>
                        </div>
                        <Show when={actionErrorByJobId()[job.id]}>
                          {(message) => {
                            return (
                              <div class="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                                {message()}
                              </div>
                            )
                          }}
                        </Show>
                        <Show when={actionNoticeByJobId()[job.id]}>
                          {(message) => {
                            return (
                              <div class="mt-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                                {message()}
                              </div>
                            )
                          }}
                        </Show>
                      </td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  )
}

export const Route = createFileRoute('/admin/jobs/health')({component: HealthJobsPage})
