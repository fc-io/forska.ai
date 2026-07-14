import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getImportableJudgmentJobWhereSql} from './judgmentJobImportScope.ts'
import {getJudgmentJobSqliteJobIds} from './judgmentJobPaths.ts'
import {runJudgmentJobSqliteOutboxImportCycle} from './judgmentJobSqliteOutboxImport.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'
import {
  getJudgmentJobSqliteErrorMessage,
  isTransientJudgmentJobSqliteLockMessage,
} from './judgmentJobSqliteTransientLock.ts'

const judgmentJobSqliteBackgroundImportLogger = createRateLimitedLogger({windowMs: 30_000})
const isolatedImportFailureThreshold = 3
const drainingRetentionPruneChunkSize = 1_000
const maxImportableJudgmentJobsPerScan = 100
const judgmentJobSqliteBackgroundImportWorkloadContext = {
  fallbackIntent: 'reject' as const,
  routeOrJobKey: 'judgmentJob.sqliteBackgroundImport',
  workloadClass: 'background.judgmentJob.sqliteImport',
}

type ImportableJudgmentJobRow = {id: string; storageState?: string | null}
type ImportableJudgmentJob = {id: string; storageState: string}
type BackgroundImportSummary = {
  attemptedCount: number
  failedCount: number
  skippedCount: number
  succeededCount: number
}
type BackgroundImportAttempt = {continueToNextJob: boolean; summary: BackgroundImportSummary}
type RetentionPruneResult = {outboxRowsDeleted: number; queuePromptRowsDeleted: number}

const queryBackground = async <_T>(
  statement: string,
  workloadContext = judgmentJobSqliteBackgroundImportWorkloadContext,
) => {
  const database = getAppDatabaseService()
  const queryJsonBackground = database.queryJsonBackground ?? database.queryJson

  return queryJsonBackground<_T>(statement, workloadContext)
}

const runBackground = async (statement: string) => {
  const database = getAppDatabaseService()
  const runDatabaseBackground = database.runBackground ?? database.run

  await runDatabaseBackground(statement, judgmentJobSqliteBackgroundImportWorkloadContext)
}

const normalizeImportableJudgmentJob = (row: ImportableJudgmentJobRow): ImportableJudgmentJob => {
  return {id: row.id, storageState: row.storageState ?? 'active'}
}

const getImportableJudgmentJobPriority = (job: ImportableJudgmentJob) => {
  return job.storageState === 'draining' ? 0 : 1
}

const sortImportableJudgmentJobs = (jobs: ImportableJudgmentJob[]) => {
  return [...jobs].sort((left, right) => {
    const priorityDifference = getImportableJudgmentJobPriority(left) - getImportableJudgmentJobPriority(right)

    return priorityDifference === 0 ? left.id.localeCompare(right.id) : priorityDifference
  })
}

const getNormalizedImportableJudgmentJobs = (rows: ImportableJudgmentJobRow[]) => {
  return sortImportableJudgmentJobs(
    rows.map((row) => {
      return normalizeImportableJudgmentJob(row)
    }),
  )
}

const getImportableJudgmentJobs = async () => {
  const trackedJobIds = getJudgmentJobSqliteJobIds().sort().slice(0, maxImportableJudgmentJobsPerScan)

  if (trackedJobIds.length === 0) {
    const rows = await queryBackground<ImportableJudgmentJobRow>(
      `
      SELECT
        id,
        storage_state AS storageState
      FROM app.judgment_job
      WHERE (${getImportableJudgmentJobWhereSql()})
      ORDER BY CASE WHEN storage_state = 'draining' THEN 0 ELSE 1 END, id ASC
      LIMIT ${maxImportableJudgmentJobsPerScan}
    `,
      {...judgmentJobSqliteBackgroundImportWorkloadContext, maxResultRows: maxImportableJudgmentJobsPerScan},
    )

    return getNormalizedImportableJudgmentJobs(rows)
  }

  const rows = await Promise.all(
    trackedJobIds.map(async (jobId) => {
      const [row] = await queryBackground<ImportableJudgmentJobRow>(
        `
        SELECT
          id,
          storage_state AS storageState
        FROM app.judgment_job
        WHERE id = ${getSqlLiteral(jobId)}
          AND (${getImportableJudgmentJobWhereSql()})
        LIMIT 1
      `,
        {...judgmentJobSqliteBackgroundImportWorkloadContext, maxResultRows: 1},
      )

      return row ?? null
    }),
  )

  return getNormalizedImportableJudgmentJobs(
    rows.filter((row): row is ImportableJudgmentJobRow => {
      return row !== null
    }),
  )
}

const getEmptyRetentionPruneResult = (): RetentionPruneResult => {
  return {outboxRowsDeleted: 0, queuePromptRowsDeleted: 0}
}

const getEmptyBackgroundImportSummary = (): BackgroundImportSummary => {
  return {attemptedCount: 0, failedCount: 0, skippedCount: 0, succeededCount: 0}
}

const addBackgroundImportSummaries = (
  left: BackgroundImportSummary,
  right: BackgroundImportSummary,
): BackgroundImportSummary => {
  return {
    attemptedCount: left.attemptedCount + right.attemptedCount,
    failedCount: left.failedCount + right.failedCount,
    skippedCount: left.skippedCount + right.skippedCount,
    succeededCount: left.succeededCount + right.succeededCount,
  }
}

const addRetentionPruneResults = (left: RetentionPruneResult, right: RetentionPruneResult): RetentionPruneResult => {
  return {
    outboxRowsDeleted: left.outboxRowsDeleted + right.outboxRowsDeleted,
    queuePromptRowsDeleted: left.queuePromptRowsDeleted + right.queuePromptRowsDeleted,
  }
}

const pruneDrainingRetentionUntilStable = async ({
  claimedBy,
  jobId,
  total = getEmptyRetentionPruneResult(),
}: {
  claimedBy: string
  jobId: string
  total?: RetentionPruneResult
}): Promise<RetentionPruneResult> => {
  const current = await getJudgmentJobSqliteService().pruneVisibilityAckedRetention({
    jobId,
    maxRows: drainingRetentionPruneChunkSize,
    serverJobId: claimedBy,
  })

  return current.outboxRowsDeleted === 0 && current.queuePromptRowsDeleted === 0
    ? total
    : pruneDrainingRetentionUntilStable({claimedBy, jobId, total: addRetentionPruneResults(total, current)})
}

const finishDrainingJobCleanup = async ({claimedBy, jobId}: {claimedBy: string; jobId: string}) => {
  const sqliteService = getJudgmentJobSqliteService()
  const pruned = await pruneDrainingRetentionUntilStable({claimedBy, jobId})
  const finalized = (await sqliteService.finalizeDrainingJobs({jobId, serverJobId: claimedBy})).includes(jobId)
  const checkpointed = await sqliteService.checkpointWal({jobId, serverJobId: claimedBy})

  return {...pruned, checkpointed, finalized}
}

const runDrainingJobFastImport = async ({claimedBy, jobId}: {claimedBy: string; jobId: string}) => {
  const {runJudgmentJobSqliteIsolatedFlush} = await import('./judgmentJobSqliteIsolatedImport.ts')
  const flushResult = await runJudgmentJobSqliteIsolatedFlush({claimedBy, jobId})

  if (flushResult.errorMessage !== null) {
    throw new Error(flushResult.errorMessage)
  }

  const cleanupResult = await finishDrainingJobCleanup({claimedBy, jobId})
  const changed =
    flushResult.importedCount > 0
    || cleanupResult.outboxRowsDeleted > 0
    || cleanupResult.queuePromptRowsDeleted > 0
    || cleanupResult.finalized

  return {changed, exitCode: flushResult.exitCode}
}

const runActiveJobImport = async ({claimedBy, jobId}: {claimedBy: string; jobId: string}) => {
  const result = await runJudgmentJobSqliteOutboxImportCycle({claimedBy, jobId})

  return {changed: result.status !== 'idle', exitCode: 0}
}

const runImportableJudgmentJob = async ({claimedBy, job}: {claimedBy: string; job: ImportableJudgmentJob}) => {
  return job.storageState === 'draining'
    ? runDrainingJobFastImport({claimedBy, jobId: job.id})
    : runActiveJobImport({claimedBy, jobId: job.id})
}

const recordImportStart = async (jobId: string) => {
  await runBackground(
    `
    UPDATE app.judgment_job
    SET last_import_started_at = current_timestamp,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
  `,
  )
}

const recordImportSuccess = async ({exitCode, jobId}: {exitCode: number; jobId: string}) => {
  await runBackground(
    `
    UPDATE app.judgment_job
    SET last_import_completed_at = current_timestamp,
        last_import_error_at = NULL,
        last_import_error = NULL,
        last_import_exit_code = ${getSqlLiteral(exitCode)},
        import_failure_count = 0,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
  `,
  )
}

const recordImportFailure = async ({
  errorMessage,
  exitCode,
  jobId,
}: {
  errorMessage: string
  exitCode: number
  jobId: string
}) => {
  return queryBackground<{importFailureCount: number; storageState: string}>(
    `
    UPDATE app.judgment_job
    SET last_import_error_at = current_timestamp,
        last_import_error = ${getSqlLiteral(errorMessage)},
        last_import_exit_code = ${getSqlLiteral(exitCode)},
        import_failure_count = import_failure_count + 1,
        status = CASE
          WHEN import_failure_count + 1 >= ${isolatedImportFailureThreshold} THEN 'failed'
          ELSE status
        END,
        storage_state = CASE
          WHEN import_failure_count + 1 >= ${isolatedImportFailureThreshold} THEN 'quarantined'
          ELSE storage_state
        END,
        quarantined_at = CASE
          WHEN import_failure_count + 1 >= ${isolatedImportFailureThreshold} THEN current_timestamp
          ELSE quarantined_at
        END,
        quarantine_reason = CASE
          WHEN import_failure_count + 1 >= ${isolatedImportFailureThreshold} THEN ${getSqlLiteral(errorMessage)}
          ELSE quarantine_reason
        END,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
    RETURNING import_failure_count AS importFailureCount, storage_state AS storageState
  `,
    {...judgmentJobSqliteBackgroundImportWorkloadContext, maxResultRows: 1},
  )
}

const recordTransientImportFailure = async ({
  errorMessage,
  exitCode,
  jobId,
}: {
  errorMessage: string
  exitCode: number
  jobId: string
}) => {
  return queryBackground<{importFailureCount: number; storageState: string}>(
    `
    UPDATE app.judgment_job
    SET last_import_error_at = current_timestamp,
        last_import_error = ${getSqlLiteral(errorMessage)},
        last_import_exit_code = ${getSqlLiteral(exitCode)},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
    RETURNING import_failure_count AS importFailureCount, storage_state AS storageState
  `,
    {...judgmentJobSqliteBackgroundImportWorkloadContext, maxResultRows: 1},
  )
}

const runJudgmentJobSqliteBackgroundImportAttempt = async ({
  claimedBy,
  job,
}: {
  claimedBy: string
  job: ImportableJudgmentJob
}): Promise<BackgroundImportAttempt> => {
  const sqliteService = getJudgmentJobSqliteService()
  const jobId = job.id

  await recordImportStart(jobId)

  if (sqliteService.hasOwnedLease(jobId)) {
    await sqliteService.releaseOwnedLease(jobId)
  }

  try {
    const result = await runImportableJudgmentJob({claimedBy, job})
    await recordImportSuccess({exitCode: result.exitCode, jobId})
    await sqliteService.getHealthSnapshot(jobId)
    return !result.changed
      ? {continueToNextJob: false, summary: {attemptedCount: 1, failedCount: 0, skippedCount: 1, succeededCount: 0}}
      : {continueToNextJob: false, summary: {attemptedCount: 1, failedCount: 0, skippedCount: 0, succeededCount: 1}}
  } catch (error) {
    const errorMessage = getJudgmentJobSqliteErrorMessage(error)
    const isTransientLock = isTransientJudgmentJobSqliteLockMessage(errorMessage)

    if (job.storageState === 'draining' && isTransientLock) {
      judgmentJobSqliteBackgroundImportLogger.log(
        `judgment-job-sqlite-background-import:skipped:${jobId}`,
        '[judgment-job-sqlite-background-import] skipped draining job because SQLite lease is unavailable',
        {claimedBy, errorMessage, jobId, storageState: job.storageState},
      )

      return {continueToNextJob: true, summary: {attemptedCount: 1, failedCount: 0, skippedCount: 1, succeededCount: 0}}
    }

    const [failureState] = isTransientLock
      ? await recordTransientImportFailure({errorMessage, exitCode: 1, jobId})
      : await recordImportFailure({errorMessage, exitCode: 1, jobId})

    judgmentJobSqliteBackgroundImportLogger.warn(
      `judgment-job-sqlite-background-import:failed:${jobId}`,
      '[judgment-job-sqlite-background-import] importer failed',
      {
        claimedBy,
        errorMessage,
        exitCode: 1,
        importFailureCount: failureState?.importFailureCount ?? null,
        jobId,
        storageState: failureState?.storageState ?? null,
      },
    )

    return {continueToNextJob: false, summary: {attemptedCount: 1, failedCount: 1, skippedCount: 0, succeededCount: 0}}
  }
}

const runNextJudgmentJobSqliteBackgroundImport = async ({
  claimedBy,
  jobs,
  summary = getEmptyBackgroundImportSummary(),
}: {
  claimedBy: string
  jobs: ImportableJudgmentJob[]
  summary?: BackgroundImportSummary
}): Promise<BackgroundImportSummary> => {
  const [job = null, ...remainingJobs] = jobs

  if (!job) {
    return summary
  }

  const attempt = await runJudgmentJobSqliteBackgroundImportAttempt({claimedBy, job})
  const nextSummary = addBackgroundImportSummaries(summary, attempt.summary)

  return attempt.continueToNextJob
    ? runNextJudgmentJobSqliteBackgroundImport({claimedBy, jobs: remainingJobs, summary: nextSummary})
    : nextSummary
}

export const runJudgmentJobSqliteBackgroundImport = async ({claimedBy}: {claimedBy: string}) => {
  const sqliteService = getJudgmentJobSqliteService()

  await sqliteService.syncOwnedLeases([])

  return runNextJudgmentJobSqliteBackgroundImport({claimedBy, jobs: await getImportableJudgmentJobs()})
}
