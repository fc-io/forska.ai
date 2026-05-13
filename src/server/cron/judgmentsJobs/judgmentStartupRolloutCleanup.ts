import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {backfillRequestAttemptCloseoutsOnStartup} from '../../services/requestAttemptCloseoutService.ts'
import {flushJudgmentJobSqliteOutbox} from './judgmentJobSqliteOutboxImport.ts'
import {getJudgmentJobSqliteService, JudgmentJobLeaseError} from './judgmentJobSqliteService.ts'
import {judgmentJobAutoDrainStatuses} from './judgmentJobStoragePolicy.ts'
import {
  addLegacyEvidenceRepairResults,
  getLegacyRepairReason,
  type LegacyEvidenceRepairResult,
  repairLegacyTokenUseEvidenceForJob,
} from './judgmentLegacyEvidenceRepair.ts'
import {reconcileProviderAdmissionLeasesForDurableCloseout} from './judgmentsJobsCleanupStale.ts'

type RolloutCleanupJobRow = {id: string; status: string; storageState: string}

export type JudgmentStartupRolloutCleanupResult = {
  discardedRuntimeRows: number
  drainingJobCount: number
  failedJobCount: number
  importedOutboxRows: number
  jobCount: number
}

const rolloutDiscardError = 'robustSendRolloutDiscarded'

const emptyRolloutCleanupResult = (): JudgmentStartupRolloutCleanupResult => {
  return {discardedRuntimeRows: 0, drainingJobCount: 0, failedJobCount: 0, importedOutboxRows: 0, jobCount: 0}
}

const addRolloutCleanupResults = (
  left: JudgmentStartupRolloutCleanupResult,
  right: JudgmentStartupRolloutCleanupResult,
): JudgmentStartupRolloutCleanupResult => {
  return {
    discardedRuntimeRows: left.discardedRuntimeRows + right.discardedRuntimeRows,
    drainingJobCount: left.drainingJobCount + right.drainingJobCount,
    failedJobCount: left.failedJobCount + right.failedJobCount,
    importedOutboxRows: left.importedOutboxRows + right.importedOutboxRows,
    jobCount: left.jobCount + right.jobCount,
  }
}

const getStartupRolloutJobRows = async (): Promise<RolloutCleanupJobRow[]> => {
  const sqliteJobIds = getJudgmentJobSqliteService().listJobIds()

  return sqliteJobIds.length === 0
    ? []
    : getAppDatabaseService().queryJson<RolloutCleanupJobRow>(`
        SELECT
          id,
          status,
          storage_state AS storageState
        FROM app.judgment_job
        WHERE id IN (${getQuotedStringList(sqliteJobIds).join(', ')})
          AND storage_state = 'active'
          AND status IN (${getQuotedStringList([...judgmentJobAutoDrainStatuses]).join(', ')})
        ORDER BY updated_at ASC NULLS FIRST, id ASC
      `)
}

const jobHasPreservedLocalCompletionEvidence = async (jobId: string): Promise<boolean> => {
  const health = await getJudgmentJobSqliteService().getHealthSnapshot(jobId)

  return (
    health.outboxRowCount > 0
    || health.claimedOutboxCount > 0
    || health.orphanedJudgedRowCount > 0
    || health.pendingCompletionAckCount > 0
  )
}

const markRolloutJobDraining = async (jobId: string): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET status = CASE WHEN status = 'running' THEN 'paused' ELSE status END,
        storage_state = 'draining',
        pause_requested_at = current_timestamp,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
      AND storage_state = 'active'
  `)
}

const markRolloutJobFailed = async (jobId: string): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET status = 'failed',
        storage_state = 'active',
        error = ${getSqlLiteral([rolloutDiscardError])},
        pause_requested_at = NULL,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
      AND storage_state = 'active'
  `)
}

const assignRolloutJobState = async ({
  jobId,
  legacyRepair,
}: {
  jobId: string
  legacyRepair: LegacyEvidenceRepairResult
}): Promise<{drainingJobCount: number; failedJobCount: number}> => {
  const hasPreservedEvidence = await jobHasPreservedLocalCompletionEvidence(jobId)
  const hasLegacyRepairEvidence = getLegacyRepairReason(legacyRepair) !== null

  if (hasPreservedEvidence || hasLegacyRepairEvidence) {
    await markRolloutJobDraining(jobId)
    return {drainingJobCount: 1, failedJobCount: 0}
  }

  await markRolloutJobFailed(jobId)
  return {drainingJobCount: 0, failedJobCount: 1}
}

const flushPreservedLocalOutbox = async ({claimedBy, jobId}: {claimedBy: string; jobId: string}): Promise<number> => {
  try {
    return await flushJudgmentJobSqliteOutbox({claimedBy, jobId})
  } catch (error) {
    if (error instanceof JudgmentJobLeaseError) {
      return 0
    }

    throw error
  }
}

const cleanupStartupRolloutJob = async ({
  claimedBy,
  job,
}: {
  claimedBy: string
  job: RolloutCleanupJobRow
}): Promise<JudgmentStartupRolloutCleanupResult> => {
  const sqliteService = getJudgmentJobSqliteService()
  const localRepair = await sqliteService.repairLegacyCompletionEvidence({jobId: job.id, serverJobId: claimedBy})
  const tokenUseRepair = await repairLegacyTokenUseEvidenceForJob(job.id)
  const legacyRepair = addLegacyEvidenceRepairResults(localRepair, tokenUseRepair)
  const importedOutboxRows = await flushPreservedLocalOutbox({claimedBy, jobId: job.id})
  const discardedRuntimeRows = await sqliteService.discardActiveRuntimeRows(job.id, claimedBy)
  const assigned = await assignRolloutJobState({jobId: job.id, legacyRepair})

  return {...assigned, discardedRuntimeRows, importedOutboxRows, jobCount: 1}
}

const cleanupStartupRolloutJobs = async ({
  claimedBy,
  jobs,
  total = emptyRolloutCleanupResult(),
}: {
  claimedBy: string
  jobs: RolloutCleanupJobRow[]
  total?: JudgmentStartupRolloutCleanupResult
}): Promise<JudgmentStartupRolloutCleanupResult> => {
  const [job] = jobs

  return job
    ? cleanupStartupRolloutJobs({
        claimedBy,
        jobs: jobs.slice(1),
        total: addRolloutCleanupResults(total, await cleanupStartupRolloutJob({claimedBy, job})),
      })
    : total
}

export const runStartupJudgmentRolloutCleanup = async ({
  claimedBy,
}: {
  claimedBy: string
}): Promise<JudgmentStartupRolloutCleanupResult> => {
  const result = await cleanupStartupRolloutJobs({claimedBy, jobs: await getStartupRolloutJobRows()})

  await backfillRequestAttemptCloseoutsOnStartup()
  await reconcileProviderAdmissionLeasesForDurableCloseout()

  return result
}
