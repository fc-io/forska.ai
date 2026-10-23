import type {SystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {getJudgmentEndpointAvailabilityDiagnostics} from '../../cron/judgmentsJobs/judgmentEndpointAvailability.ts'
import type {JudgmentJobSqliteHealthSnapshotForProjection} from '../../services/judgmentJobSqliteHealthProjectionService.ts'

export type JudgmentJobSqliteHealthSnapshot = JudgmentJobSqliteHealthSnapshotForProjection & {
  healthProjection?: {freshUntilAt: Date; projectedAt: Date; projectedBy: string | null; source: string}
}
export type JudgmentJobHealthAction =
  | 'none'
  | 'repair_offline_required'
  | 'repair_missing_sqlite'
  | 'repair_orphaned_queue'
  | 'wait_for_drain'
  | 'repair_quarantine'
  | 'resume_outbox_import'
  | 'retry_stale_import'
export type JudgmentJobBlockedReason =
  | 'cleanup_stale_backlog'
  | 'cleanup_stale_budget_exhausted'
  | 'cleanup_stale_stuck_or_over_budget'
  | 'endpoint_circuit_breaker'
  | 'endpoint_cooldown'
  | 'endpoint_misconfigured'
  | 'stale_import'
  | 'storage_repair_required'
  | 'waiting_for_judge_worker'
  | 'waiting_for_owner_ack'
  | null
export type JudgmentJobProgressState =
  | 'active_import'
  | 'blocked_import'
  | 'completed'
  | 'cooldown'
  | 'idle'
  | 'processing'
  | 'queued'
  | 'repair_required'
  | 'waiting_for_owner_ack'
export type JudgmentJobWorkIdentity = {
  fullTextStrategyId: string
  modelId: string
  projectId: string
  systemPromptVariant: SystemPromptVariant
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  useTitle: boolean
}
export type JudgmentJobImportConsumerAvailability = {
  eligibleConsumerCount: number
  eligibleConsumerPresent: boolean
  freshConsumerCount: number
  freshConsumerPresent: boolean
  registeredConsumerCount: number
  requiredConsumerRole: 'judge-worker'
  staleConsumerCount: number
}
export type JudgmentJobImportWorkLease = {
  consumerId: string | null
  freshUntilAt: string | null
  lastProgressedAt: string | null
  lastStartedAt: string | null
  recoveryContext: Record<string, unknown> | null
  recoveryMode: 'archived_project_mart_recovery' | 'none' | 'retry_backoff'
  retryAfterAt: string | null
}
export type JudgmentJobEndpointHealth = {
  diagnostics:
    | (ReturnType<typeof getJudgmentEndpointAvailabilityDiagnostics> & {
        effectiveBaseURL: string | null
        endpointAvailabilityKey: string
        endpointIdentity: string | null
        localProbeState: string
        providerKey: string
      })
    | null
  providerDiagnostics: {
    endpointDiagnosticsByKey: Record<
      string,
      ReturnType<typeof getJudgmentEndpointAvailabilityDiagnostics> & {
        effectiveBaseURL: string | null
        endpointAvailabilityKey: string
        endpointIdentity: string | null
        localProbeState: string
        providerKey: string
      }
    >
    endpointDiagnosticsSummary: {
      blockedEndpointCount: number
      cooldownEndpointCount: number
      endpointCount: number
      hasHealthyEndpointOrEndpointlessPath: boolean
      healthyEndpointCount: number
      localProbeLiveCount: number
      misconfiguredEndpointCount: number
      observedAggregateProbeLiveCount: number | null
      probeInProgress: boolean
      providerKey: string
      probingEndpointCount: number
      unhealthyEndpointCount: number
    }
    providerKey: string
  }
  retryAfterAt: string | null
}
