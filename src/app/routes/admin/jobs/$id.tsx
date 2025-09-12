import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link} from '@tanstack/solid-router'
import {formatDate} from 'date-fns'
import {For, Show} from 'solid-js'

import {getJudgmentsJobById} from '../../../../services/judgmentsJobsService'

const getStatusColor = (status: string | null) => {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-800 border-green-200'
    case 'running':
      return 'bg-blue-100 text-blue-800 border-blue-200'
    case 'failed':
      return 'bg-red-100 text-red-800 border-red-200'
    case 'paused_by_user':
    case 'paused_by_admin':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200'
    case 'not_started':
      return 'bg-gray-100 text-gray-800 border-gray-200'
    case 'waiting_on_llm_connection':
    case 'waiting_on_db_connection':
      return 'bg-orange-100 text-orange-800 border-orange-200'
    case 'project_removed':
      return 'bg-purple-100 text-purple-800 border-purple-200'
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200'
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

const AdminJudgmentJobDetail = () => {
  const params = Route.useParams()

  const id = () => {
    return params().id
  }

  const job = useQuery(() => {
    return {
      queryKey: ['judgments-job', id()],
      queryFn: () => {
        console.log('id:', id())
        return getJudgmentsJobById(id())
      },
      refetchInterval: 1000 * 30, // Refresh every 30 seconds
    }
  })
  // console.log('job.data:', job)
  // console.log('job.data type:', typeof job, Array.isArray(job))

  return (
    <div class="min-h-screen bg-gray-50 p-6">
      <div class="max-w-4xl mx-auto">
        <div class="mb-6">
          <Link to="/admin/jobs" class="text-blue-600 hover:text-blue-800 text-sm flex items-center gap-1">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Jobs
          </Link>
        </div>

        <Show when={job.isLoading}>
          <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
            <p class="text-gray-500 text-center">Loading job details...</p>
          </div>
        </Show>

        <Show when={job.isError}>
          <div class="p-4 rounded-md bg-red-50 border border-red-200">
            <p class="text-red-600">Failed to load job details</p>
            <button
              onClick={() => {
                return void job.refetch()
              }}
              class="mt-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={job.data}>
          {(jobData) => {
            const data = jobData()
            return (
              <>
                <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
                  <div class="flex justify-between items-start mb-4">
                    <div>
                      <h1 class="text-2xl font-bold text-gray-900">Job</h1>
                      <p class="text-sm text-gray-500 mt-1 font-mono">{data.id}</p>
                    </div>
                    <span class={`px-3 py-1 rounded-full text-sm font-medium border ${getStatusColor(data.status)}`}>
                      {formatStatus(data.status)}
                    </span>
                  </div>

                  <div class="grid grid-cols-2 gap-4 mt-6">
                    <div>
                      <p class="text-sm text-gray-500">Project</p>
                      <p class="font-medium">{data.projectName || 'Unknown Project'}</p>
                    </div>
                    <div>
                      <p class="text-sm text-gray-500">Project ID</p>
                      <p class="font-mono text-sm">{data.projectId}</p>
                    </div>
                    <div>
                      <p class="text-sm text-gray-500">Created</p>
                      <p class="font-medium">
                        {data.createdAt ? formatDate(new Date(data.createdAt), 'yyyy-MM-dd HH:mm:ss') : 'N/A'}
                      </p>
                    </div>
                    <div>
                      <p class="text-sm text-gray-500">Last Updated</p>
                      <p class="font-medium">
                        {data.updatedAt ? formatDate(new Date(data.updatedAt), 'yyyy-MM-dd HH:mm:ss') : 'N/A'}
                      </p>
                    </div>
                  </div>
                </div>
                <Show when={'unassessedArticlesCount' in data}>
                  <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
                    <div class="bg-orange-50 rounded-lg p-4">
                      <p class="text-sm text-orange-600 mb-1">Unassessed</p>
                      <p class="text-2xl font-bold text-orange-900">
                        {'unassessedArticlesCount' in data ? data.unassessedArticlesCount || 0 : 0}
                      </p>
                      <p class="text-xs text-orange-600 mt-1">Total articles in project without judgments</p>
                    </div>
                  </div>
                </Show>
                <Show when={'articleStats' in data && data.articleStats}>
                  <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
                    <h2 class="text-lg font-semibold mb-4">Job Queue</h2>
                    <div class="grid grid-cols-3 gap-4">
                      <div class="bg-gray-50 rounded-lg p-4">
                        <p class="text-sm text-gray-500 mb-1">Ready</p>
                        <p class="text-2xl font-bold text-gray-900">
                          {'articleStats' in data ? data.articleStats?.ready || 0 : 0}
                        </p>
                        <p class="text-xs text-gray-500 mt-1">Articles ready to process</p>
                      </div>
                      <div class="bg-blue-50 rounded-lg p-4">
                        <p class="text-sm text-blue-600 mb-1">Sent</p>
                        <p class="text-2xl font-bold text-blue-900">
                          {'articleStats' in data ? data.articleStats?.sent || 0 : 0}
                        </p>
                        <p class="text-xs text-blue-600 mt-1">Articles sent for judgment</p>
                      </div>
                      <div class="bg-green-50 rounded-lg p-4">
                        <p class="text-sm text-green-600 mb-1">Judged</p>
                        <p class="text-2xl font-bold text-green-900">
                          {'articleStats' in data ? data.articleStats?.judged || 0 : 0}
                        </p>
                        <p class="text-xs text-green-600 mt-1">Articles completed</p>
                      </div>
                    </div>
                  </div>
                </Show>

                <Show when={Array.isArray(data.error) && data.error.length > 0}>
                  <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
                    <h2 class="text-lg font-semibold text-red-900 mb-2">Errors</h2>
                    <ul class="list-disc list-inside space-y-1">
                      <For each={Array.isArray(data.error) ? data.error : []}>
                        {(err) => {
                          return <li class="text-red-700">{err}</li>
                        }}
                      </For>
                    </ul>
                  </div>
                </Show>

                <Show when={'totalTokenUsage' in data && data.totalTokenUsage}>
                  <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
                    <h2 class="text-lg font-semibold mb-4">Token Usage</h2>
                    <div class="grid grid-cols-3 gap-4 mb-6">
                      <div class="bg-blue-50 rounded-lg p-4">
                        <p class="text-sm text-blue-600 mb-1">Total Tokens</p>
                        <p class="text-2xl font-bold text-blue-900">
                          {'totalTokenUsage' in data ? data.totalTokenUsage?.totalTokens?.toLocaleString() || '0' : '0'}
                        </p>
                      </div>
                      <div class="bg-green-50 rounded-lg p-4">
                        <p class="text-sm text-green-600 mb-1">Prompt Tokens</p>
                        <p class="text-2xl font-bold text-green-900">
                          {'totalTokenUsage' in data
                            ? data.totalTokenUsage?.totalPromptTokens?.toLocaleString() || '0'
                            : '0'}
                        </p>
                      </div>
                      <div class="bg-purple-50 rounded-lg p-4">
                        <p class="text-sm text-purple-600 mb-1">Completion Tokens</p>
                        <p class="text-2xl font-bold text-purple-900">
                          {'totalTokenUsage' in data
                            ? data.totalTokenUsage?.totalCompletionTokens?.toLocaleString() || '0'
                            : '0'}
                        </p>
                      </div>
                    </div>

                    <Show
                      when={'tokenUsagePerDay' in data && data.tokenUsagePerDay && data.tokenUsagePerDay.length > 0}
                    >
                      <div>
                        <h3 class="text-md font-medium mb-3">Daily Usage</h3>
                        <div class="overflow-x-auto">
                          <table class="min-w-full divide-y divide-gray-200">
                            <thead class="bg-gray-50">
                              <tr>
                                <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Date
                                </th>
                                <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Total
                                </th>
                                <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Prompt
                                </th>
                                <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Completion
                                </th>
                                <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Requests
                                </th>
                              </tr>
                            </thead>
                            <tbody class="bg-white divide-y divide-gray-200">
                              <For each={'tokenUsagePerDay' in data ? data.tokenUsagePerDay : []}>
                                {(day) => {
                                  return (
                                    <tr>
                                      <td class="px-4 py-2 text-sm text-gray-900">
                                        {day.date ? formatDate(new Date(day.date), 'yyyy-MM-dd') : 'N/A'}
                                      </td>
                                      <td class="px-4 py-2 text-sm text-gray-900 text-right">
                                        {day.dailyTokens?.toLocaleString() || '0'}
                                      </td>
                                      <td class="px-4 py-2 text-sm text-gray-900 text-right">
                                        {day.dailyPromptTokens?.toLocaleString() || '0'}
                                      </td>
                                      <td class="px-4 py-2 text-sm text-gray-900 text-right">
                                        {day.dailyCompletionTokens?.toLocaleString() || '0'}
                                      </td>
                                      <td class="px-4 py-2 text-sm text-gray-900 text-right">
                                        {day.requests?.toLocaleString() || '0'}
                                      </td>
                                    </tr>
                                  )
                                }}
                              </For>
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </Show>
                  </div>
                </Show>

                <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                  <h2 class="text-lg font-semibold mb-4">Actions</h2>
                  <div class="flex gap-3">
                    <Show when={data.status === 'running'}>
                      <button class="px-4 py-2 bg-yellow-600 text-white rounded-md hover:bg-yellow-700">
                        Pause Job
                      </button>
                    </Show>
                    <Show when={data.status === 'paused_by_admin' || data.status === 'paused_by_user'}>
                      <button class="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700">
                        Resume Job
                      </button>
                    </Show>
                    <Show when={data.status === 'failed'}>
                      <button class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Retry Job</button>
                    </Show>
                    <button
                      onClick={() => {
                        return void job.refetch()
                      }}
                      class="px-4 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700"
                    >
                      Refresh
                    </button>
                  </div>
                </div>
              </>
            )
          }}
        </Show>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/admin/jobs/$id')({component: AdminJudgmentJobDetail})
