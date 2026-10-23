import type {
  JudgmentJobBlockedReason,
  JudgmentJobImportConsumerAvailability,
  JudgmentJobProgressState,
} from '../judgmentJobHealthTypes.ts'

export const getProgressState = ({
  activeImportWorkCount,
  endpointBlockedReason,
  hasActivePrompts,
  hasImportBacklog,
  hasQueuedPrompts,
  importConsumer,
  isCompletionAckBacklog,
  isStaleImport,
  job,
  repairRequired,
}: {
  activeImportWorkCount: number
  endpointBlockedReason: JudgmentJobBlockedReason
  hasActivePrompts: boolean
  hasImportBacklog: boolean
  hasQueuedPrompts: boolean
  importConsumer: JudgmentJobImportConsumerAvailability
  isCompletionAckBacklog: boolean
  isStaleImport: boolean
  job: {status: string}
  repairRequired: boolean
}): JudgmentJobProgressState => {
  return repairRequired
    ? 'repair_required'
    : activeImportWorkCount > 0
      ? 'active_import'
      : isCompletionAckBacklog
        ? 'waiting_for_owner_ack'
        : endpointBlockedReason
          ? 'cooldown'
          : isStaleImport || (hasImportBacklog && !importConsumer.eligibleConsumerPresent)
            ? 'blocked_import'
            : hasImportBacklog || hasQueuedPrompts
              ? 'queued'
              : hasActivePrompts
                ? 'processing'
                : job.status === 'completed'
                  ? 'completed'
                  : 'idle'
}
