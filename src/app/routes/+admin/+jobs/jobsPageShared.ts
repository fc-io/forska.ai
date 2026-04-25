import {fetchJudgmentsJobs} from '../../../../services/judgmentsJobsService'

export type JobHealthBadge =
  | 'Healthy'
  | 'Draining'
  | 'Large WAL'
  | 'Orphaned Local Queue'
  | 'Quarantined'
  | 'Retained Outbox'
  | 'Stale Import'
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

export const judgmentJobsHealthFilterLabels: Record<JobHealthFilter, string> = {
  draining: 'Draining',
  quarantined: 'Quarantined',
  orphanedLocalQueue: 'Orphaned Local Queue',
  retainedOutbox: 'Retained Outbox',
  largeWal: 'Large WAL',
  staleImport: 'Stale Import',
}

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
      return 'bg-red-50 text-red-700 ring-red-200'
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
  return job.health.badges.reduce((score, badge) => {
    return (
      score
      + (badge === 'Quarantined'
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
