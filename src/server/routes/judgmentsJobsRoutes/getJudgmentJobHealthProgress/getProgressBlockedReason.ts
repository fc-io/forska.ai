import type {JudgmentsCleanupStaleCronActivity} from '../../../cron/judgmentsJobsCronState.ts'
import type {JudgmentJobBlockedReason, JudgmentJobProgressState} from '../judgmentJobHealthTypes.ts'

const cleanupStaleBacklogPartialReasons = new Set([
  'candidate-job-budget-exhausted',
  'provider-admission-reconciliation-budget-exhausted',
  'provider-telemetry-prune-row-budget-exhausted',
])
const cleanupStaleBudgetExhaustedReasons = new Set([
  'duckdb-step-budget-exhausted',
  'repair-action-budget-exhausted',
  'sqlite-job-action-budget-exhausted',
  'sqlite-retention-batch-budget-exhausted',
  'sqlite-retention-row-budget-exhausted',
  'sqlite-row-budget-exhausted',
  'wall-clock-budget-exhausted',
])

const getCleanupStaleBlockedReason = (
  cleanupStaleActivity: JudgmentsCleanupStaleCronActivity,
): JudgmentJobBlockedReason => {
  const lastPartialReason = cleanupStaleActivity.lastPartialReason ?? ''
  const lastPartialWasBacklog = cleanupStaleBacklogPartialReasons.has(lastPartialReason)
  const lastPartialWasBudgetExhausted =
    cleanupStaleActivity.exhaustedBudget || cleanupStaleBudgetExhaustedReasons.has(lastPartialReason)

  return cleanupStaleActivity.stale || cleanupStaleActivity.overBudget
    ? 'cleanup_stale_stuck_or_over_budget'
    : lastPartialWasBacklog
      ? 'cleanup_stale_backlog'
      : lastPartialWasBudgetExhausted
        ? 'cleanup_stale_budget_exhausted'
        : cleanupStaleActivity.lastPartial
          ? 'cleanup_stale_backlog'
          : null
}

export const getProgressBlockedReason = ({
  cleanupStaleActivity,
  endpointBlockedReason,
  isStaleImport,
  progressState,
  repairRequired,
}: {
  cleanupStaleActivity: JudgmentsCleanupStaleCronActivity
  endpointBlockedReason: JudgmentJobBlockedReason
  isStaleImport: boolean
  progressState: JudgmentJobProgressState
  repairRequired: boolean
}): JudgmentJobBlockedReason => {
  const cleanupStaleBlockedReason = getCleanupStaleBlockedReason(cleanupStaleActivity)

  return repairRequired
    ? 'storage_repair_required'
    : progressState === 'waiting_for_owner_ack'
      ? 'waiting_for_owner_ack'
      : progressState === 'cooldown' && endpointBlockedReason
        ? endpointBlockedReason
        : progressState === 'blocked_import' && cleanupStaleBlockedReason
          ? cleanupStaleBlockedReason
          : progressState === 'blocked_import' && isStaleImport
            ? 'stale_import'
            : progressState === 'blocked_import'
              ? 'waiting_for_judge_worker'
              : null
}
