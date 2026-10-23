import {
  getJudgmentJobRepairMode,
  getJudgmentJobStartupHandling,
  hasJudgmentJobLocalSqliteState,
} from '../../cron/judgmentsJobs/judgmentJobStoragePolicy.ts'
import type {JudgmentJobSqliteHealthSnapshot} from './judgmentJobHealthTypes.ts'

const staleImportThresholdMs = 15 * 60 * 1_000

const isImportInFlight = (job: {lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null}) => {
  const startedAt = job.lastImportStartedAt
  const completedAt = job.lastImportCompletedAt

  return Boolean(startedAt && (!completedAt || completedAt < startedAt))
}

export const isStaleImportJob = (
  job: {lastImportCompletedAt: Date | null; lastImportStartedAt: Date | null},
  now = Date.now(),
) => {
  const startedAt = job.lastImportStartedAt

  return Boolean(startedAt && isImportInFlight(job) && now - startedAt.getTime() >= staleImportThresholdMs)
}

export const hasRetainedOutbox = (sqliteHealth: JudgmentJobSqliteHealthSnapshot) => {
  return sqliteHealth.outboxRowCount > 0 || sqliteHealth.claimedOutboxCount > 0
}

export const hasOrphanedJudgedQueue = (sqliteHealth: JudgmentJobSqliteHealthSnapshot) => {
  return sqliteHealth.orphanedJudgedRowCount > 0
}

export const getStoragePolicy = ({
  job,
  sqliteHealth,
}: {
  job: {status: string; storageState: string}
  sqliteHealth: JudgmentJobSqliteHealthSnapshot
}) => {
  const hasLocalSqliteState = hasJudgmentJobLocalSqliteState(sqliteHealth)

  return {
    hasLocalSqliteState,
    repairMode: getJudgmentJobRepairMode({hasLocalSqliteState, job}),
    startupHandling: getJudgmentJobStartupHandling({hasLocalSqliteState, job}),
  }
}
