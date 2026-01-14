import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {formatDate, formatDistanceToNow} from 'date-fns'
import {For, Show, Suspense} from 'solid-js'

import {TokenUsageTimeline} from '../../../../components/TokenUsageTimeline'
import {
  fetchJudgmentsJobs,
  getTotalTokenUsage,
  pauseJudgmentsJob,
  startJudgmentsJob,
} from '../../../../services/judgmentsJobsService'

const getStatusColor = (status: string | null) => {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-800'
    case 'running':
      return 'bg-blue-100 text-blue-800'
    case 'failed':
      return 'bg-red-100 text-red-800'
    case 'paused_by_user':
    case 'paused_by_admin':
      return 'bg-yellow-100 text-yellow-800'
    case 'not_started':
      return 'bg-gray-100 text-gray-800'
    case 'waiting_on_llm_connection':
    case 'waiting_on_db_connection':
      return 'bg-orange-100 text-orange-800'
    case 'project_removed':
      return 'bg-purple-100 text-purple-800'
    default:
      return 'bg-gray-100 text-gray-800'
  }
}

const formatStatus = (status: string | null) => {
  if (!status) return 'Unknown'
  return status
    .split('_')
    .map((word) => {
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

const formatNumber = (num: number): string => {
  return num.toLocaleString('en-US')
}

const AdminJobs = () => {
  const jobs = useQuery(() => {
    return {queryKey: ['judgments-jobs'], queryFn: fetchJudgmentsJobs, refetchInterval: 30000}
  })

  const tokenUsage = useQuery(() => {
    return {queryKey: ['total-token-usage'], queryFn: getTotalTokenUsage, refetchInterval: 30000}
  })

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">Judgment Jobs</h1>
      </div>

      <div class="mb-6">
        <TokenUsageTimeline allJobs={true} />
      </div>

      <Suspense>
        <div class="space-y-4">
          {/* Loading State */}
          <Show when={jobs.isLoading}>
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
              <p class="text-gray-500 text-center">Loading judgment jobs...</p>
            </div>
          </Show>

          {/* Error State */}
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

          {/* Empty State */}
          <Show when={!jobs.isLoading && !jobs.isError && jobs.data?.length === 0}>
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

          {/* Stats */}
          <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <div class="flex gap-6 text-sm text-gray-600 flex-wrap">
              <Show when={tokenUsage.data}>
                <span>
                  <span class="font-semibold text-purple-600">{formatNumber(tokenUsage.data?.totalTokens ?? 0)}</span>{' '}
                  total tokens
                </span>
                <span>
                  <span class="font-semibold text-indigo-600">
                    {formatNumber(tokenUsage.data?.totalPromptTokens ?? 0)}
                  </span>{' '}
                  prompt
                </span>
                <span>
                  <span class="font-semibold text-cyan-600">
                    {formatNumber(tokenUsage.data?.totalCompletionTokens ?? 0)}
                  </span>{' '}
                  completion
                </span>
              </Show>
              <Show when={jobs.data && jobs.data.length > 0}>
                <span class="border-l border-gray-300 pl-6">
                  <span class="font-semibold text-gray-900">{jobs.data?.length ?? 0}</span> total jobs
                </span>
                <span>
                  <span class="font-semibold text-blue-600">
                    {jobs.data?.filter((j) => {
                      return j.status === 'running'
                    }).length ?? 0}
                  </span>{' '}
                  running
                </span>
                <span>
                  <span class="font-semibold text-green-600">
                    {jobs.data?.filter((j) => {
                      return j.status === 'completed'
                    }).length ?? 0}
                  </span>{' '}
                  completed
                </span>
                <span>
                  <span class="font-semibold text-red-600">
                    {jobs.data?.filter((j) => {
                      return j.status === 'failed'
                    }).length ?? 0}
                  </span>{' '}
                  failed
                </span>
              </Show>
            </div>
          </div>

          {/* Jobs Table */}
          <Show when={jobs.data && jobs.data.length > 0}>
            <div class="text-sm text-gray-500 mb-2">Last updated: {formatDistanceToNow(jobs.dataUpdatedAt)} ago</div>
            <div class="overflow-x-auto bg-white rounded-lg shadow">
              <table class="min-w-full divide-y divide-gray-200">
                <thead class="bg-gray-50">
                  <tr>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Job ID
                    </th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Project
                    </th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
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
                          <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            <Show when={job.projectId} fallback={job.projectName || 'Unknown Project'}>
                              {(projectId) => {
                                return (
                                  <Link
                                    to="/projects/$id"
                                    params={{id: projectId()}}
                                    class="text-blue-600 hover:text-blue-800 hover:underline"
                                  >
                                    {job.projectName || 'Unknown Project'}
                                  </Link>
                                )
                              }}
                            </Show>
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
                          <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            {job.createdAt ? formatDate(new Date(job.createdAt), 'yyyy-MM-dd HH:mm') : 'N/A'}
                          </td>
                          <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            {job.updatedAt ? formatDate(new Date(job.updatedAt), 'yyyy-MM-dd HH:mm') : 'N/A'}
                          </td>
                          <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
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
                              <Show when={job.status === 'paused_by_admin' || job.status === 'paused_by_user'}>
                                <button
                                  class="text-sm text-green-600 hover:text-green-800"
                                  onClick={() => {
                                    void startJudgmentsJob(job.id).then(() => {
                                      return void jobs.refetch()
                                    })
                                  }}
                                >
                                  Start
                                </button>
                              </Show>
                              <Show when={job.status === 'failed'}>
                                <button class="text-sm text-blue-600 hover:text-blue-800">Retry</button>
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
        </div>
      </Suspense>
    </div>
  )
}

export const Route = createFileRoute('/admin/jobs/')({component: AdminJobs})
