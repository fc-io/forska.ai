import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {formatDate} from 'date-fns'
import {createEffect, createSignal, For, onCleanup, Show, Suspense} from 'solid-js'

import {RuntimeModelNotice} from '../../../../../components/main/runtimeModelNotice.tsx'
import {TokenUsageTimeline} from '../../../../../components/TokenUsageTimeline'
import {apiClient} from '../../../../../services/apiClient.ts'
import {
  deleteJudgmentsJob,
  getJudgmentsJobById,
  type JudgmentJobPromptStats,
  type JudgmentJobRequestStats,
  pauseJudgmentsJob,
  runJudgmentsJobRepairAction,
  startJudgmentsJob,
  startJudgmentsJobClean,
} from '../../../../../services/judgmentsJobsService'
import {fetchProjectWithPrompts} from '../../../../../services/projectsService'
import {handleApiResponse} from '../../../../../services/utils/handleApiResponse'
import {getSglangRuntimeModelNotice} from '../../../../../utils/getSglangRuntimeModelNotice.ts'
import {
  fetchProviderConnections,
  formatProviderMaxInflightRequests,
} from '../../../+admin/+models/providerConnectionsClient.ts'

const getActionErrorMessage = (error: unknown, fallback: string) => {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

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

const formatDateTime = (value: string | null | undefined) => {
  return value ? formatDate(new Date(value), 'yyyy-MM-dd HH:mm:ss') : 'N/A'
}

const formatByteSize = (value: number | null | undefined) => {
  if (value === null || value === undefined) return 'N/A'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const formatDuration = (value: number | null | undefined) => {
  if (value === null || value === undefined) return 'N/A'
  const totalSeconds = Math.max(Math.floor(value / 1000), 0)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

const formatRowsPerMinute = (value: number | null | undefined) => {
  return value === null || value === undefined ? 'N/A' : `${value.toLocaleString()} rows/min`
}

const formatPercent = (value: number | null | undefined) => {
  return value === null || value === undefined ? 'N/A' : `${value}%`
}

const formatSignedRowCount = (value: number | null | undefined) => {
  const normalizedValue = Number(value ?? 0)
  return `${normalizedValue > 0 ? '+' : ''}${normalizedValue.toLocaleString()} rows`
}

const getHeartbeatAgeMs = (heartbeatAt: string | null | undefined) => {
  return heartbeatAt ? Math.max(Date.now() - new Date(heartbeatAt).getTime(), 0) : null
}

const formatRepairMode = (value: 'none' | 'offline_repair_required' | 'safe_live_repair' | null | undefined) => {
  return value === 'offline_repair_required'
    ? 'Offline Repair Required'
    : value === 'safe_live_repair'
      ? 'Safe Live Repair'
      : 'No Repair Needed'
}

const formatStartupHandling = (value: 'auto_drain' | 'idle' | 'skip_offline_repair' | null | undefined) => {
  return value === 'auto_drain'
    ? 'Auto-drain on maintenance start'
    : value === 'skip_offline_repair'
      ? 'Skip and keep quarantined'
      : 'No startup action'
}

const getDrainingResumeBlockedReason = ({
  hasLocalSqliteState,
  oldestUnexportedAgeMs,
  outboxRowCount,
  pendingCompletionAckCount,
}: {
  hasLocalSqliteState?: boolean
  oldestUnexportedAgeMs?: number | null
  outboxRowCount?: number
  pendingCompletionAckCount?: number
}) => {
  const pendingAckCount = Number(pendingCompletionAckCount ?? 0)
  const pendingOutboxCount = Number(outboxRowCount ?? 0)

  if (pendingAckCount > 0) {
    return `Resume is blocked while ${pendingAckCount.toLocaleString()} imported local judgment row(s) wait for project refresh visibility ACK. Drain cleanup will finish after the refresh catches up.`
  }

  if (pendingOutboxCount > 0) {
    return oldestUnexportedAgeMs == null
      ? `Resume is blocked while ${pendingOutboxCount.toLocaleString()} exported local judgment row(s) finish retention cleanup.`
      : `Resume is blocked while ${pendingOutboxCount.toLocaleString()} local judgment row(s) export to DuckDB. Oldest unexported age: ${formatDuration(oldestUnexportedAgeMs)}.`
  }

  if (hasLocalSqliteState === false) {
    return 'Resume is blocked because this job is marked as draining, but no local SQLite state is visible. Run Repair All Storage or Start Job Clean.'
  }

  return 'Resume is blocked while local storage is draining. Wait for drain cleanup to finish or run a targeted repair action.'
}

const getResumeBlockedReason = ({
  hasLocalSqliteState,
  oldestUnexportedAgeMs,
  outboxRowCount,
  pendingCompletionAckCount,
  storageState,
}: {
  hasLocalSqliteState?: boolean
  oldestUnexportedAgeMs?: number | null
  outboxRowCount?: number
  pendingCompletionAckCount?: number
  storageState?: string | null
}) => {
  if (storageState === 'draining') {
    return getDrainingResumeBlockedReason({
      hasLocalSqliteState,
      oldestUnexportedAgeMs,
      outboxRowCount,
      pendingCompletionAckCount,
    })
  }

  return storageState === 'quarantined'
    ? 'Resume is blocked while local storage is quarantined. Repair or unquarantine the local storage first.'
    : null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object')
}

type JobData = {
  id?: string
  status?: string | null
  storageState?: string | null
  quarantinedAt?: string | null
  quarantineReason?: string | null
  lastImportStartedAt?: string | null
  lastImportCompletedAt?: string | null
  lastImportErrorAt?: string | null
  lastImportError?: string | null
  lastImportExitCode?: number | null
  importFailureCount?: number | null
  pauseRequestedAt?: string | null
  projectId?: string
  projectName?: string
  createdAt?: string
  updatedAt?: string
  useFulltext?: boolean
  useFulltextNoImages?: boolean
  totalTokenUsage?: {totalTokens?: number; totalPromptTokens?: number; totalCompletionTokens?: number}
  promptStats?: Partial<JudgmentJobPromptStats>
  requestStats?: Partial<JudgmentJobRequestStats>
  storageHealth?: {
    claimedOutboxCount?: number
    hasPendingCompletionAck?: boolean
    lastAckSeq?: number | null
    oldestUnackedCompletionAgeMs?: number | null
    oldestUnexportedAgeMs?: number | null
    orphanedJudgedRowCount?: number
    outboxRowCount?: number
    pendingCompletionAckCount?: number
    recentTransfer?: {
      addedRows?: number
      addedRowsPerMinute?: number
      clearedRows?: number
      clearedRowsPerMinute?: number
      insertedRows?: number
      insertedRowsPerMinute?: number
      netRows?: number
      netRowsPerMinute?: number
      windowMinutes?: number
    }
    projection?: {
      activeLargeRebuildProjectCount?: number
      currentPhase?: string | null
      estimatedCurrentPhaseRemainingMs?: number | null
      estimatedStorageDrainRemainingMs?: number | null
      projectedStorageDrainAt?: string | null
      remainingCurrentPhaseArticleCount?: number | null
      rowsPerMinute?: number | null
      scopeArticleCount?: number | null
    }
    promptCounts?: Partial<JudgmentJobPromptStats>
    retainedRowCount?: number
    sqliteFileBytes?: number | null
    walBytes?: number
  }
  leaseMetadata?: {
    acquiredAt?: string
    apiServerPort?: number
    heartbeatAt?: string
    hostname?: string
    leaseId?: string
    pid?: number
    serverJobId?: string
  }
  storagePolicy?: {
    hasLocalSqliteState?: boolean
    repairMode?: 'none' | 'offline_repair_required' | 'safe_live_repair'
    startupHandling?: 'auto_drain' | 'idle' | 'skip_offline_repair'
  }
  judgingRuntime?: {enabled?: boolean; reason?: string | null}
  error?: string[]
}

type JobRepairAction =
  | 'checkpoint'
  | 'drain'
  | 'preflight'
  | 'quarantine'
  | 'repair'
  | 'repair_orphaned_queue'
  | 'unquarantine'

const shouldShowFulltextSkippedFromJob = (job: unknown) => {
  return isRecord(job) ? Boolean(job.useFulltext || job.useFulltextNoImages) : false
}

const activeJudgmentsJobStatuses = new Set([
  'not_started',
  'running',
  'waiting_on_db_connection',
  'waiting_on_llm_connection',
])

const getJudgmentsJobRefetchInterval = (job: Pick<JobData, 'status' | 'storageState'> | null | undefined) => {
  return job?.storageState === 'draining'
    ? 1000 * 10
    : activeJudgmentsJobStatuses.has(job?.status ?? '')
      ? 1000 * 30
      : false
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
  const [isStarting, setIsStarting] = createSignal(false)
  const [isStartingClean, setIsStartingClean] = createSignal(false)
  const [isPausing, setIsPausing] = createSignal(false)
  const [isRepairing, setIsRepairing] = createSignal<JobRepairAction | null>(null)
  const [actionError, setActionError] = createSignal('')
  const [actionNotice, setActionNotice] = createSignal('')

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
      refetchOnWindowFocus: true,
      suspense: false,
    }
  })
  const projectDetailsQuery = useQuery(() => {
    const projectId = job.data?.projectId ?? ''

    return {
      queryKey: ['project', projectId, 'with-prompts', 'job-detail'],
      queryFn: () => {
        return fetchProjectWithPrompts(projectId)
      },
      enabled: projectId.length > 0,
      staleTime: 5 * 60 * 1000,
      suspense: false,
    }
  })
  const providerConnectionsQuery = useQuery(() => {
    return {
      queryKey: ['provider-connections', 'job-detail', id()],
      queryFn: fetchProviderConnections,
      staleTime: 60 * 1000,
      suspense: false,
    }
  })
  const unassessedCountQuery = useQuery(() => {
    return {
      queryKey: ['judgments-job-unassessed-count', id()],
      enabled: Boolean(id()),
      refetchInterval: getJudgmentsJobRefetchInterval(job.data),
      refetchOnWindowFocus: true,
      suspense: false,
      queryFn: async () => {
        const response = await apiClient.api['judgmentsjobs-unassessed-count'].get({query: {jobId: id()}})
        const data = handleApiResponse(response, 'Failed to fetch unassessed count') as {count?: number}
        return Number(data?.count || 0)
      },
    }
  })
  createEffect(() => {
    const intervalMs = getJudgmentsJobRefetchInterval(job.data)

    if (!intervalMs) {
      return
    }

    const interval = setInterval(() => {
      if (!job.isFetching) {
        void job.refetch()
      }
    }, intervalMs)

    onCleanup(() => {
      clearInterval(interval)
    })
  })
  const handleStartJob = async (jobId: string) => {
    setActionError('')
    setActionNotice('')
    setIsStarting(true)

    try {
      await startJudgmentsJob(jobId)
      await job.refetch()
    } catch (error) {
      setActionError(getActionErrorMessage(error, 'Failed to start job'))
    } finally {
      setIsStarting(false)
    }
  }
  const handleStartJobClean = async (jobId: string) => {
    setActionError('')
    setActionNotice('')
    setIsStartingClean(true)

    try {
      await startJudgmentsJobClean(jobId)
      await job.refetch()
      setActionNotice('Started job clean. Local SQLite queue state was reset and token usage history was preserved.')
    } catch (error) {
      setActionError(getActionErrorMessage(error, 'Failed to start job clean'))
    } finally {
      setIsStartingClean(false)
    }
  }
  const handlePauseJob = async (jobId: string) => {
    setActionError('')
    setActionNotice('')
    setIsPausing(true)

    try {
      await pauseJudgmentsJob(jobId)
      await job.refetch()
    } catch (error) {
      setActionError(getActionErrorMessage(error, 'Failed to pause job'))
    } finally {
      setIsPausing(false)
    }
  }
  const handleRepairAction = async ({
    action,
    jobId,
    reason,
  }: {
    action: JobRepairAction
    jobId: string
    reason?: string
  }) => {
    setActionError('')
    setActionNotice('')
    setIsRepairing(action)

    try {
      const result = await runJudgmentsJobRepairAction({action, jobId, reason})
      await job.refetch()
      setActionNotice(result.message)
    } catch (error) {
      setActionError(getActionErrorMessage(error, `Failed to ${action} local storage`))
    } finally {
      setIsRepairing(null)
    }
  }
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
          {(_jobData) => {
            const data = () => {
              return job.data as JobData | undefined
            }
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
            const storageHealth = () => {
              return data()?.storageHealth
            }
            const recentTransfer = () => {
              return storageHealth()?.recentTransfer
            }
            const storagePolicy = () => {
              return data()?.storagePolicy
            }
            const leaseMetadata = () => {
              return data()?.leaseMetadata
            }
            const leaseHeartbeatAgeMs = () => {
              return getHeartbeatAgeMs(leaseMetadata()?.heartbeatAt)
            }
            const resumeBlockedReason = () => {
              return getResumeBlockedReason({
                hasLocalSqliteState: storagePolicy()?.hasLocalSqliteState,
                oldestUnexportedAgeMs: storageHealth()?.oldestUnexportedAgeMs,
                outboxRowCount: storageHealth()?.outboxRowCount,
                pendingCompletionAckCount: storageHealth()?.pendingCompletionAckCount,
                storageState: data()?.storageState,
              })
            }
            const isResumeBlocked = () => {
              return Boolean(resumeBlockedReason())
            }
            const isOfflineRepairOnly = () => {
              return storagePolicy()?.repairMode === 'offline_repair_required'
            }
            const repairButtons = () => {
              return [
                {action: 'preflight', label: 'Run Preflight'},
                {action: 'checkpoint', label: 'Checkpoint WAL'},
                {action: 'repair_orphaned_queue', label: 'Repair Orphaned Queue'},
                {action: 'drain', label: 'Drain Storage'},
                {action: 'repair', label: 'Repair All Storage'},
              ] as const
            }
            const isLiveRepairButtonDisabled = (action: JobRepairAction) => {
              return (
                isOfflineRepairOnly()
                && (action === 'drain' || action === 'repair' || action === 'repair_orphaned_queue')
              )
            }
            const recoveryGuidance = () => {
              const hasRetainedLocalState =
                (storageHealth()?.outboxRowCount ?? 0) > 0
                || (storageHealth()?.claimedOutboxCount ?? 0) > 0
                || (storageHealth()?.retainedRowCount ?? 0) > 0
              const hasOrphanedLocalQueue = (storageHealth()?.orphanedJudgedRowCount ?? 0) > 0

              return isOfflineRepairOnly() && hasRetainedLocalState
                ? {
                    lines: [
                      'Keep this job quarantined.',
                      'Run Preflight if you want a safe read-only check that the SQLite job DB still opens.',
                      'Live Repair and Live Drain are disabled because this job still has quarantined local SQLite state.',
                      'Worker startup will skip this job instead of auto-draining it.',
                      'Use offline repair after stopping the server stack, then remove quarantine only after that succeeds.',
                    ],
                    title: 'Recommended now',
                  }
                : hasOrphanedLocalQueue
                  ? {
                      lines: [
                        'This job has judged local queue rows with no SQLite outbox payload.',
                        'Use Repair Orphaned Queue to move recoverable rows back to Ready state in bounded batches.',
                        'Do not use Drain Storage until the orphaned local queue count reaches zero.',
                      ],
                      title: 'Repair required',
                    }
                  : null
            }
            const projectProviderConnection = () => {
              const modelId = projectDetailsQuery.data?.model?.id

              return modelId
                ? (providerConnectionsQuery.data?.connections.find((connection) => {
                    return connection.models.some((candidate) => {
                      return candidate.id === modelId
                    })
                  }) ?? null)
                : null
            }
            const projectModel = () => {
              const modelId = projectDetailsQuery.data?.model?.id
              const providerConnection = projectProviderConnection()

              return modelId && providerConnection
                ? (providerConnection.models.find((candidate) => {
                    return candidate.id === modelId
                  }) ?? null)
                : null
            }
            const runtimeModelNotice = () => {
              const providerModel = projectModel()

              return providerModel
                ? getSglangRuntimeModelNotice({
                    candidateModelNames: [providerModel.remoteModelId, providerModel.modelName],
                    getMismatchMessage: (runtimeLabel) => {
                      return `Active SGLang runtime model: ${runtimeLabel}. Starting this job will be blocked until it matches the project's model.`
                    },
                    providerKind: providerModel.provider,
                    runtime: providerConnectionsQuery.data?.runtime ?? null,
                  })
                : null
            }
            const judgingRuntimeWarning = () => {
              const runtime = data()?.judgingRuntime
              return runtime?.enabled === false ? (runtime.reason ?? 'Judging is disabled for this server.') : null
            }
            const jobQueueGridClass = () => {
              return `grid gap-4 ${shouldShowFulltextSkipped() ? 'grid-cols-5' : 'grid-cols-4'}`
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
                  <RuntimeModelNotice class="mt-4" notice={runtimeModelNotice()} />
                  <Show when={judgingRuntimeWarning()}>
                    {(warning) => {
                      return (
                        <div class="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                          {warning()}
                        </div>
                      )
                    }}
                  </Show>

                  <div class="mt-6 pt-6 border-t border-gray-200">
                    <h3 class="text-sm font-medium text-gray-900 mb-3">Provider</h3>
                    <div class="grid grid-cols-2 gap-4">
                      <div>
                        <p class="text-sm text-gray-500">Connection</p>
                        <Show
                          when={!projectDetailsQuery.isLoading && !providerConnectionsQuery.isLoading}
                          fallback={<p class="font-medium">Loading...</p>}
                        >
                          <Show
                            when={projectProviderConnection()}
                            fallback={<p class="font-medium">Unknown provider</p>}
                          >
                            {(connection) => {
                              return (
                                <a
                                  class="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                                  href={`/providers/${connection().id}`}
                                >
                                  {connection().label}
                                </a>
                              )
                            }}
                          </Show>
                        </Show>
                      </div>
                      <div>
                        <p class="text-sm text-gray-500">Current Active LLM Calls limit</p>
                        <Show
                          when={!projectDetailsQuery.isLoading && !providerConnectionsQuery.isLoading}
                          fallback={<p class="font-medium">Loading...</p>}
                        >
                          <Show when={projectProviderConnection()} fallback={<p class="font-medium">Unknown</p>}>
                            {(connection) => {
                              return (
                                <>
                                  <p class="font-medium">{formatProviderMaxInflightRequests(connection())}</p>
                                  <p class="text-xs text-gray-500 mt-1">
                                    Shared throughput ceiling for all jobs using this provider connection.
                                  </p>
                                </>
                              )
                            }}
                          </Show>
                        </Show>
                      </div>
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
                          <a href={unassessedArticlesLink()} class="font-medium text-blue-600 hover:text-blue-800">
                            {formattedUnassessedArticlesCount()}
                          </a>
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
                        <p class="text-sm text-blue-600 mb-1">Claimed</p>
                        <p class="text-2xl font-bold text-blue-900">{data()?.promptStats?.claimed ?? 0}</p>
                        <p class="text-xs text-blue-600 mt-1">
                          Reserved local backlog on this server that has not started running yet
                        </p>
                      </div>
                      <div class="bg-sky-50 rounded-lg p-4">
                        <p class="text-sm text-sky-600 mb-1">Running Prompts</p>
                        <p class="text-2xl font-bold text-sky-900">{data()?.promptStats?.running ?? 0}</p>
                        <p class="text-xs text-sky-600 mt-1">
                          Prompt executions started locally; one prompt can span multiple live LLM calls
                        </p>
                        <Show when={data()?.requestStats}>
                          <p class="text-xs font-medium text-sky-700 mt-1">
                            Live LLM calls: {data()?.requestStats?.inFlight ?? 0}
                          </p>
                        </Show>
                        <Show when={data()?.requestStats?.dispatch}>
                          <p class="text-xs text-sky-700 mt-1">
                            Worker active prompts: {data()?.requestStats?.dispatch?.jobActivePrompts ?? 0}
                          </p>
                          <p class="text-xs text-sky-700 mt-1">
                            Worker queued prompts: {data()?.requestStats?.dispatch?.jobQueuedPrompts ?? 0}
                          </p>
                        </Show>
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
                    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-7">
                      <div class="bg-sky-50 rounded-lg p-4">
                        <p class="text-sm text-sky-600 mb-1">Active LLM Calls</p>
                        <p class="text-2xl font-bold text-sky-900">{data()?.requestStats?.inFlight ?? 0}</p>
                        <p class="text-xs text-sky-600 mt-1">
                          Primary live throughput metric: request-level LLM calls running right now
                        </p>
                      </div>
                      <div class="bg-indigo-50 rounded-lg p-4">
                        <p class="text-sm text-indigo-600 mb-1">Attempts</p>
                        <p class="text-2xl font-bold text-indigo-900">{data()?.requestStats?.attempts ?? 0}</p>
                        <p class="text-xs text-indigo-600 mt-1">Total runtime request attempts, not distinct prompts</p>
                      </div>
                      <div class="bg-rose-50 rounded-lg p-4">
                        <p class="text-sm text-rose-700 mb-1">Failed Attempts</p>
                        <p class="text-2xl font-bold text-rose-900">
                          {data()?.requestStats?.failures?.persistedFailedRequests ?? 0}
                        </p>
                        <p class="text-xs text-rose-700 mt-1">Failed request attempts captured in token usage rows</p>
                      </div>
                      <div class="bg-fuchsia-50 rounded-lg p-4">
                        <p class="text-sm text-fuchsia-700 mb-1">Anthropic Refusals</p>
                        <p class="text-2xl font-bold text-fuchsia-900">
                          {data()?.requestStats?.failures?.anthropicRefusals ?? 0}
                        </p>
                        <p class="text-xs text-fuchsia-700 mt-1">
                          Articles affected: {data()?.requestStats?.failures?.anthropicRefusalArticles ?? 0}
                        </p>
                      </div>
                      <Show when={data()?.requestStats?.dispatch}>
                        <div class="bg-cyan-50 rounded-lg p-4">
                          <p class="text-sm text-cyan-700 mb-1">Worker Active Prompts</p>
                          <p class="text-2xl font-bold text-cyan-900">
                            {data()?.requestStats?.dispatch?.jobActivePrompts ?? 0}
                          </p>
                          <p class="text-xs text-cyan-700 mt-1">
                            This job&apos;s prompts currently occupying worker active slots
                          </p>
                        </div>
                        <div class="bg-teal-50 rounded-lg p-4">
                          <p class="text-sm text-teal-700 mb-1">Worker Queued Prompts</p>
                          <p class="text-2xl font-bold text-teal-900">
                            {data()?.requestStats?.dispatch?.jobQueuedPrompts ?? 0}
                          </p>
                          <p class="text-xs text-teal-700 mt-1">
                            This job&apos;s prompts already claimed and waiting for a provider slot
                          </p>
                        </div>
                        <div class="bg-violet-50 rounded-lg p-4">
                          <p class="text-sm text-violet-700 mb-1">Provider Prefetch Fill</p>
                          <p class="text-2xl font-bold text-violet-900">
                            {formatPercent(data()?.requestStats?.providerTelemetry?.providerRequestFillPct)}
                          </p>
                          <p class="text-xs text-violet-700 mt-1">
                            Dispatch queue: {data()?.requestStats?.dispatch?.providerDispatchQueuedPrompts ?? 0}/
                            {data()?.requestStats?.dispatch?.providerDispatchQueueLimit ?? 0}
                          </p>
                          <p class="text-xs text-violet-700 mt-1">
                            Request leases: {data()?.requestStats?.providerTelemetry?.providerLeasedLiveRequests ?? 0}/
                            {data()?.requestStats?.providerTelemetry?.normalRequestCapacity ?? 0} (
                            {formatPercent(data()?.requestStats?.providerTelemetry?.providerRequestFillPct)})
                          </p>
                          <p class="text-xs text-violet-700 mt-1">
                            Probe leases: {data()?.requestStats?.providerTelemetry?.providerLeasedProbeCalls ?? 0}
                          </p>
                        </div>
                      </Show>
                    </div>
                  </div>
                </Show>

                <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
                  <div class="flex items-start justify-between gap-4 mb-4">
                    <div>
                      <h2 class="text-lg font-semibold">Local Storage Health</h2>
                      <p class="text-sm text-gray-500 mt-1">
                        Live per-job SQLite state and targeted recovery controls.
                      </p>
                    </div>
                    <span class="px-3 py-1 rounded-full text-sm font-medium border bg-gray-100 text-gray-800 border-gray-200">
                      {formatStatus(data()?.storageState ?? null)}
                    </span>
                  </div>

                  <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">Storage State</p>
                      <p class="font-medium mt-1">{formatStatus(data()?.storageState ?? null)}</p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">Repair Mode</p>
                      <p class="font-medium mt-1">{formatRepairMode(storagePolicy()?.repairMode)}</p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">Startup Handling</p>
                      <p class="font-medium mt-1">{formatStartupHandling(storagePolicy()?.startupHandling)}</p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">SQLite Size</p>
                      <p class="font-medium mt-1">{formatByteSize(storageHealth()?.sqliteFileBytes)}</p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">WAL Size</p>
                      <p class="font-medium mt-1">{formatByteSize(storageHealth()?.walBytes)}</p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">Outbox Rows</p>
                      <p class="font-medium mt-1">{storageHealth()?.outboxRowCount ?? 0}</p>
                      <p class="text-xs text-gray-500 mt-1">
                        Claimed: {storageHealth()?.claimedOutboxCount ?? 0} | Retained:{' '}
                        {storageHealth()?.retainedRowCount ?? 0}
                      </p>
                      <p class="text-xs text-gray-500 mt-1">
                        Pending refresh ACK: {storageHealth()?.pendingCompletionAckCount ?? 0}
                      </p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">Orphaned Local Queue</p>
                      <p class="font-medium mt-1">{storageHealth()?.orphanedJudgedRowCount ?? 0}</p>
                      <p class="text-xs text-gray-500 mt-1">Repair processes up to 1,000 rows per action.</p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4 md:col-span-2 xl:col-span-1">
                      <p class="text-sm text-gray-500">Recent Outbox Flow</p>
                      <p class="font-medium mt-1">
                        Net {formatSignedRowCount(recentTransfer()?.netRows)} (
                        {formatRowsPerMinute(recentTransfer()?.netRowsPerMinute ?? 0)})
                      </p>
                      <p class="text-xs text-gray-500 mt-1">
                        Last {recentTransfer()?.windowMinutes ?? 5}m of actual runtime activity
                      </p>
                      <p class="text-xs text-gray-500 mt-1">
                        Added: {(recentTransfer()?.addedRows ?? 0).toLocaleString()} (
                        {formatRowsPerMinute(recentTransfer()?.addedRowsPerMinute ?? 0)})
                      </p>
                      <p class="text-xs text-gray-500 mt-1">
                        Cleared: {(recentTransfer()?.clearedRows ?? 0).toLocaleString()} (
                        {formatRowsPerMinute(recentTransfer()?.clearedRowsPerMinute ?? 0)})
                      </p>
                      <p class="text-xs text-gray-500 mt-1">
                        DuckDB inserts: {(recentTransfer()?.insertedRows ?? 0).toLocaleString()} (
                        {formatRowsPerMinute(recentTransfer()?.insertedRowsPerMinute ?? 0)})
                      </p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">Oldest Unexported</p>
                      <p class="font-medium mt-1">{formatDuration(storageHealth()?.oldestUnexportedAgeMs)}</p>
                      <p class="text-xs text-gray-500 mt-1">Last ACK seq: {storageHealth()?.lastAckSeq ?? 'N/A'}</p>
                      <p class="text-xs text-gray-500 mt-1">
                        Oldest pending refresh ACK: {formatDuration(storageHealth()?.oldestUnackedCompletionAgeMs)}
                      </p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4 md:col-span-2 xl:col-span-1">
                      <p class="text-sm text-gray-500">Projected Storage Drain</p>
                      <p class="font-medium mt-1">
                        {formatDuration(storageHealth()?.projection?.estimatedStorageDrainRemainingMs)}
                      </p>
                      <p class="text-xs text-gray-500 mt-1">
                        ETA: {formatDateTime(storageHealth()?.projection?.projectedStorageDrainAt)}
                      </p>
                      <p class="text-xs text-gray-500 mt-1">
                        Phase:{' '}
                        {storageHealth()?.projection?.currentPhase
                          ? formatStatus(storageHealth()?.projection?.currentPhase ?? null)
                          : 'N/A'}{' '}
                        | Current phase ETA:{' '}
                        {formatDuration(storageHealth()?.projection?.estimatedCurrentPhaseRemainingMs)}
                      </p>
                      <p class="text-xs text-gray-500 mt-1">
                        Throughput: {formatRowsPerMinute(storageHealth()?.projection?.rowsPerMinute)} | Active rebuilds:{' '}
                        {storageHealth()?.projection?.activeLargeRebuildProjectCount ?? 'N/A'}
                      </p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">Import Failures</p>
                      <p class="font-medium mt-1">{data()?.importFailureCount ?? 0}</p>
                      <p class="text-xs text-gray-500 mt-1">Last exit code: {data()?.lastImportExitCode ?? 'N/A'}</p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">Last Import Success</p>
                      <p class="font-medium mt-1">{formatDateTime(data()?.lastImportCompletedAt)}</p>
                      <p class="text-xs text-gray-500 mt-1">Started: {formatDateTime(data()?.lastImportStartedAt)}</p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4 md:col-span-2 xl:col-span-1">
                      <p class="text-sm text-gray-500">Last Import Failure</p>
                      <p class="font-medium mt-1">{formatDateTime(data()?.lastImportErrorAt)}</p>
                      <p class="text-xs text-gray-500 mt-1 break-words">
                        {data()?.lastImportError ?? 'No recent import failure'}
                      </p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">Lease Acquired</p>
                      <p class="font-medium mt-1">{formatDateTime(leaseMetadata()?.acquiredAt)}</p>
                      <p class="text-xs text-gray-500 mt-1">
                        API server port: {leaseMetadata()?.apiServerPort ?? 'N/A'}
                      </p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">Lease Host</p>
                      <p class="font-medium mt-1">{leaseMetadata()?.hostname ?? 'N/A'}</p>
                      <p class="text-xs text-gray-500 mt-1">PID: {leaseMetadata()?.pid ?? 'N/A'}</p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">Lease ID</p>
                      <p class="font-medium mt-1 break-all">{leaseMetadata()?.leaseId ?? 'N/A'}</p>
                      <p class="text-xs text-gray-500 mt-1">Server Job: {leaseMetadata()?.serverJobId ?? 'N/A'}</p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4">
                      <p class="text-sm text-gray-500">Lease Heartbeat</p>
                      <p class="font-medium mt-1">{formatDateTime(leaseMetadata()?.heartbeatAt)}</p>
                      <p class="text-xs text-gray-500 mt-1">Age: {formatDuration(leaseHeartbeatAgeMs())}</p>
                    </div>
                    <div class="bg-gray-50 rounded-lg p-4 md:col-span-2 xl:col-span-1">
                      <p class="text-sm text-gray-500">Quarantine Reason</p>
                      <p class="font-medium mt-1 break-words">{data()?.quarantineReason ?? 'Not quarantined'}</p>
                    </div>
                  </div>

                  <div class="mt-6 pt-6 border-t border-gray-200">
                    <Show when={recoveryGuidance()}>
                      {(guidance) => {
                        return (
                          <div class="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                            <p class="font-medium">{guidance().title}</p>
                            <ul class="mt-2 list-disc space-y-1 pl-5">
                              <For each={guidance().lines}>
                                {(line) => {
                                  return <li>{line}</li>
                                }}
                              </For>
                            </ul>
                          </div>
                        )
                      }}
                    </Show>
                    <h3 class="text-sm font-medium text-gray-900 mb-3">Repair Actions</h3>
                    <div class="flex flex-wrap gap-3">
                      <For each={repairButtons()}>
                        {(button) => {
                          return (
                            <button
                              class="px-4 py-2 bg-slate-700 text-white rounded-md hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
                              disabled={Boolean(isRepairing()) || isLiveRepairButtonDisabled(button.action)}
                              onClick={() => {
                                const jobId = data()?.id
                                if (jobId) {
                                  return void handleRepairAction({action: button.action, jobId})
                                }
                              }}
                            >
                              {isRepairing() === button.action ? `${button.label}...` : button.label}
                            </button>
                          )
                        }}
                      </For>
                      <Show when={data()?.storageState !== 'quarantined'}>
                        <button
                          class="px-4 py-2 bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          disabled={Boolean(isRepairing())}
                          onClick={() => {
                            const jobId = data()?.id
                            if (jobId) {
                              return void handleRepairAction({action: 'quarantine', jobId})
                            }
                          }}
                        >
                          {isRepairing() === 'quarantine' ? 'Quarantining...' : 'Quarantine Job'}
                        </button>
                      </Show>
                      <Show when={data()?.storageState === 'quarantined'}>
                        <button
                          class="px-4 py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          disabled={Boolean(isRepairing()) || isOfflineRepairOnly()}
                          onClick={() => {
                            const jobId = data()?.id
                            if (jobId) {
                              return void handleRepairAction({action: 'unquarantine', jobId})
                            }
                          }}
                        >
                          {isRepairing() === 'unquarantine' ? 'Removing Quarantine...' : 'Remove Quarantine'}
                        </button>
                      </Show>
                    </div>
                  </div>
                </div>

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
                  <div class="flex flex-col gap-3">
                    <div class="flex gap-3">
                      <Show when={data()?.status === 'running'}>
                        <button
                          class="px-4 py-2 bg-yellow-600 text-white rounded-md hover:bg-yellow-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          disabled={isPausing()}
                          onClick={() => {
                            const jobId = data()?.id
                            if (jobId) {
                              return void handlePauseJob(jobId)
                            }
                          }}
                        >
                          {isPausing() ? 'Pausing...' : 'Pause Job'}
                        </button>
                      </Show>
                      <Show when={data()?.status === 'paused'}>
                        <button
                          class="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          disabled={isStarting() || isStartingClean() || isPausing() || isResumeBlocked()}
                          onClick={() => {
                            const jobId = data()?.id
                            if (jobId) {
                              return void handleStartJob(jobId)
                            }
                          }}
                        >
                          {isStarting() ? 'Starting...' : 'Start Job'}
                        </button>
                      </Show>
                      <Show when={data()?.status === 'failed'}>
                        <button
                          class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          disabled={isStarting() || isStartingClean() || isPausing() || isResumeBlocked()}
                          onClick={() => {
                            const jobId = data()?.id
                            if (jobId) {
                              return void handleStartJob(jobId)
                            }
                          }}
                        >
                          {isStarting() ? 'Retrying...' : 'Retry Job'}
                        </button>
                      </Show>
                      <Show when={data()?.status === 'paused' || data()?.status === 'failed'}>
                        <button
                          class="px-4 py-2 bg-slate-700 text-white rounded-md hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
                          disabled={isStarting() || isStartingClean() || isPausing()}
                          onClick={() => {
                            const jobId = data()?.id

                            if (!jobId) return
                            if (
                              !confirm(
                                'Start this job clean? This will reset local SQLite queue state for this job but keep the job and token usage history.',
                              )
                            ) {
                              return
                            }

                            return void handleStartJobClean(jobId)
                          }}
                        >
                          {isStartingClean() ? 'Starting Clean...' : 'Start Job Clean'}
                        </button>
                      </Show>
                      <button
                        class="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={isDeleting() || isStarting() || isStartingClean() || isPausing()}
                        onClick={() => {
                          const jobId = data()?.id
                          if (!jobId) return
                          if (!confirm('Are you sure you want to delete this job? This action cannot be undone.'))
                            return
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
                    <Show when={actionError()}>
                      {(message) => {
                        return (
                          <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                            {message()}
                          </div>
                        )
                      }}
                    </Show>
                    <Show when={actionNotice()}>
                      {(message) => {
                        return (
                          <div class="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                            {message()}
                          </div>
                        )
                      }}
                    </Show>
                    <Show when={resumeBlockedReason()}>
                      {(message) => {
                        return (
                          <div class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            {message()}
                          </div>
                        )
                      }}
                    </Show>
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
