import {runJudgmentJobRepairAction} from '../../cron/judgmentsJobs/judgmentJobRepair.ts'
import {
  isJudgmentJobSqliteIsolatedImportLeaseConflict,
  runJudgmentJobSqliteIsolatedFlush,
} from '../../cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.ts'
import {flushJudgmentJobSqliteOutbox} from '../../cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts'
import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {isTransientJudgmentJobSqliteLockMessage} from '../../cron/judgmentsJobs/judgmentJobSqliteTransientLock.ts'
import {getJudgmentJobRepairMode} from '../../cron/judgmentsJobs/judgmentJobStoragePolicy.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {
  deleteJudgmentJobSafelyTx,
  deletePendingJudgmentJobSqliteState,
  markJudgmentJobSqliteDeletePendingTx,
  retryPendingJudgmentJobSqliteDeletes,
} from '../../services/judgmentJobDeleteService.ts'
import {HttpError} from '../../utils/httpError.ts'
import {judgmentJobServerId} from './judgmentJobServerId.ts'

export const judgmentsJobsRoutesDeleteJob = async ({params}: {params: {id: string}}) => {
  const sqliteService = getJudgmentJobSqliteService()

  await retryPendingJudgmentJobSqliteDeletes({sqliteService})

  const [existingJob] = await getAppDatabaseService().queryJson<{
    id: string
    quarantineReason: string | null
    storageState: string
  }>(`
        SELECT id
             , storage_state AS storageState
             , quarantine_reason AS quarantineReason
        FROM app.judgment_job
        WHERE id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `)

  if (!existingJob) {
    throw new Error('Job not found')
  }

  const shouldUseCrashContainedDeleteFlush =
    getJudgmentJobRepairMode({
      hasLocalSqliteState: sqliteService.hasJob(params.id),
      job: {status: 'failed', storageState: existingJob.storageState},
    }) === 'offline_repair_required'

  if (shouldUseCrashContainedDeleteFlush) {
    const flushResult = await runJudgmentJobSqliteIsolatedFlush({claimedBy: judgmentJobServerId, jobId: params.id})

    if (flushResult.errorMessage !== null) {
      if (
        !isJudgmentJobSqliteIsolatedImportLeaseConflict(flushResult.errorMessage)
        && !isTransientJudgmentJobSqliteLockMessage(flushResult.errorMessage)
      ) {
        await runJudgmentJobRepairAction({action: 'quarantine', jobId: params.id, reason: flushResult.errorMessage})
      }

      throw new HttpError(
        409,
        `Delete Job stopped safely for ${params.id}: ${flushResult.errorMessage} Local SQLite data was left in place.`,
      )
    }
  }

  if (sqliteService.hasJob(params.id) && !shouldUseCrashContainedDeleteFlush) {
    await flushJudgmentJobSqliteOutbox({claimedBy: judgmentJobServerId, jobId: params.id})
  }

  await getAppDatabaseService().transaction(async (tx) => {
    await markJudgmentJobSqliteDeletePendingTx({jobId: params.id, tx})
    await deleteJudgmentJobSafelyTx({jobId: params.id, tx})
  })

  const localCleanup = await deletePendingJudgmentJobSqliteState({jobId: params.id, sqliteService})

  return {data: {jobId: existingJob.id, ...localCleanup}, error: null}
}
