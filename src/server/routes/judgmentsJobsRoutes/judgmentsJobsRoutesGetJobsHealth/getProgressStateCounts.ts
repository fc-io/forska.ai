import type {JudgmentJobProgressState} from '../judgmentJobHealthTypes.ts'

export const getProgressStateCounts = (entries: Array<{progressState: JudgmentJobProgressState}>) => {
  return entries.reduce(
    (counts, entry) => {
      return entry.progressState === 'active_import'
        ? {...counts, activeImport: counts.activeImport + 1}
        : entry.progressState === 'blocked_import'
          ? {...counts, blockedImport: counts.blockedImport + 1}
          : entry.progressState === 'completed'
            ? {...counts, completed: counts.completed + 1}
            : entry.progressState === 'cooldown'
              ? {...counts, cooldown: counts.cooldown + 1}
              : entry.progressState === 'idle'
                ? {...counts, idle: counts.idle + 1}
                : entry.progressState === 'processing'
                  ? {...counts, processing: counts.processing + 1}
                  : entry.progressState === 'queued'
                    ? {...counts, queued: counts.queued + 1}
                    : entry.progressState === 'repair_required'
                      ? {...counts, repairRequired: counts.repairRequired + 1}
                      : {...counts, waitingForOwnerAck: counts.waitingForOwnerAck + 1}
    },
    {
      activeImport: 0,
      blockedImport: 0,
      completed: 0,
      cooldown: 0,
      idle: 0,
      processing: 0,
      queued: 0,
      repairRequired: 0,
      waitingForOwnerAck: 0,
    },
  )
}
