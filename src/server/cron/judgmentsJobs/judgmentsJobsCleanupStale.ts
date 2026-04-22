import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getJudgeWorkerReadOnlyAppDatabaseService} from '../../services/appReadOnlyDatabaseService.ts'
import {getJudgmentJobSqliteJobIds} from './judgmentJobPaths.ts'
import {runJudgmentJobRepairAction} from './judgmentJobRepair.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {getJudgmentJobSqliteService, JudgmentJobLeaseError} from './judgmentJobSqliteService.ts'
import {abandonedSentPromptGraceMs} from './requeueAbandonedSentPrompts.ts'

const sqliteRetentionCleanupBatchSize = 100

const getDrainingSqliteJobIds = async () => {
  const sqliteJobIds = getJudgmentJobSqliteJobIds()

  return sqliteJobIds.length === 0
    ? []
    : (
        await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<{id: string}>(`
          SELECT id
          FROM app.judgment_job
          WHERE id IN (${getQuotedStringList(sqliteJobIds).join(', ')})
            AND storage_state = ${getSqlLiteral('draining')}
        `)
      ).map((row) => {
        return row.id
      })
}

const recoverDrainingQueueRows = async ({
  jobIds,
  serverJobId,
}: {
  jobIds: string[]
  serverJobId: string
}): Promise<void> => {
  const [currentJobId = ''] = jobIds
  const sqliteService = getJudgmentJobSqliteService()

  if (!currentJobId) {
    return
  }

  try {
    await sqliteService.ensureOwnedLease(currentJobId, serverJobId)
    await sqliteService.requeueAbandonedSentPrompts({
      jobId: currentJobId,
      serverJobId,
      staleBefore: new Date(Date.now() - abandonedSentPromptGraceMs),
    })
    await sqliteService.clearActiveQueue(currentJobId)
  } catch (error) {
    if (!(error instanceof JudgmentJobLeaseError)) {
      throw error
    }
  }

  return recoverDrainingQueueRows({jobIds: jobIds.slice(1), serverJobId})
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
  const serverJobId = getDefaultJudgmentServerJobId()
  const sqliteService = getJudgmentJobSqliteService()
  const drainingJobIds = await getDrainingSqliteJobIds()

  await sqliteService.reapStaleOutboxClaims({staleBefore: sixteenMinutesAgo})
  await recoverDrainingQueueRows({jobIds: drainingJobIds, serverJobId})
  await sqliteService.pruneVisibilityAckedRetention({maxRows: sqliteRetentionCleanupBatchSize})
  await repairOrphanedDrainingJobs(drainingJobIds)
  await sqliteService.finalizeDrainingJobs()
  await sqliteService.deleteDrainedJobs()
}
