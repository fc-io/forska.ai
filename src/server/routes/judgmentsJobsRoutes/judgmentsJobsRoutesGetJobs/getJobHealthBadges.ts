import {
  isJudgmentJobProviderHealthActiveForJob,
  type JudgmentJobProviderHealth,
} from '../../../services/judgmentJobProviderHealthService.ts'
import type {JudgmentJobSqliteHealthSnapshot} from '../judgmentJobHealthTypes.ts'
import {
  getStoragePolicy,
  hasOrphanedJudgedQueue,
  hasRetainedOutbox,
  isStaleImportJob,
} from '../judgmentJobStorageHealth.ts'

type JudgmentJobHealthBadge =
  | 'Healthy'
  | 'Draining'
  | 'Large WAL'
  | 'Offline Repair'
  | 'Orphaned Local Queue'
  | 'Provider Failing'
  | 'Quarantined'
  | 'Retained Outbox'
  | 'Stale Import'
const largeWalThresholdBytes = 64 * 1_024 * 1_024

const hasLargeWal = (sqliteHealth: JudgmentJobSqliteHealthSnapshot) => {
  return sqliteHealth.walBytes >= largeWalThresholdBytes
}

export const getJobHealthBadges = ({
  job,
  providerHealth,
  sqliteHealth,
}: {
  job: {status: string; storageState: string; lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null}
  providerHealth: JudgmentJobProviderHealth | null
  sqliteHealth: JudgmentJobSqliteHealthSnapshot
}): JudgmentJobHealthBadge[] => {
  const badges: JudgmentJobHealthBadge[] = []
  const storagePolicy = getStoragePolicy({job, sqliteHealth})

  if (storagePolicy.repairMode === 'offline_repair_required') {
    badges.push('Offline Repair')
  }

  if (providerHealth && isJudgmentJobProviderHealthActiveForJob({health: providerHealth, jobStatus: job.status})) {
    badges.push('Provider Failing')
  }

  if (job.storageState === 'quarantined') {
    badges.push('Quarantined')
  }

  if (job.storageState === 'draining') {
    badges.push('Draining')
  }

  if (isStaleImportJob(job)) {
    badges.push('Stale Import')
  }

  if (hasOrphanedJudgedQueue(sqliteHealth)) {
    badges.push('Orphaned Local Queue')
  }

  if (hasRetainedOutbox(sqliteHealth)) {
    badges.push('Retained Outbox')
  }

  if (hasLargeWal(sqliteHealth)) {
    badges.push('Large WAL')
  }

  return badges.length > 0 ? badges : ['Healthy']
}
