import {formatDate} from 'date-fns'

import {
  fetchJudgmentsJobs,
  type JudgmentJobProviderTelemetry,
  type JudgmentJobProviderTelemetryHistoryBucket,
  type JudgmentJobProviderTelemetryHistoryRange,
  type JudgmentJobTelemetrySource,
} from '../../../../services/judgmentsJobsService'

export type JobHealthBadge =
  | 'Healthy'
  | 'Draining'
  | 'Large WAL'
  | 'Offline Repair'
  | 'Orphaned Local Queue'
  | 'Provider Failing'
  | 'Quarantined'
  | 'Retained Outbox'
  | 'Stale Import'
export type JudgmentJobProviderFailureKind =
  | 'auth'
  | 'endpoint_unavailable'
  | 'network'
  | 'other'
  | 'rate_limited'
  | 'timeout'
  | 'usage_limit'
export type JudgmentJobProviderHealth = {
  consecutiveFailureCount: number
  failureCode: string | null
  failureKind: JudgmentJobProviderFailureKind
  failureMessage: string | null
  firstFailedAt: string
  isActive: boolean
  jobId: string
  lastFailedAt: string
  lastSuccessAt: string | null
  modelId: string | null
  recoveredAt: string | null
  retryAfterAt: string | null
  status: 'failing' | 'recovered'
  totalFailureCount: number
  updatedAt: string
}
export type ProviderHealthTone = 'amber' | 'rose'
export type JobsProviderHealthBannerJob = {id: string; projectName: string; status: string | null}
export type JobsProviderHealthBannerGroup = {
  jobs: JobsProviderHealthBannerJob[]
  kind: JudgmentJobProviderFailureKind
  label: string
  lastFailedAt: string
  message: string | null
  modelId: string | null
  retryAfterAt: string | null
  tone: ProviderHealthTone
}
export type JobsProviderHealthBanner = {
  groups: JobsProviderHealthBannerGroup[]
  title: string
  tone: ProviderHealthTone
}
type ProviderHealthBannerSourceJob = {id: string; projectName?: string | null; status?: string | null}
export type JobHealthFilter =
  | 'draining'
  | 'quarantined'
  | 'orphanedLocalQueue'
  | 'retainedOutbox'
  | 'largeWal'
  | 'staleImport'
export type JudgmentsJobsData = Awaited<ReturnType<typeof fetchJudgmentsJobs>>
export type JudgmentsJobListItem = JudgmentsJobsData[number]

const activeJudgmentsJobStatuses = new Set([
  'not_started',
  'running',
  'waiting_on_db_connection',
  'waiting_on_llm_connection',
])

export const judgmentsJobsQueryKey = ['judgments-jobs'] as const
export const judgmentProviderTelemetryHistoryRanges = [
  '5m',
  '15m',
  '1h',
  '24h',
  '3d',
] as const satisfies readonly JudgmentJobProviderTelemetryHistoryRange[]

export const judgmentJobsHealthFilterLabels: Record<JobHealthFilter, string> = {
  draining: 'Draining',
  quarantined: 'Quarantined',
  orphanedLocalQueue: 'Orphaned Local Queue',
  retainedOutbox: 'Retained Outbox',
  largeWal: 'Large WAL',
  staleImport: 'Stale Import',
}
export const judgmentProviderTelemetryHistoryRangeLabels: Record<JudgmentJobProviderTelemetryHistoryRange, string> = {
  '5m': 'Last 5 minutes',
  '15m': 'Last 15 minutes',
  '1h': 'Last 1 hour',
  '24h': 'Last 24 hours',
  '3d': 'Last 3 days',
}
export const judgmentProviderTelemetryAdherenceStateLabels: Record<
  JudgmentJobProviderTelemetryHistoryBucket['adherenceState'],
  string
> = {atLimit: 'At limit', overLimit: 'Over limit', unknown: 'No samples', withinLimit: 'Within limit'}

export const getActionErrorMessage = (error: unknown, fallback: string) => {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

export const getStatusColor = (status: string | null) => {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-800'
    case 'running':
      return 'bg-blue-100 text-blue-800'
    case 'failed':
      return 'bg-red-100 text-red-800'
    case 'paused':
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

export const formatStatus = (status: string | null) => {
  if (!status) return 'Unknown'
  if (status === 'paused') return 'Paused'
  return status
    .split('_')
    .map((word) => {
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

export const formatNumber = (num: number): string => {
  return num.toLocaleString('en-US')
}

export const getHealthBadgeColor = (badge: JobHealthBadge) => {
  switch (badge) {
    case 'Healthy':
      return 'bg-green-50 text-green-700 ring-green-200'
    case 'Draining':
      return 'bg-amber-50 text-amber-700 ring-amber-200'
    case 'Quarantined':
    case 'Offline Repair':
      return 'bg-red-50 text-red-700 ring-red-200'
    case 'Provider Failing':
      return 'bg-rose-100 text-rose-800 ring-rose-300'
    case 'Orphaned Local Queue':
      return 'bg-rose-50 text-rose-700 ring-rose-200'
    case 'Retained Outbox':
      return 'bg-violet-50 text-violet-700 ring-violet-200'
    case 'Large WAL':
      return 'bg-orange-50 text-orange-700 ring-orange-200'
    case 'Stale Import':
      return 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200'
  }
}

export const isHealthyBadge = (badge: JobHealthBadge) => {
  return badge === 'Healthy'
}

export const getJudgmentsJobsRefetchInterval = (jobs: JudgmentsJobsData | undefined) => {
  return jobs?.some((job) => {
    return activeJudgmentsJobStatuses.has(job.status ?? '')
  })
    ? 30 * 1000
    : 60 * 1000
}

export const getJudgmentsJobsQuery = () => {
  return {
    queryKey: judgmentsJobsQueryKey,
    queryFn: fetchJudgmentsJobs,
    refetchInterval: (query: {state: {data?: unknown}}) => {
      const jobs = Array.isArray(query.state.data) ? (query.state.data as JudgmentsJobsData) : undefined
      return getJudgmentsJobsRefetchInterval(jobs)
    },
    refetchOnWindowFocus: true,
  }
}

export const jobMatchesHealthFilter = (job: JudgmentsJobListItem, filter: JobHealthFilter) => {
  return filter === 'draining'
    ? job.storageState === 'draining'
    : filter === 'quarantined'
      ? job.storageState === 'quarantined'
      : filter === 'orphanedLocalQueue'
        ? job.health.badges.includes('Orphaned Local Queue')
        : filter === 'retainedOutbox'
          ? job.health.badges.includes('Retained Outbox')
          : filter === 'largeWal'
            ? job.health.badges.includes('Large WAL')
            : job.health.badges.includes('Stale Import')
}

export const getJobRiskScore = (job: JudgmentsJobListItem) => {
  return (job.health.badges as JobHealthBadge[]).reduce((score, badge) => {
    return (
      score
      + (badge === 'Quarantined' || badge === 'Provider Failing'
        ? 16
        : badge === 'Draining'
          ? 8
          : badge === 'Orphaned Local Queue'
            ? 4
            : badge === 'Stale Import'
              ? 4
              : badge === 'Retained Outbox'
                ? 2
                : badge === 'Large WAL'
                  ? 1
                  : 0)
    )
  }, 0)
}

export const isRiskyJudgmentJob = (job: JudgmentsJobListItem) => {
  return getJobRiskScore(job) > 0
}

const jobsProviderHealthBannerTitle = 'LLM provider failing'
const providerFailureMessagePreviewLength = 300
const providerRecoveryNoteWindowMs = 24 * 60 * 60 * 1000
const providerFailureKindLabels: Record<JudgmentJobProviderFailureKind, string> = {
  auth: 'Authentication failed',
  endpoint_unavailable: 'Endpoint unavailable',
  network: 'Network error',
  other: 'Provider errors',
  rate_limited: 'Rate limited',
  timeout: 'Timeouts',
  usage_limit: 'Usage limit reached',
}
const providerFailureGuidance: Record<JudgmentJobProviderFailureKind, string> = {
  auth: 'Check the provider connection and its API key.',
  endpoint_unavailable: 'Check that the endpoint is running and reachable.',
  network: 'Check that the endpoint is running and reachable.',
  other: 'Retries continue with backoff. Check the provider if it persists.',
  rate_limited: 'Retries continue with backoff.',
  timeout: 'Retries continue with backoff. Check the provider if it persists.',
  usage_limit: 'Buy credits or wait for the limit to reset; the job resumes by itself once the provider accepts calls.',
}
const providerHealthToneClasses: Record<ProviderHealthTone, string> = {
  amber: 'border-amber-200 bg-amber-50 text-amber-900',
  rose: 'border-rose-200 bg-rose-50 text-rose-900',
}
const roseProviderFailureKinds = new Set<string>(['auth', 'usage_limit'])

export const getJobProviderHealth = (job: object | null | undefined): JudgmentJobProviderHealth | null => {
  return (job as {providerHealth?: JudgmentJobProviderHealth | null} | null | undefined)?.providerHealth ?? null
}

export const getProviderFailureKindLabel = (kind: JudgmentJobProviderFailureKind): string => {
  return providerFailureKindLabels[kind] ?? providerFailureKindLabels.other
}

export const getProviderHealthTone = (kind: JudgmentJobProviderFailureKind): ProviderHealthTone => {
  return roseProviderFailureKinds.has(kind) ? 'rose' : 'amber'
}

export const getProviderHealthToneClass = (tone: ProviderHealthTone): string => {
  return providerHealthToneClasses[tone]
}

export const getProviderHealthGuidance = (kind: JudgmentJobProviderFailureKind): string => {
  return providerFailureGuidance[kind] ?? providerFailureGuidance.other
}

export const formatProviderRetryAfter = (value: string | null | undefined): string | null => {
  const retryAfterAt = value ? new Date(value) : null

  return retryAfterAt && Number.isFinite(retryAfterAt.getTime())
    ? `Provider says try again at ${formatDate(retryAfterAt, 'yyyy-MM-dd HH:mm')}`
    : null
}

export const truncateProviderFailureMessage = (
  message: string,
  maxLength = providerFailureMessagePreviewLength,
): string => {
  return message.length > maxLength ? `${message.slice(0, maxLength - 1)}…` : message
}

const formatCountWithNoun = (count: number, singular: string, plural: string): string => {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`
}

export const formatProviderFailureMeta = (
  health: Pick<JudgmentJobProviderHealth, 'consecutiveFailureCount' | 'firstFailedAt' | 'lastFailedAt'>,
  formatTimestamp: (value: string) => string,
): string => {
  return `Since ${formatTimestamp(health.firstFailedAt)}, ${formatCountWithNoun(
    health.consecutiveFailureCount,
    'failed attempt',
    'failed attempts',
  )}, last at ${formatTimestamp(health.lastFailedAt)}`
}

export const isRecentProviderRecovery = (
  health: Pick<JudgmentJobProviderHealth, 'isActive' | 'recoveredAt'> | null | undefined,
  now = Date.now(),
): boolean => {
  const recoveredAtMs = health?.recoveredAt ? Date.parse(health.recoveredAt) : Number.NaN

  return (
    health?.isActive === false && Number.isFinite(recoveredAtMs) && now - recoveredAtMs <= providerRecoveryNoteWindowMs
  )
}

export const formatProviderRecoveryNote = (
  health: Pick<JudgmentJobProviderHealth, 'failureKind' | 'recoveredAt' | 'totalFailureCount'>,
  formatTimestamp: (value: string) => string,
): string => {
  return `Provider recovered at ${formatTimestamp(health.recoveredAt ?? '')} after ${formatCountWithNoun(
    health.totalFailureCount,
    'failure',
    'failures',
  )} (${getProviderFailureKindLabel(health.failureKind)})`
}

const getTimestampMs = (value: string | null | undefined): number => {
  const timestampMs = value ? Date.parse(value) : Number.NaN

  return Number.isFinite(timestampMs) ? timestampMs : 0
}

const getLaterTimestamp = (left: string | null, right: string | null): string | null => {
  return getTimestampMs(right) > getTimestampMs(left) ? right : left
}

const getProviderHealthGroupKey = (health: JudgmentJobProviderHealth): string => {
  return JSON.stringify([health.modelId, health.failureKind, health.failureMessage])
}

const toProviderHealthBannerJob = (job: ProviderHealthBannerSourceJob): JobsProviderHealthBannerJob => {
  return {id: job.id, projectName: job.projectName || 'Unknown Project', status: job.status ?? null}
}

const createProviderHealthBannerGroup = (health: JudgmentJobProviderHealth): JobsProviderHealthBannerGroup => {
  return {
    jobs: [],
    kind: health.failureKind,
    label: getProviderFailureKindLabel(health.failureKind),
    lastFailedAt: health.lastFailedAt,
    message: health.failureMessage,
    modelId: health.modelId,
    retryAfterAt: health.retryAfterAt,
    tone: getProviderHealthTone(health.failureKind),
  }
}

const addJobToProviderHealthBannerGroup = (
  group: JobsProviderHealthBannerGroup,
  job: ProviderHealthBannerSourceJob,
  health: JudgmentJobProviderHealth,
): JobsProviderHealthBannerGroup => {
  return {
    ...group,
    jobs: [...group.jobs, toProviderHealthBannerJob(job)],
    lastFailedAt: getLaterTimestamp(group.lastFailedAt, health.lastFailedAt) ?? group.lastFailedAt,
    retryAfterAt: getLaterTimestamp(group.retryAfterAt, health.retryAfterAt),
  }
}

const sortProviderHealthBannerGroupJobs = (group: JobsProviderHealthBannerGroup): JobsProviderHealthBannerGroup => {
  return {
    ...group,
    jobs: group.jobs.slice().sort((left, right) => {
      return left.projectName.localeCompare(right.projectName) || left.id.localeCompare(right.id)
    }),
  }
}

const compareProviderHealthBannerGroups = (
  left: JobsProviderHealthBannerGroup,
  right: JobsProviderHealthBannerGroup,
): number => {
  const toneDelta = Number(right.tone === 'rose') - Number(left.tone === 'rose')

  return toneDelta === 0 ? getTimestampMs(right.lastFailedAt) - getTimestampMs(left.lastFailedAt) : toneDelta
}

export const buildJobsProviderHealthBanner = (
  jobs: readonly ProviderHealthBannerSourceJob[] | null | undefined,
): JobsProviderHealthBanner | null => {
  const groupsByKey = (jobs ?? []).reduce((groups, job) => {
    const health = getJobProviderHealth(job)
    const key = health ? getProviderHealthGroupKey(health) : ''

    return health?.isActive
      ? groups.set(
          key,
          addJobToProviderHealthBannerGroup(groups.get(key) ?? createProviderHealthBannerGroup(health), job, health),
        )
      : groups
  }, new Map<string, JobsProviderHealthBannerGroup>())
  const groups = [...groupsByKey.values()]
    .map(sortProviderHealthBannerGroupJobs)
    .sort(compareProviderHealthBannerGroups)

  return groups.length === 0
    ? null
    : {
        groups,
        title: jobsProviderHealthBannerTitle,
        tone: groups.some((group) => {
          return group.tone === 'rose'
        })
          ? 'rose'
          : 'amber',
      }
}

const providerBottleneckDetails: Record<string, {description: string; label: string}> = {
  claiming: {
    description:
      'Ready prompts exist and leased live requests are below target, so local prompt or request-work backlog needs replenishment.',
    label: 'Underfed provider: claiming backlog',
  },
  completionPersistence: {
    description: 'Completed request work is waiting for durable closeout, token-use, outbox, or owner ACK persistence.',
    label: 'Completion persistence',
  },
  effectiveCapacityLimited: {
    description:
      'The provider has no effective routeable request capacity under the current allocation and endpoint preconditions.',
    label: 'Effective capacity limited',
  },
  endpointUnavailable: {
    description:
      'Claiming is held while endpoint diagnostics show no healthy route or an endpoint probe, cooldown, or misconfiguration state.',
    label: 'Endpoint unavailable: claiming held',
  },
  fallbackCapacitySaturated: {
    description: 'Request work is waiting on shared fallback capacity instead of normal provider admission.',
    label: 'Fallback capacity saturated',
  },
  noReadyWork: {
    description: 'No ready prompts are available for the current project, model, and content settings.',
    label: 'No ready work',
  },
  promptPreparation: {
    description: 'Prompts are being prepared before request admission can start live LLM calls.',
    label: 'Prompt preparation backlog',
  },
  providerAtTarget: {
    description:
      'Shared request leases reached the allocated target while physical provider capacity remains below the hard cap.',
    label: 'Provider at target',
  },
  providerSaturated: {
    description: 'Physical leased calls, including endpoint probes, reached the provider limit.',
    label: 'Provider saturated',
  },
  requestSlotWait: {
    description: 'Request attempts are waiting for provider admission, worker, Codex, or fallback request slots.',
    label: 'Request slot wait',
  },
  workerCapacitySaturated: {
    description: 'The local worker or observed worker pool is at effective request capacity.',
    label: 'Worker capacity saturated',
  },
}

const endpointProbeStateLabels: Record<string, string> = {
  cooldown: 'Cooldown',
  healthy: 'Healthy',
  misconfigured: 'Misconfigured',
  probing: 'Probe running',
}

export const formatTelemetryCount = (value: number | null | undefined): string => {
  return Number(value ?? 0).toLocaleString('en-US')
}

export const formatTelemetryRatio = (value: number | null | undefined, target: number | null | undefined): string => {
  return `${formatTelemetryCount(value)} / ${formatTelemetryCount(target)}`
}

export const formatTelemetryPercent = (value: number | null | undefined): string => {
  return value === null || value === undefined ? 'N/A' : `${value}%`
}

export const formatTelemetryUtilization = (value: number | null | undefined): string => {
  const normalizedValue = Number(value)

  return value === null || value === undefined || !Number.isFinite(normalizedValue)
    ? 'N/A'
    : `${Number.isInteger(normalizedValue) ? normalizedValue.toString() : normalizedValue.toFixed(1)}%`
}

export const formatTelemetryDuration = (value: number | null | undefined): string => {
  const totalSeconds = Math.max(Math.floor((value ?? 0) / 1000), 0)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return value === null || value === undefined ? 'N/A' : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export const formatTelemetryBoolean = (value: boolean | null | undefined): string => {
  return value === true ? 'Yes' : value === false ? 'No' : 'N/A'
}

export const formatTelemetryEnumValue = (value: string | null | undefined): string => {
  const normalized = value?.trim() ?? ''

  return normalized.length === 0
    ? 'N/A'
    : normalized
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_:]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^./, (firstCharacter) => {
          return firstCharacter.toUpperCase()
        })
}

export const getProviderBottleneckLabel = (value: string | null | undefined): string => {
  return providerBottleneckDetails[value ?? '']?.label ?? formatTelemetryEnumValue(value)
}

export const getProviderBottleneckDescription = (value: string | null | undefined): string => {
  return (
    providerBottleneckDetails[value ?? '']?.description
    ?? 'No specific bottleneck is currently classified for this provider.'
  )
}

export const getProviderTelemetryHistoryRangeLabel = (value: JudgmentJobProviderTelemetryHistoryRange): string => {
  return judgmentProviderTelemetryHistoryRangeLabels[value]
}

export const getProviderTelemetryAdherenceStateLabel = (
  value: JudgmentJobProviderTelemetryHistoryBucket['adherenceState'] | null | undefined,
): string => {
  return value === null || value === undefined
    ? judgmentProviderTelemetryAdherenceStateLabels.unknown
    : (judgmentProviderTelemetryAdherenceStateLabels[value] ?? formatTelemetryEnumValue(value))
}

export const getProviderTelemetryBottleneckSummaryLabel = (
  summary: Pick<JudgmentJobProviderTelemetryHistoryBucket, 'bottleneck' | 'bottleneckSampleCount'> | null | undefined,
): string => {
  const sampleCount = Number(summary?.bottleneckSampleCount ?? 0)

  return summary?.bottleneck && sampleCount > 0
    ? `${getProviderBottleneckLabel(summary.bottleneck)} (${formatTelemetryCount(sampleCount)} ${
        sampleCount === 1 ? 'sample' : 'samples'
      })`
    : 'No bottleneck'
}

export const getProviderTelemetryHistoryHasSamples = (
  buckets: readonly Pick<JudgmentJobProviderTelemetryHistoryBucket, 'sampleCount'>[],
): boolean => {
  return buckets.some((bucket) => {
    return bucket.sampleCount > 0
  })
}

export const getProviderTelemetryHistoryUtilizationScaleMax = (
  buckets: readonly Pick<
    JudgmentJobProviderTelemetryHistoryBucket,
    'avgUtilization' | 'maxUtilization' | 'minUtilization'
  >[],
): number => {
  const values = buckets
    .flatMap((bucket) => {
      return [bucket.avgUtilization, bucket.maxUtilization, bucket.minUtilization]
    })
    .filter((value): value is number => {
      return typeof value === 'number' && Number.isFinite(value)
    })
  const rawMax = Math.max(100, ...values)

  return Math.ceil(rawMax / 25) * 25
}

export const getEndpointProbeStateLabel = (value: string | null | undefined): string => {
  return endpointProbeStateLabels[value ?? ''] ?? formatTelemetryEnumValue(value)
}

export const getObservedAggregateTelemetryLabel = (
  source: Partial<JudgmentJobTelemetrySource> | null | undefined,
): string => {
  const completeness = source?.aggregateCompleteness ?? 'unavailable'

  return `Observed aggregates: best-effort ${completeness}`
}

export const getObservedAggregateTelemetryDescription = (
  source: Partial<JudgmentJobTelemetrySource> | null | undefined,
): string => {
  const completeness = source?.aggregateCompleteness ?? 'unavailable'

  return completeness === 'complete'
    ? 'All registered worker telemetry is currently fresh, but aggregate counts still come from worker reports rather than the lease authority.'
    : completeness === 'partial'
      ? 'Some remote worker telemetry is stale or missing, so aggregate counts are partial best-effort observations.'
      : 'Remote worker telemetry is unavailable, so aggregate counts are local best-effort observations only.'
}

export const getTelemetryCoverageSummary = (source: Partial<JudgmentJobTelemetrySource> | null | undefined): string => {
  return `fresh ${formatTelemetryCount(source?.freshWorkerCount)}, stale ${formatTelemetryCount(
    source?.staleWorkerCount,
  )}, unavailable ${formatTelemetryCount(source?.unavailableWorkerCount)}`
}

export const getAllocationStateLabel = (
  provider: Pick<JudgmentJobProviderTelemetry, 'allocationCompleteCurrent' | 'allocationInputState'> | null | undefined,
): string => {
  return provider?.allocationCompleteCurrent
    ? `Allocation current (${formatTelemetryEnumValue(provider.allocationInputState)})`
    : `Allocation incomplete (${formatTelemetryEnumValue(provider?.allocationInputState)})`
}
