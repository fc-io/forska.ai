import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {formatDate} from 'date-fns'
import {createSignal, For, Show, Suspense} from 'solid-js'

import {TokenUsageTimeline} from '../../../../../components/TokenUsageTimeline'
import {apiClient} from '../../../../../services/apiClient.ts'
import {
  deleteJudgmentsJob,
  getJudgmentsJobById,
  pauseJudgmentsJob,
  startJudgmentsJob,
} from '../../../../../services/judgmentsJobsService'
import {handleApiResponse} from '../../../../../services/utils/handleApiResponse'

const getStatusColor = (status: string | null) => {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-800 border-green-200'
    case 'running':
      return 'bg-blue-100 text-blue-800 border-blue-200'
    case 'failed':
      return 'bg-red-100 text-red-800 border-red-200'
    case 'paused':
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
  if (status === 'paused') return 'Paused'
  return status
    .split('_')
    .map((word) => {
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object')
}

type JobData = {
  id?: string
  status?: string | null
  projectId?: string
  projectName?: string
  createdAt?: string
  updatedAt?: string
  useFulltext?: boolean
  useFulltextNoImages?: boolean
  totalTokenUsage?: {totalTokens?: number; totalPromptTokens?: number; totalCompletionTokens?: number}
  promptStats?: {ready?: number; sent?: number; judged?: number; skipped?: number}
  requestStats?: {inFlight?: number; attempts?: number}
  error?: string[]
}

const shouldShowFulltextSkippedFromJob = (job: unknown) => {
  return isRecord(job) ? Boolean(job.useFulltext || job.useFulltextNoImages) : false
}

const activeJudgmentsJobStatuses = new Set([
  'not_started',
  'running',
  'waiting_on_db_connection',
  'waiting_on_llm_connection',
])

const getJudgmentsJobRefetchInterval = (status: string | null | undefined) => {
  return activeJudgmentsJobStatuses.has(status ?? '') ? 1000 * 30 : false
}

const TokenUsageTimelinePanelFallback = () => {
  return (
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div class="h-64 flex items-center justify-center">
        <p class="text-gray-500">Loading token usage timeline...</p>
      </div>
    </div>
  )
}

const AdminJudgmentJobDetail = () => {
  const params = Route.useParams()
  const navigate = useNavigate()
  const [isDeleting, setIsDeleting] = createSignal(false)

  const id = () => {
    return params().id
  }

  const job = useQuery(() => {
    return {
      queryKey: ['judgments-job', id()],
      queryFn: async () => {
        const response = await getJudgmentsJobById(id())

        return response
      },
      refetchInterval: (query: {state: {data?: unknown}}) => {
        const status =
          isRecord(query.state.data) && typeof query.state.data.status === 'string' ? query.state.data.status : null
        return getJudgmentsJobRefetchInterval(status)
      },
      refetchOnWindowFocus: true,
      suspense: false,
    }
  })
  const unassessedCountQuery = useQuery(() => {
    return {
      queryKey: ['judgments-job-unassessed-count', id()],
      enabled: Boolean(id()),
      refetchInterval: getJudgmentsJobRefetchInterval(job.data?.status ?? null),
      refetchOnWindowFocus: true,
      suspense: false,
      queryFn: async () => {
        const response = await apiClient.api['judgmentsjobs-unassessed-count'].get({query: {jobId: id()}})
        const data = handleApiResponse(response, 'Failed to fetch unassessed count') as {count?: number}
        return Number(data?.count || 0)
      },
    }
  })
  // console.log('job.data:', job.data?.unassessedArticlesCount)
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
            const data = jobData as unknown as () => JobData | undefined
            const jobDetails = () => {
              return data()
            }
            const unassessedArticlesCount = () => {
              return unassessedCountQuery.data ?? 0
            }
            const formattedUnassessedArticlesCount = () => {
              return unassessedArticlesCount().toLocaleString()
            }
            const jobId = () => {
              const details = jobDetails()
              const jobIdValue = details && 'id' in details ? (details as {id?: string | number}).id : undefined
              const resolvedId =
                typeof jobIdValue === 'number' || typeof jobIdValue === 'string' ? String(jobIdValue) : ''
              return resolvedId
            }
            const shouldLinkToUnassessedArticles = () => {
              const hasLink = Boolean(jobId() && unassessedArticlesCount() > 0)
              return hasLink
            }
            const unassessedArticlesLink = () => {
              return shouldLinkToUnassessedArticles() ? `/admin/jobs/${jobId()}/unassessed_articles` : ''
            }
            const shouldShowFulltextSkipped = () => {
              return shouldShowFulltextSkippedFromJob(data())
            }
            const jobQueueGridClass = () => {
              return `grid gap-4 ${shouldShowFulltextSkipped() ? 'grid-cols-4' : 'grid-cols-3'}`
            }
            return (
              <>
                <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
                  <div class="flex justify-between items-start mb-4">
                    <div>
                      <h1 class="text-2xl font-bold text-gray-900">Job</h1>
                      <p class="text-sm text-gray-500 mt-1 font-mono">{data()?.id}</p>
                    </div>
                    <span
                      class={`px-3 py-1 rounded-full text-sm font-medium border ${getStatusColor(data()?.status ?? null)}`}
                    >
                      {formatStatus(data()?.status ?? null)}
                    </span>
                  </div>

                  <div class="grid grid-cols-2 gap-4 mt-6">
                    <div>
                      <p class="text-sm text-gray-500">Project</p>
                      <Show
                        when={data()?.projectId}
                        fallback={<p class="font-medium">{data()?.projectName || 'Unknown Project'}</p>}
                      >
                        {(projectId) => {
                          return (
                            <Link
                              to="/projects/$id"
                              params={{id: projectId()}}
                              class="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                            >
                              {data()?.projectName || 'Unknown Project'}
                            </Link>
                          )
                        }}
                      </Show>
                    </div>
                    <div>
                      <p class="text-sm text-gray-500">Project ID</p>
                      <p class="font-mono text-sm">{data()?.projectId}</p>
                    </div>
                    <div>
                      <p class="text-sm text-gray-500">Created</p>
                      <p class="font-medium">
                        {data()?.createdAt
                          ? formatDate(new Date(data()?.createdAt ?? ''), 'yyyy-MM-dd HH:mm:ss')
                          : 'N/A'}
                      </p>
                    </div>
                    <div>
                      <p class="text-sm text-gray-500">Last Updated</p>
                      <p class="font-medium">
                        {data()?.updatedAt
                          ? formatDate(new Date(data()?.updatedAt ?? ''), 'yyyy-MM-dd HH:mm:ss')
                          : 'N/A'}
                      </p>
                    </div>
                  </div>

                  <div class="mt-6 pt-6 border-t border-gray-200">
                    <h3 class="text-sm font-medium text-gray-900 mb-3">Project</h3>
                    <div class="mb-4 space-y-1">
                      <p class="text-sm text-gray-500">Unassessed Articles</p>
                      <Show when={!unassessedCountQuery.isLoading} fallback={<p class="font-medium">Loading…</p>}>
                        <Show
                          when={shouldLinkToUnassessedArticles()}
                          fallback={<p class="font-medium">{formattedUnassessedArticlesCount()}</p>}
                        >
                          <Link to={unassessedArticlesLink()} class="font-medium text-blue-600 hover:text-blue-800">
                            {formattedUnassessedArticlesCount()}
                          </Link>
                        </Show>
                      </Show>
                    </div>
                    <Show when={data()?.totalTokenUsage}>
                      <div class="grid grid-cols-3 gap-4">
                        <div>
                          <p class="text-sm text-gray-500">Total Tokens</p>
                          <p class="font-medium">{data()?.totalTokenUsage?.totalTokens?.toLocaleString() ?? '0'}</p>
                        </div>
                        <div>
                          <p class="text-sm text-gray-500">Prompt Tokens</p>
                          <p class="font-medium">
                            {data()?.totalTokenUsage?.totalPromptTokens?.toLocaleString() ?? '0'}
                          </p>
                        </div>
                        <div>
                          <p class="text-sm text-gray-500">Completion Tokens</p>
                          <p class="font-medium">
                            {data()?.totalTokenUsage?.totalCompletionTokens?.toLocaleString() ?? '0'}
                          </p>
                        </div>
                      </div>
                    </Show>
                  </div>
                </div>
                <Show when={data()?.promptStats}>
                  <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
                    <h2 class="text-lg font-semibold mb-4">Job Queue</h2>
                    <div class={jobQueueGridClass()}>
                      <div class="bg-gray-50 rounded-lg p-4">
                        <p class="text-sm text-gray-500 mb-1">Ready</p>
                        <p class="text-2xl font-bold text-gray-900">{data()?.promptStats?.ready ?? 0}</p>
                        <p class="text-xs text-gray-500 mt-1">Prompts queued for judgment</p>
                      </div>
                      <div class="bg-blue-50 rounded-lg p-4">
                        <p class="text-sm text-blue-600 mb-1">Prompts in Progress</p>
                        <p class="text-2xl font-bold text-blue-900">{data()?.promptStats?.sent ?? 0}</p>
                        <p class="text-xs text-blue-600 mt-1">Claimed prompts being worked on</p>
                      </div>
                      <div class="bg-green-50 rounded-lg p-4">
                        <p class="text-sm text-green-600 mb-1">Judged</p>
                        <p class="text-2xl font-bold text-green-900">{data()?.promptStats?.judged ?? 0}</p>
                        <p class="text-xs text-green-600 mt-1">Prompts with judgments completed</p>
                      </div>
                      <Show when={shouldShowFulltextSkipped()}>
                        <div class="bg-amber-50 rounded-lg p-4">
                          <p class="text-sm text-amber-600 mb-1">Skipped</p>
                          <p class="text-2xl font-bold text-amber-900">{data()?.promptStats?.skipped ?? 0}</p>
                          <p class="text-xs text-amber-600 mt-1">No fulltext available</p>
                        </div>
                      </Show>
                    </div>
                  </div>
                </Show>

                <Show when={data()?.requestStats}>
                  <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
                    <h2 class="text-lg font-semibold mb-4">Request Activity</h2>
                    <div class="grid gap-4 grid-cols-2">
                      <div class="bg-sky-50 rounded-lg p-4">
                        <p class="text-sm text-sky-600 mb-1">In Flight</p>
                        <p class="text-2xl font-bold text-sky-900">{data()?.requestStats?.inFlight ?? 0}</p>
                        <p class="text-xs text-sky-600 mt-1">Actual LLM calls running now</p>
                      </div>
                      <div class="bg-indigo-50 rounded-lg p-4">
                        <p class="text-sm text-indigo-600 mb-1">Attempts</p>
                        <p class="text-2xl font-bold text-indigo-900">{data()?.requestStats?.attempts ?? 0}</p>
                        <p class="text-xs text-indigo-600 mt-1">Real LLM call attempts so far</p>
                      </div>
                    </div>
                  </div>
                </Show>

                <Show when={data()?.error && Array.isArray(data()?.error) && (data()?.error?.length ?? 0) > 0}>
                  <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
                    <h2 class="text-lg font-semibold text-red-900 mb-2">Errors</h2>
                    <ul class="list-disc list-inside space-y-1">
                      <For each={data()?.error ?? []}>
                        {(err) => {
                          return <li class="text-red-700">{err}</li>
                        }}
                      </For>
                    </ul>
                  </div>
                </Show>

                <Show when={data()?.projectId}>
                  {(projectId) => {
                    return (
                      <div class="mb-6">
                        <Suspense fallback={<TokenUsageTimelinePanelFallback />}>
                          <TokenUsageTimeline projectId={projectId()} />
                        </Suspense>
                      </div>
                    )
                  }}
                </Show>

                <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                  <h2 class="text-lg font-semibold mb-4">Actions</h2>
                  <div class="flex gap-3">
                    <Show when={data()?.status === 'running'}>
                      <button
                        class="px-4 py-2 bg-yellow-600 text-white rounded-md hover:bg-yellow-700"
                        onClick={() => {
                          const jobId = data()?.id
                          if (jobId) {
                            void pauseJudgmentsJob(jobId).then(() => {
                              return job.refetch()
                            })
                          }
                        }}
                      >
                        Pause Job
                      </button>
                    </Show>
                    <Show when={data()?.status === 'paused'}>
                      <button
                        class="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
                        onClick={() => {
                          const jobId = data()?.id
                          if (jobId) {
                            void startJudgmentsJob(jobId).then(() => {
                              return job.refetch()
                            })
                          }
                        }}
                      >
                        Start Job
                      </button>
                    </Show>
                    <Show when={data()?.status === 'failed'}>
                      <button class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Retry Job</button>
                    </Show>
                    <button
                      class="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={isDeleting()}
                      onClick={() => {
                        const jobId = data()?.id
                        if (!jobId) return
                        if (!confirm('Are you sure you want to delete this job? This action cannot be undone.')) return
                        setIsDeleting(true)
                        deleteJudgmentsJob(jobId)
                          .then(() => {
                            void navigate({to: '/admin/jobs'})
                          })
                          .catch((error) => {
                            console.error('Failed to delete job:', error)
                            setIsDeleting(false)
                          })
                      }}
                    >
                      {isDeleting() ? 'Deleting...' : 'Delete Job'}
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

export const Route = createFileRoute('/admin/jobs/$id/')({component: AdminJudgmentJobDetail})
