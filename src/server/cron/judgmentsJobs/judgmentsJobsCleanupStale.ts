import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'

const sqliteRetentionCleanupBatchSize = 100

export const judgmentsJobsCleanupStale = async (): Promise<void> => {
  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000)

  await getJudgmentJobSqliteService().reapStaleOutboxClaims({staleBefore: sixteenMinutesAgo})
  await getJudgmentJobSqliteService().pruneVisibilityAckedRetention({maxRows: sqliteRetentionCleanupBatchSize})
  await getJudgmentJobSqliteService().deleteDrainedJobs()
}
