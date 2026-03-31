import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'

const sqliteRetentionCleanupBatchSize = 100

export const judgmentsJobsCleanupStale = async (): Promise<void> => {
  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000)
  const sqliteService = getJudgmentJobSqliteService()

  await sqliteService.reapStaleOutboxClaims({staleBefore: sixteenMinutesAgo})
  await sqliteService.pruneVisibilityAckedRetention({maxRows: sqliteRetentionCleanupBatchSize})
  await sqliteService.finalizeDrainingJobs()
  await sqliteService.deleteDrainedJobs()
}
