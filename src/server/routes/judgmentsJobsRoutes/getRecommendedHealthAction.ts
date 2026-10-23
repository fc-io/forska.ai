import type {JudgmentJobHealthAction, JudgmentJobSqliteHealthSnapshot} from './judgmentJobHealthTypes.ts'
import {
  getStoragePolicy,
  hasOrphanedJudgedQueue,
  hasRetainedOutbox,
  isStaleImportJob,
} from './judgmentJobStorageHealth.ts'

export const getRecommendedHealthAction = ({
  job,
  sqliteHealth,
}: {
  job: {status: string; storageState: string; lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null}
  sqliteHealth: JudgmentJobSqliteHealthSnapshot
}): JudgmentJobHealthAction => {
  const storagePolicy = getStoragePolicy({job, sqliteHealth})

  if (storagePolicy.repairMode === 'offline_repair_required') {
    return 'repair_offline_required'
  }

  if (job.storageState === 'quarantined') {
    return 'repair_quarantine'
  }

  if (job.storageState === 'missing') {
    return 'repair_missing_sqlite'
  }

  if (isStaleImportJob(job)) {
    return 'retry_stale_import'
  }

  if (hasOrphanedJudgedQueue(sqliteHealth)) {
    return 'repair_orphaned_queue'
  }

  if (job.storageState === 'draining') {
    return 'wait_for_drain'
  }

  if (hasRetainedOutbox(sqliteHealth)) {
    return 'resume_outbox_import'
  }

  return 'none'
}
