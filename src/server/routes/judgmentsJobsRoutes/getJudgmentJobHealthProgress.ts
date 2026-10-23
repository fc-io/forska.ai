import {getCronRuntimeDiagnostics} from '../../cron/cronRuntimeState.ts'
import {getIsoDateString} from './getIsoDateString.ts'
import {getProgressBlockedReason} from './getJudgmentJobHealthProgress/getProgressBlockedReason.ts'
import {getProgressState} from './getJudgmentJobHealthProgress/getProgressState.ts'
import type {
  JudgmentJobBlockedReason,
  JudgmentJobEndpointHealth,
  JudgmentJobHealthAction,
  JudgmentJobImportConsumerAvailability,
  JudgmentJobImportWorkLease,
  JudgmentJobProgressState,
  JudgmentJobSqliteHealthSnapshot,
  JudgmentJobWorkIdentity,
} from './judgmentJobHealthTypes.ts'
import {isStaleImportJob} from './judgmentJobStorageHealth.ts'

type JudgmentJobHealthProgress = {
  activeConsumerCount: number
  activeImportWorkCount: number
  blockedReason: JudgmentJobBlockedReason
  importBacklogCount: number
  importConsumer: JudgmentJobImportConsumerAvailability
  importWork: {
    activeConsumerCount: number
    activeWorkCount: number
    claimedOutboxCount: number
    hasBacklog: boolean
    outboxRowCount: number
    pendingCompletionAckCount: number
    workIdentity: JudgmentJobWorkIdentity
  }
  lastProgressedAt: string | null
  lastStartedAt: string | null
  progressState: JudgmentJobProgressState
  recoveryContext: Record<string, unknown> | null
  recoveryMode: 'archived_project_mart_recovery' | 'none' | 'retry_backoff'
  retryAfterAt: string | null
  runningWork: {
    activePromptCount: number
    claimedPromptCount: number
    judgedPromptCount: number
    readyPromptCount: number
    runningPromptCount: number
    skippedPromptCount: number
    workIdentity: JudgmentJobWorkIdentity
  }
  workIdentity: JudgmentJobWorkIdentity
}

const getFreshImportWorkLeases = (leases: JudgmentJobImportWorkLease[], now: Date) => {
  return leases.filter((lease) => {
    const freshUntilAt = lease.freshUntilAt ? new Date(lease.freshUntilAt).getTime() : null
    return freshUntilAt !== null && freshUntilAt > now.getTime()
  })
}

const getImportRecoveryWorkLease = (
  leases: JudgmentJobImportWorkLease[],
  now: Date,
): JudgmentJobImportWorkLease | null => {
  return (
    leases.find((lease) => {
      const retryAfterAt = lease.retryAfterAt ? new Date(lease.retryAfterAt).getTime() : null
      return lease.recoveryMode !== 'none' || (retryAfterAt !== null && retryAfterAt > now.getTime())
    }) ?? null
  )
}

const getUniqueStringCount = (values: Array<string | null>) => {
  return new Set(
    values.filter((value): value is string => {
      return value !== null && value !== ''
    }),
  ).size
}

const getEndpointBlockedReason = (endpointHealth: JudgmentJobEndpointHealth): JudgmentJobBlockedReason => {
  const diagnostics = endpointHealth.diagnostics
  const failureMessage = diagnostics?.lastFailureMessage?.toLowerCase() ?? ''

  return !diagnostics || diagnostics.status === 'healthy' || diagnostics.status === 'probing'
    ? null
    : diagnostics.status === 'misconfigured'
      ? 'endpoint_misconfigured'
      : diagnostics.lastFailureKind === 'circuit_open' || failureMessage.includes('circuit breaker')
        ? 'endpoint_circuit_breaker'
        : 'endpoint_cooldown'
}

const isRepairRequiredAction = (action: JudgmentJobHealthAction) => {
  return (
    action === 'repair_offline_required'
    || action === 'repair_missing_sqlite'
    || action === 'repair_orphaned_queue'
    || action === 'repair_quarantine'
  )
}

export const getJudgmentJobHealthProgress = ({
  endpointHealth,
  importConsumer,
  importWorkLeases,
  job,
  now,
  recommendedNextAction,
  sqliteHealth,
  workIdentity,
}: {
  endpointHealth: JudgmentJobEndpointHealth
  importConsumer: JudgmentJobImportConsumerAvailability
  importWorkLeases: JudgmentJobImportWorkLease[]
  job: {
    lastImportCompletedAt: Date | null
    lastImportErrorAt: Date | null
    lastImportStartedAt: Date | null
    status: string
  }
  now: Date
  recommendedNextAction: JudgmentJobHealthAction
  sqliteHealth: JudgmentJobSqliteHealthSnapshot
  workIdentity: JudgmentJobWorkIdentity
}): JudgmentJobHealthProgress => {
  const activeImportLeases = getFreshImportWorkLeases(importWorkLeases, now)
  const recoveryLease = getImportRecoveryWorkLease(importWorkLeases, now)
  const activeConsumerCount = getUniqueStringCount(
    activeImportLeases.map((lease) => {
      return lease.consumerId
    }),
  )
  const importBacklogCount = sqliteHealth.outboxRowCount + sqliteHealth.claimedOutboxCount
  const activePromptCount = sqliteHealth.promptCounts.claimed + sqliteHealth.promptCounts.running
  const endpointBlockedReason = getEndpointBlockedReason(endpointHealth)
  const repairRequired = isRepairRequiredAction(recommendedNextAction)
  const cleanupStaleActivity = getCronRuntimeDiagnostics().cleanupStaleActivity
  const progressState = getProgressState({
    activeImportWorkCount: activeImportLeases.length,
    endpointBlockedReason,
    hasActivePrompts: activePromptCount > 0,
    hasImportBacklog: importBacklogCount > 0,
    hasQueuedPrompts: sqliteHealth.promptCounts.ready > 0 || sqliteHealth.hasQueueRows,
    importConsumer,
    isCompletionAckBacklog: sqliteHealth.hasPendingCompletionAck,
    isStaleImport: isStaleImportJob(job),
    job,
    repairRequired,
  })
  const blockedReason = getProgressBlockedReason({
    cleanupStaleActivity,
    endpointBlockedReason,
    isStaleImport: isStaleImportJob(job),
    progressState,
    repairRequired,
  })
  const recoveryMode =
    recoveryLease?.recoveryMode ?? (endpointBlockedReason ? ('retry_backoff' as const) : ('none' as const))

  return {
    activeConsumerCount,
    activeImportWorkCount: activeImportLeases.length,
    blockedReason,
    importBacklogCount,
    importConsumer,
    importWork: {
      activeConsumerCount,
      activeWorkCount: activeImportLeases.length,
      claimedOutboxCount: sqliteHealth.claimedOutboxCount,
      hasBacklog: importBacklogCount > 0,
      outboxRowCount: sqliteHealth.outboxRowCount,
      pendingCompletionAckCount: sqliteHealth.pendingCompletionAckCount,
      workIdentity,
    },
    lastProgressedAt:
      activeImportLeases[0]?.lastProgressedAt
      ?? recoveryLease?.lastProgressedAt
      ?? getIsoDateString(job.lastImportCompletedAt)
      ?? getIsoDateString(job.lastImportErrorAt),
    lastStartedAt:
      activeImportLeases[0]?.lastStartedAt ?? recoveryLease?.lastStartedAt ?? getIsoDateString(job.lastImportStartedAt),
    progressState,
    recoveryContext: recoveryLease?.recoveryContext ?? null,
    recoveryMode,
    retryAfterAt: recoveryLease?.retryAfterAt ?? endpointHealth.retryAfterAt,
    runningWork: {
      activePromptCount,
      claimedPromptCount: sqliteHealth.promptCounts.claimed,
      judgedPromptCount: sqliteHealth.promptCounts.judged,
      readyPromptCount: sqliteHealth.promptCounts.ready,
      runningPromptCount: sqliteHealth.promptCounts.running,
      skippedPromptCount: sqliteHealth.promptCounts.skipped,
      workIdentity,
    },
    workIdentity,
  }
}
