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

const getImportableJudgmentJobIds = async () => {
  const trackedJobIds = getJudgmentJobSqliteJobIds().sort()

  if (trackedJobIds.length === 0) {
    const rows = await getAppDatabaseService().queryJson<{id: string}>(`
      SELECT id
      FROM app.judgment_job
      WHERE (${getImportableJudgmentJobWhereSql()})
      ORDER BY id ASC
    `)

    return rows.map((row) => {
      return row.id
    })
  }

  const rows = await Promise.all(
    trackedJobIds.map(async (jobId) => {
      const [row] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.judgment_job
        WHERE id = ${getSqlLiteral(jobId)}
          AND (${getImportableJudgmentJobWhereSql()})
        LIMIT 1
      `)

      return row?.id ?? null
    }),
  )

  return rows.filter((jobId): jobId is string => {
    return jobId !== null
  })
}

const recordImportStart = async (jobId: string) => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET last_import_started_at = current_timestamp,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
  `)
}

const recordImportSuccess = async ({exitCode, jobId}: {exitCode: number; jobId: string}) => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET last_import_completed_at = current_timestamp,
        last_import_error_at = NULL,
        last_import_error = NULL,
        last_import_exit_code = ${getSqlLiteral(exitCode)},
        import_failure_count = 0,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
  `)
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
  return getAppDatabaseService().queryJson<{importFailureCount: number; storageState: string}>(`
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
  `)
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
  return getAppDatabaseService().queryJson<{importFailureCount: number; storageState: string}>(`
    UPDATE app.judgment_job
    SET last_import_error_at = current_timestamp,
        last_import_error = ${getSqlLiteral(errorMessage)},
        last_import_exit_code = ${getSqlLiteral(exitCode)},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
    RETURNING import_failure_count AS importFailureCount, storage_state AS storageState
  `)
}

export const runJudgmentJobSqliteBackgroundImport = async ({claimedBy}: {claimedBy: string}) => {
  const sqliteService = getJudgmentJobSqliteService()

  await sqliteService.syncOwnedLeases([])

  const [jobId = null] = await getImportableJudgmentJobIds()

  if (!jobId) {
    return {attemptedCount: 0, failedCount: 0, skippedCount: 0, succeededCount: 0}
  }

  await recordImportStart(jobId)

  if (sqliteService.hasOwnedLease(jobId)) {
    await sqliteService.releaseOwnedLease(jobId)
  }

  try {
    const result = await runJudgmentJobSqliteOutboxImportCycle({claimedBy, jobId})
    await recordImportSuccess({exitCode: 0, jobId})
    await sqliteService.getHealthSnapshot(jobId)
    return result.status === 'idle'
      ? {attemptedCount: 1, failedCount: 0, skippedCount: 1, succeededCount: 0}
      : {attemptedCount: 1, failedCount: 0, skippedCount: 0, succeededCount: 1}
  } catch (error) {
    const errorMessage = getJudgmentJobSqliteErrorMessage(error)
    const [failureState] = isTransientJudgmentJobSqliteLockMessage(errorMessage)
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

    return {attemptedCount: 1, failedCount: 1, skippedCount: 0, succeededCount: 0}
  }
}
