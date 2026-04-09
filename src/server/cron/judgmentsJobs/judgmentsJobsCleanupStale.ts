import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getJudgmentJobSqliteJobIds} from './judgmentJobPaths.ts'
import {runJudgmentJobRepairAction} from './judgmentJobRepair.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'

const sqliteRetentionCleanupBatchSize = 100

const getAutomaticOrphanRepairCandidateJobIds = async () => {
  const sqliteJobIds = getJudgmentJobSqliteJobIds()

  return sqliteJobIds.length === 0
    ? []
    : (
        await getAppDatabaseService().queryJson<{id: string}>(`
          SELECT id
          FROM app.judgment_job
          WHERE id IN (${getQuotedStringList(sqliteJobIds).join(', ')})
            AND storage_state = ${getSqlLiteral('draining')}
        `)
      ).map((row) => {
        return row.id
      })
}

const repairOrphanedDrainingJobs = async (jobIds: string[]): Promise<void> => {
  const [currentJobId = ''] = jobIds
  const sqliteService = getJudgmentJobSqliteService()

  if (!currentJobId) {
    return
  }

  const healthSnapshot = await sqliteService.getHealthSnapshot(currentJobId)

  if (healthSnapshot.orphanedJudgedRowCount > 0) {
    await runJudgmentJobRepairAction({
      action: 'repair',
      claimedBy: getDefaultJudgmentServerJobId(),
      jobId: currentJobId,
    })
  }

  return repairOrphanedDrainingJobs(jobIds.slice(1))
}

export const judgmentsJobsCleanupStale = async (): Promise<void> => {
  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000)
  const sqliteService = getJudgmentJobSqliteService()

  await sqliteService.reapStaleOutboxClaims({staleBefore: sixteenMinutesAgo})
  await sqliteService.pruneVisibilityAckedRetention({maxRows: sqliteRetentionCleanupBatchSize})
  await repairOrphanedDrainingJobs(await getAutomaticOrphanRepairCandidateJobIds())
  await sqliteService.finalizeDrainingJobs()
  await sqliteService.deleteDrainedJobs()
}
