import {runJudgmentJobRepairAction} from '../../cron/judgmentsJobs/judgmentJobRepair.ts'
import {
  isJudgmentJobSqliteIsolatedImportLeaseConflict,
  runJudgmentJobSqliteIsolatedFlush,
} from '../../cron/judgmentsJobs/judgmentJobSqliteIsolatedImport.ts'
import {flushJudgmentJobSqliteOutbox} from '../../cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts'
import {assertJudgmentJobCanRunSqlitePreflight} from '../../cron/judgmentsJobs/judgmentJobSqlitePreflight.ts'
import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {isTransientJudgmentJobSqliteLockMessage} from '../../cron/judgmentsJobs/judgmentJobSqliteTransientLock.ts'
import {getJudgmentJobMutationState} from '../../cron/judgmentsJobs/judgmentJobStatusMutation.ts'
import {getJudgmentJobRepairMode} from '../../cron/judgmentsJobs/judgmentJobStoragePolicy.ts'
import {assertStoredProviderModelRuntimeMatch} from '../../providers/providerRuntimeModelGuard.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {assertModelContextWindowResolvable} from '../../services/judgmentJobModelContextWindow.ts'
import {HttpError} from '../../utils/httpError.ts'
import {assertJudgmentJobStopConditionsAllowResume} from './assertJudgmentJobStopConditionsAllowResume.ts'
import {assertProjectFullTextCanJudge} from './assertProjectFullTextCanJudge.ts'
import {getJobContext} from './getJobContext.ts'
import {getJudgmentJobMutationResponse} from './getJudgmentJobMutationResponse.ts'
import {assertJudgingRuntimeCanRun} from './judgingRuntime.ts'
import {judgmentJobServerId} from './judgmentJobServerId.ts'

const resetJudgmentJobLocalSqliteState = async ({jobId, storageState}: {jobId: string; storageState: string}) => {
  const sqliteService = getJudgmentJobSqliteService()

  if (!sqliteService.hasJob(jobId)) {
    return
  }

  const shouldUseCrashContainedDeleteFlush =
    getJudgmentJobRepairMode({hasLocalSqliteState: true, job: {status: 'failed', storageState}})
    === 'offline_repair_required'

  if (shouldUseCrashContainedDeleteFlush) {
    const flushResult = await runJudgmentJobSqliteIsolatedFlush({claimedBy: judgmentJobServerId, jobId})

    if (flushResult.errorMessage !== null) {
      if (
        !isJudgmentJobSqliteIsolatedImportLeaseConflict(flushResult.errorMessage)
        && !isTransientJudgmentJobSqliteLockMessage(flushResult.errorMessage)
      ) {
        await runJudgmentJobRepairAction({action: 'quarantine', jobId, reason: flushResult.errorMessage})
      }

      throw new HttpError(
        409,
        `Start Job Clean stopped safely for ${jobId}: ${flushResult.errorMessage} Local SQLite data was left in place.`,
      )
    }
  } else {
    await flushJudgmentJobSqliteOutbox({claimedBy: judgmentJobServerId, jobId})
  }

  await sqliteService.deleteJob(jobId)
}

export const judgmentsJobsRoutesPostStartClean = async ({params}: {params: {id: string}}) => {
  await assertJudgingRuntimeCanRun()

  const sqliteService = getJudgmentJobSqliteService()
  const {job, projectFullTextStrategyId, projectModelId} = await getJobContext({jobId: params.id})

  if (job.status === 'running') {
    throw new HttpError(409, `Pause job ${params.id} before starting it clean.`)
  }

  await assertJudgmentJobStopConditionsAllowResume({jobId: params.id, update: {}})
  await assertStoredProviderModelRuntimeMatch({modelId: projectModelId})
  await assertModelContextWindowResolvable(projectModelId)
  await assertProjectFullTextCanJudge(job.projectId)
  await resetJudgmentJobLocalSqliteState({jobId: params.id, storageState: job.storageState})
  await sqliteService.initializeJob(params.id)
  await assertJudgmentJobCanRunSqlitePreflight({jobId: params.id, quarantineReason: null, storageState: 'active'})

  const updatedJob = await getAppDatabaseService().transaction(async (tx) => {
    await tx.run(`
          UPDATE app.judgment_job
          SET status = 'running',
              full_text_strategy_id = ${getSqlLiteral(projectFullTextStrategyId)},
              error = NULL,
              storage_state = 'active',
              pause_requested_at = NULL,
              quarantined_at = NULL,
              quarantine_reason = NULL,
              stop_reason = NULL,
              stop_reason_at = NULL,
              updated_at = current_timestamp
          WHERE id = '${escapeSqlString(params.id)}'
        `)

    return getJudgmentJobMutationState(tx, params.id)
  })

  if (!updatedJob) {
    throw new Error('Job not found')
  }

  return {data: getJudgmentJobMutationResponse(updatedJob), error: null}
}
