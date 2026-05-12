import {useQuery} from '@tanstack/solid-query'
import {createFileRoute, Link, useNavigate} from '@tanstack/solid-router'
import {formatDate} from 'date-fns'
import {createEffect, createSignal, For, onCleanup, type ParentProps, Show, Suspense} from 'solid-js'

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
import {JobTelemetryPanel} from './jobTelemetryPanel.tsx'
import {JobTelemetryHistoryChart} from './jobTelemetryPanel/jobTelemetryHistoryChart.tsx'

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

const formatBoolean = (value: boolean | null | undefined) => {
  return value === true ? 'Yes' : value === false ? 'No' : 'N/A'
}

const formatMetricCount = (value: number | null | undefined) => {
  return Number(value ?? 0).toLocaleString()
}

const formatOptionalMetricCount = (value: number | null | undefined) => {
  return value === null || value === undefined ? 'N/A' : formatMetricCount(value)
}

const getRequestSlotWaiterText = (requestStats: Partial<JudgmentJobRequestStats> | undefined) => {
  const waiters = requestStats?.requestSlotWaiters

  return waiters
    ? `provider ${formatMetricCount(waiters.providerAdmission)}, worker ${formatMetricCount(
        waiters.worker,
      )}, Codex ${formatMetricCount(waiters.codex)}, fallback ${formatMetricCount(waiters.fallback)}`
    : 'N/A'
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

type DenseMetricTone = 'amber' | 'blue' | 'cyan' | 'emerald' | 'gray' | 'indigo' | 'rose' | 'sky'
type DenseMetricProps = ParentProps<{description?: string; label: string; tone?: DenseMetricTone}>
type MetricGroupProps = ParentProps<{description?: string; title: string}>

const getDenseMetricToneClass = (tone: DenseMetricTone | undefined) => {
  switch (tone) {
    case 'amber':
      return 'border-amber-200 bg-amber-50 text-amber-950'
    case 'blue':
      return 'border-blue-200 bg-blue-50 text-blue-950'
    case 'cyan':
      return 'border-cyan-200 bg-cyan-50 text-cyan-950'
    case 'emerald':
      return 'border-emerald-200 bg-emerald-50 text-emerald-950'
    case 'indigo':
      return 'border-indigo-200 bg-indigo-50 text-indigo-950'
    case 'rose':
      return 'border-rose-200 bg-rose-50 text-rose-950'
    case 'sky':
      return 'border-sky-200 bg-sky-50 text-sky-950'
    default:
      return 'border-gray-200 bg-gray-50 text-gray-950'
  }
}

const DenseMetric = (props: DenseMetricProps) => {
  return (
    <div class={`min-w-0 rounded-md border px-3 py-2 ${getDenseMetricToneClass(props.tone)}`}>
      <p class="break-words text-xs font-medium text-gray-500">{props.label}</p>
      <div class="mt-1 break-words text-base font-semibold">{props.children}</div>
      <Show when={props.description}>
        {(description) => {
          return <p class="mt-1 break-words text-xs leading-5 opacity-75">{description()}</p>
        }}
      </Show>
    </div>
  )
}

const MetricGroup = (props: MetricGroupProps) => {
  return (
    <div class="min-w-0 space-y-3">
      <div>
        <h3 class="text-sm font-medium text-gray-900">{props.title}</h3>
        <Show when={props.description}>
          {(description) => {
            return <p class="mt-1 break-words text-sm text-gray-500">{description()}</p>
          }}
        </Show>
      </div>
      {props.children}
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
  const handleDeleteJob = (jobId: string) => {
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
  }
  // console.log('job.data:', job.data?.unassessedArticlesCount)
  // console.log('job.data type:', typeof job, Array.isArray(job))

  return (
    <div class="min-h-screen overflow-x-hidden bg-gray-50 px-4 py-6 sm:px-6">
      <div class="mx-auto max-w-7xl min-w-0">
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
            const liveRequestLlmCalls = () => {
              return data()?.requestStats?.liveLlmCalls ?? data()?.requestStats?.inFlight ?? 0
            }
            const dispatchStats = () => {
              return data()?.requestStats?.dispatch
            }
            return (
              <>
                <div class="mb-6 overflow-hidden rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
                  <div class="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div class="min-w-0 flex-1 space-y-4">
                      <div class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div class="min-w-0">
                          <p class="text-sm text-gray-500">Project</p>
                          <Show
                            when={data()?.projectId}
                            fallback={<p class="font-medium break-words">{data()?.projectName || 'Unknown Project'}</p>}
                          >
                            {(projectId) => {
                              return (
                                <Link
                                  to="/projects/$id"
                                  params={{id: projectId()}}
                                  class="font-medium text-blue-600 break-words hover:text-blue-800 hover:underline"
                                >
                                  {data()?.projectName || 'Unknown Project'}
                                </Link>
                              )
                            }}
                          </Show>
                        </div>
                        <div class="flex flex-wrap gap-2">
                          <span
                            class={`inline-flex rounded-full border px-3 py-1 text-sm font-medium ${getStatusColor(data()?.status ?? null)}`}
                          >
                            {formatStatus(data()?.status ?? null)}
                          </span>
                          <span class="inline-flex rounded-full border border-gray-200 bg-gray-100 px-3 py-1 text-sm font-medium text-gray-800">
                            Storage: {formatStatus(data()?.storageState ?? null)}
                          </span>
                        </div>
                      </div>

                      <div class="min-w-0">
                        <h1 class="text-2xl font-bold text-gray-900">Job</h1>
                        <p class="mt-1 break-all font-mono text-sm text-gray-500">{data()?.id}</p>
                      </div>

                      <div class="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        <div class="min-w-0">
                          <p class="text-sm text-gray-500">Project ID</p>
                          <p class="break-all font-mono text-sm text-gray-900">{data()?.projectId ?? 'N/A'}</p>
                        </div>
                        <div class="min-w-0">
                          <p class="text-sm text-gray-500">Created</p>
                          <p class="font-medium text-gray-900">{formatDateTime(data()?.createdAt)}</p>
                        </div>
                        <div class="min-w-0">
                          <p class="text-sm text-gray-500">Last Updated</p>
                          <p class="font-medium text-gray-900">{formatDateTime(data()?.updatedAt)}</p>
                        </div>
                      </div>
                    </div>

                    <div class="min-w-0 xl:w-96 xl:flex-none">
                      <div class="flex flex-wrap gap-3 xl:justify-end">
                        <Show when={data()?.status === 'running'}>
                          <button
                            class="rounded-md bg-yellow-600 px-4 py-2 text-sm font-medium text-white hover:bg-yellow-700 disabled:cursor-not-allowed disabled:opacity-50"
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
                            class="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
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
                            class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
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
                            class="rounded-md bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
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
                      </div>
                    </div>
                  </div>

                  <Show
                    when={
                      runtimeModelNotice()
                      || judgingRuntimeWarning()
                      || actionError()
                      || actionNotice()
                      || resumeBlockedReason()
                    }
                  >
                    <div class="mt-4 min-w-0 space-y-3 border-t border-gray-200 pt-4">
                      <RuntimeModelNotice class="break-words" notice={runtimeModelNotice()} />
                      <Show when={judgingRuntimeWarning()}>
                        {(warning) => {
                          return (
                            <div class="break-words rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                              {warning()}
                            </div>
                          )
                        }}
                      </Show>
                      <Show when={actionError()}>
                        {(message) => {
                          return (
                            <div class="break-words rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                              {message()}
                            </div>
                          )
                        }}
                      </Show>
                      <Show when={actionNotice()}>
                        {(message) => {
                          return (
                            <div class="break-words rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                              {message()}
                            </div>
                          )
                        }}
                      </Show>
                      <Show when={resumeBlockedReason()}>
                        {(message) => {
                          return (
                            <div class="break-words rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                              {message()}
                            </div>
                          )
                        }}
                      </Show>
                    </div>
                  </Show>
                </div>

                <Show when={data()?.error && Array.isArray(data()?.error) && (data()?.error?.length ?? 0) > 0}>
                  <div class="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
                    <h2 class="mb-2 text-lg font-semibold text-red-900">Errors</h2>
                    <ul class="list-disc space-y-1 pl-5">
                      <For each={data()?.error ?? []}>
                        {(err) => {
                          return <li class="break-words text-red-700">{err}</li>
                        }}
                      </For>
                    </ul>
                  </div>
                </Show>

                <section class="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
                  <div class="mb-4">
                    <h2 class="text-lg font-semibold text-gray-900">Work Definition</h2>
                    <p class="mt-1 break-words text-sm text-gray-500">
                      Provider connection, request limit, remaining article scope, and token totals for this job.
                    </p>
                  </div>

                  <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <DenseMetric label="Provider Connection">
                      <Show
                        when={!projectDetailsQuery.isLoading && !providerConnectionsQuery.isLoading}
                        fallback={<span>Loading...</span>}
                      >
                        <Show when={projectProviderConnection()} fallback={<span>Unknown provider</span>}>
                          {(connection) => {
                            return (
                              <a
                                class="break-words text-blue-600 hover:text-blue-800 hover:underline"
                                href={`/providers/${connection().id}`}
                              >
                                {connection().label}
                              </a>
                            )
                          }}
                        </Show>
                      </Show>
                    </DenseMetric>
                    <DenseMetric
                      description="Shared throughput ceiling for all jobs using this provider connection."
                      label="Current request-level LLM call limit"
                    >
                      <Show
                        when={!projectDetailsQuery.isLoading && !providerConnectionsQuery.isLoading}
                        fallback={<span>Loading...</span>}
                      >
                        <Show when={projectProviderConnection()} fallback={<span>Unknown</span>}>
                          {(connection) => {
                            return <span>{formatProviderMaxInflightRequests(connection())}</span>
                          }}
                        </Show>
                      </Show>
                    </DenseMetric>
                    <DenseMetric label="Unassessed Articles">
                      <Show when={!unassessedCountQuery.isLoading} fallback={<span>Loading...</span>}>
                        <Show
                          when={shouldLinkToUnassessedArticles()}
                          fallback={<span>{formattedUnassessedArticlesCount()}</span>}
                        >
                          <a href={unassessedArticlesLink()} class="text-blue-600 hover:text-blue-800 hover:underline">
                            {formattedUnassessedArticlesCount()}
                          </a>
                        </Show>
                      </Show>
                    </DenseMetric>
                    <DenseMetric label="Total Tokens" tone="indigo">
                      {formatMetricCount(data()?.totalTokenUsage?.totalTokens)}
                    </DenseMetric>
                    <DenseMetric label="Prompt Tokens" tone="blue">
                      {formatMetricCount(data()?.totalTokenUsage?.totalPromptTokens)}
                    </DenseMetric>
                    <DenseMetric label="Completion Tokens" tone="cyan">
                      {formatMetricCount(data()?.totalTokenUsage?.totalCompletionTokens)}
                    </DenseMetric>
                  </div>
                </section>

                <section class="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
                  <div class="mb-4">
                    <h2 class="text-lg font-semibold text-gray-900">Pipeline Summary</h2>
                    <p class="mt-1 break-words text-sm text-gray-500">
                      Prompt lifecycle and request-level progress before provider capacity diagnostics.
                    </p>
                  </div>

                  <div class="space-y-6">
                    <MetricGroup
                      description="Prompt queue state for this job's project, model, and content settings."
                      title="Prompt Queue"
                    >
                      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                        <DenseMetric description="Prompts queued for judgment." label="Ready">
                          {formatMetricCount(data()?.promptStats?.ready)}
                        </DenseMetric>
                        <DenseMetric
                          description="Reserved local backlog that has not started running yet."
                          label="Claimed"
                          tone="blue"
                        >
                          {formatMetricCount(data()?.promptStats?.claimed)}
                        </DenseMetric>
                        <DenseMetric description="Prompt executions started locally." label="Running" tone="sky">
                          {formatMetricCount(data()?.promptStats?.running)}
                        </DenseMetric>
                        <DenseMetric description="Prompts with judgments completed." label="Judged" tone="emerald">
                          {formatMetricCount(data()?.promptStats?.judged)}
                        </DenseMetric>
                        <DenseMetric description="Skipped prompt rows." label="Skipped" tone="amber">
                          {formatMetricCount(data()?.promptStats?.skipped)}
                        </DenseMetric>
                      </div>
                    </MetricGroup>

                    <MetricGroup
                      description="Request attempts are counted separately from prompt lifecycle rows."
                      title="Request Activity"
                    >
                      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <DenseMetric
                          description="Request-level LLM calls running right now."
                          label="Live Request LLM Calls"
                          tone="sky"
                        >
                          {formatMetricCount(liveRequestLlmCalls())}
                        </DenseMetric>
                        <DenseMetric
                          description="Total runtime request attempts, not distinct prompts."
                          label="Attempts"
                          tone="indigo"
                        >
                          {formatMetricCount(data()?.requestStats?.attempts)}
                        </DenseMetric>
                        <DenseMetric
                          description="Failed request attempts captured in token usage rows."
                          label="Failed Attempts"
                          tone="rose"
                        >
                          {formatMetricCount(data()?.requestStats?.failures?.persistedFailedRequests)}
                        </DenseMetric>
                        <DenseMetric
                          description={`Articles affected: ${formatMetricCount(
                            data()?.requestStats?.failures?.anthropicRefusalArticles,
                          )}`}
                          label="Anthropic Refusals"
                          tone="rose"
                        >
                          {formatMetricCount(data()?.requestStats?.failures?.anthropicRefusals)}
                        </DenseMetric>
                      </div>
                    </MetricGroup>
                  </div>
                </section>

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

                <section class="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
                  <div class="mb-3">
                    <h2 class="text-lg font-semibold text-gray-900">Request And Capacity Debug</h2>
                    <p class="mt-1 break-words text-sm text-gray-500">
                      Local prompt-slot state and request-slot waits for this job&apos;s current execution path.
                    </p>
                  </div>

                  <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    <DenseMetric
                      description="This job's prompts currently occupying worker prompt slots."
                      label="Worker Prompt Slots"
                      tone="cyan"
                    >
                      {formatOptionalMetricCount(dispatchStats()?.jobActivePrompts)}
                    </DenseMetric>
                    <DenseMetric
                      description="This job's prompts already claimed and waiting in the worker prompt queue."
                      label="Worker Queued Prompts"
                      tone="blue"
                    >
                      {formatOptionalMetricCount(dispatchStats()?.jobQueuedPrompts)}
                    </DenseMetric>
                    <DenseMetric
                      description={`Prompt queue: ${formatOptionalMetricCount(
                        dispatchStats()?.providerDispatchQueuedPrompts,
                      )}/${formatOptionalMetricCount(
                        dispatchStats()?.providerDispatchQueueLimit,
                      )}; prompt active slots: ${formatOptionalMetricCount(
                        dispatchStats()?.providerDispatchActivePrompts,
                      )}/${formatOptionalMetricCount(dispatchStats()?.providerDispatchActivePromptLimit)} (${formatPercent(
                        dispatchStats()?.providerDispatchActivePromptFillPct,
                      )})`}
                      label="Prompt Prefetch Fill"
                      tone="indigo"
                    >
                      {formatPercent(dispatchStats()?.providerDispatchPrefetchFillPct)}
                    </DenseMetric>
                    <DenseMetric
                      description="Waiters are grouped by the capacity surface they are blocked on."
                      label="Request Slot Waiters"
                      tone="amber"
                    >
                      {getRequestSlotWaiterText(data()?.requestStats)}
                    </DenseMetric>
                  </div>
                </section>

                <JobTelemetryPanel requestStats={data()?.requestStats} />
                <JobTelemetryHistoryChart
                  jobId={id()}
                  providerKey={data()?.requestStats?.providerTelemetry?.providerKey}
                />

                <div class="mb-6 min-w-0 rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
                  <div class="mb-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div class="min-w-0">
                      <h2 class="text-lg font-semibold text-gray-900">Storage And Import Flow</h2>
                      <p class="mt-1 break-words text-sm text-gray-500">
                        Local SQLite state, import closeout, runtime lease metadata, and targeted recovery controls.
                      </p>
                    </div>
                    <span class="max-w-full self-start rounded-full border border-gray-200 bg-gray-100 px-3 py-1 text-sm font-medium text-gray-800">
                      {formatStatus(data()?.storageState ?? null)}
                    </span>
                  </div>

                  <div class="space-y-6">
                    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      <DenseMetric
                        description={`Local SQLite state: ${formatBoolean(storagePolicy()?.hasLocalSqliteState)}`}
                        label="Storage Policy"
                      >
                        <span>{formatRepairMode(storagePolicy()?.repairMode)}</span>
                        <span class="mx-1 text-gray-400">/</span>
                        <span>{formatStartupHandling(storagePolicy()?.startupHandling)}</span>
                      </DenseMetric>
                      <DenseMetric
                        description={`WAL: ${formatByteSize(storageHealth()?.walBytes)}`}
                        label="SQLite / WAL Size"
                      >
                        {formatByteSize(storageHealth()?.sqliteFileBytes)}
                      </DenseMetric>
                      <DenseMetric
                        description={`Claimed ${formatMetricCount(
                          storageHealth()?.claimedOutboxCount,
                        )}, retained ${formatMetricCount(
                          storageHealth()?.retainedRowCount,
                        )}, pending ACK ${formatMetricCount(storageHealth()?.pendingCompletionAckCount)}`}
                        label="Outbox / ACK"
                        tone="blue"
                      >
                        {formatMetricCount(storageHealth()?.outboxRowCount)}
                      </DenseMetric>
                      <DenseMetric
                        description="Repair processes up to 1,000 rows per action."
                        label="Orphaned Local Queue"
                        tone="rose"
                      >
                        {formatMetricCount(storageHealth()?.orphanedJudgedRowCount)}
                      </DenseMetric>
                      <DenseMetric
                        description={`Last ${recentTransfer()?.windowMinutes ?? 5}m; added ${formatMetricCount(
                          recentTransfer()?.addedRows,
                        )} (${formatRowsPerMinute(
                          recentTransfer()?.addedRowsPerMinute ?? 0,
                        )}), cleared ${formatMetricCount(recentTransfer()?.clearedRows)} (${formatRowsPerMinute(
                          recentTransfer()?.clearedRowsPerMinute ?? 0,
                        )}), DuckDB inserts ${formatMetricCount(
                          recentTransfer()?.insertedRows,
                        )} (${formatRowsPerMinute(recentTransfer()?.insertedRowsPerMinute ?? 0)})`}
                        label="Recent Transfer Flow"
                        tone="cyan"
                      >
                        Net {formatSignedRowCount(recentTransfer()?.netRows)} (
                        {formatRowsPerMinute(recentTransfer()?.netRowsPerMinute ?? 0)})
                      </DenseMetric>
                      <DenseMetric
                        description={`Last ACK seq: ${storageHealth()?.lastAckSeq ?? 'N/A'}; oldest pending refresh ACK: ${formatDuration(
                          storageHealth()?.oldestUnackedCompletionAgeMs,
                        )}`}
                        label="Oldest Unexported / ACK Age"
                        tone="amber"
                      >
                        {formatDuration(storageHealth()?.oldestUnexportedAgeMs)}
                      </DenseMetric>
                      <DenseMetric
                        description={`ETA ${formatDateTime(
                          storageHealth()?.projection?.projectedStorageDrainAt,
                        )}; phase ${
                          storageHealth()?.projection?.currentPhase
                            ? formatStatus(storageHealth()?.projection?.currentPhase ?? null)
                            : 'N/A'
                        }; current phase ETA ${formatDuration(
                          storageHealth()?.projection?.estimatedCurrentPhaseRemainingMs,
                        )}; throughput ${formatRowsPerMinute(
                          storageHealth()?.projection?.rowsPerMinute,
                        )}; active rebuilds ${storageHealth()?.projection?.activeLargeRebuildProjectCount ?? 'N/A'}`}
                        label="Projected Drain"
                        tone="indigo"
                      >
                        {formatDuration(storageHealth()?.projection?.estimatedStorageDrainRemainingMs)}
                      </DenseMetric>
                    </div>

                    <MetricGroup
                      description="Last successful and failed import closeout details."
                      title="Import Success / Failure"
                    >
                      <div class="grid gap-3 md:grid-cols-3">
                        <DenseMetric
                          description={`Started: ${formatDateTime(data()?.lastImportStartedAt)}`}
                          label="Last Import Success"
                          tone="emerald"
                        >
                          {formatDateTime(data()?.lastImportCompletedAt)}
                        </DenseMetric>
                        <DenseMetric
                          description={`Last exit code: ${data()?.lastImportExitCode ?? 'N/A'}`}
                          label="Import Failures"
                          tone="rose"
                        >
                          {formatMetricCount(data()?.importFailureCount)}
                        </DenseMetric>
                        <DenseMetric label="Last Import Failure" tone="amber">
                          <span>{formatDateTime(data()?.lastImportErrorAt)}</span>
                          <span class="mt-1 block break-words text-xs font-medium text-gray-600">
                            {data()?.lastImportError ?? 'No recent import failure'}
                          </span>
                        </DenseMetric>
                      </div>
                    </MetricGroup>

                    <DenseMetric label="Quarantine Reason" tone="amber">
                      <span class="break-words">{data()?.quarantineReason ?? 'Not quarantined'}</span>
                    </DenseMetric>

                    <MetricGroup
                      description="Compact owner lease metadata for the local runtime that last acquired this job."
                      title="Runtime Lease"
                    >
                      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        <DenseMetric label="Lease Host" tone="gray">
                          <span class="break-all">{leaseMetadata()?.hostname ?? 'N/A'}</span>
                          <span class="mt-1 block break-words text-xs font-medium text-gray-600">
                            PID: {leaseMetadata()?.pid ?? 'N/A'}
                          </span>
                        </DenseMetric>
                        <DenseMetric label="Lease ID" tone="gray">
                          <span class="break-all">{leaseMetadata()?.leaseId ?? 'N/A'}</span>
                          <span class="mt-1 block break-all text-xs font-medium text-gray-600">
                            Server job: {leaseMetadata()?.serverJobId ?? 'N/A'}
                          </span>
                        </DenseMetric>
                        <DenseMetric
                          description={`Acquired: ${formatDateTime(leaseMetadata()?.acquiredAt)}; age ${formatDuration(
                            leaseHeartbeatAgeMs(),
                          )}`}
                          label="Port / Heartbeat"
                          tone="gray"
                        >
                          <span>{leaseMetadata()?.apiServerPort ?? 'N/A'}</span>
                          <span class="mx-1 text-gray-400">/</span>
                          <span>{formatDateTime(leaseMetadata()?.heartbeatAt)}</span>
                        </DenseMetric>
                      </div>
                    </MetricGroup>
                  </div>

                  <div class="mt-6 border-t border-gray-200 pt-6">
                    <Show when={recoveryGuidance()}>
                      {(guidance) => {
                        return (
                          <div class="mb-4 break-words rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                            <p class="font-medium">{guidance().title}</p>
                            <ul class="mt-2 list-disc space-y-1 pl-5">
                              <For each={guidance().lines}>
                                {(line) => {
                                  return <li class="break-words">{line}</li>
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

                  <div class="mt-6 border-t border-red-200 pt-6">
                    <h3 class="mb-2 text-sm font-medium text-red-900">Danger Actions</h3>
                    <p class="mb-3 break-words text-sm text-red-700">
                      Delete removes this job permanently. Use recovery actions first when local state may still be
                      repairable.
                    </p>
                    <button
                      class="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={isDeleting() || isStarting() || isStartingClean() || isPausing()}
                      onClick={() => {
                        const jobId = data()?.id
                        if (jobId) {
                          return handleDeleteJob(jobId)
                        }
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
