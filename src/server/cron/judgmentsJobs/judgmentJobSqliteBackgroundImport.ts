import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'

const judgmentJobSqliteBackgroundImportLogger = createRateLimitedLogger({windowMs: 30_000})
const isolatedImportFailureThreshold = 3
const importableStorageStateLiterals = [getSqlLiteral('active'), getSqlLiteral('draining')].join(', ')

type IsolatedImportProcessResult = {errorMessage: string | null; exitCode: number}

const getImportableJudgmentJobIds = async () => {
  const rows = await getAppDatabaseService().queryJson<{id: string}>(`
    SELECT id
    FROM app.judgment_job
    WHERE storage_state IN (${importableStorageStateLiterals})
    ORDER BY id ASC
  `)

  return rows.map((row) => {
    return row.id
  })
}

const getLastJsonLine = (output: string) => {
  const lines = output
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('{') && line.endsWith('}')
    })

  const [lastLine = ''] = lines.slice(-1)

  return lastLine === '' ? null : lastLine
}

const getIsolatedImportErrorMessage = ({
  exitCode,
  stderr,
  stdout,
}: {
  exitCode: number
  stderr: string
  stdout: string
}) => {
  const lastJsonLine = getLastJsonLine(stdout)
  const parsed = lastJsonLine
    ? (() => {
        try {
          return JSON.parse(lastJsonLine) as {error?: unknown; status?: unknown}
        } catch (_error) {
          return null
        }
      })()
    : null

  if (parsed?.status === 'failed' && typeof parsed.error === 'string' && parsed.error.trim() !== '') {
    return parsed.error.trim()
  }

  const trimmedStderr = stderr.trim()
  const trimmedStdout = stdout.trim()

  return trimmedStderr || trimmedStdout || `SQLite importer exited with code ${exitCode}`
}

const runIsolatedImportForJob = async ({
  claimedBy,
  jobId,
}: {
  claimedBy: string
  jobId: string
}): Promise<IsolatedImportProcessResult> => {
  const childProcess = globalThis.Bun.spawn(
    ['bun', 'scripts/runJudgmentJobSqliteSingleJobImport.ts', `--jobId=${jobId}`, `--claimedBy=${claimedBy}`],
    {cwd: process.cwd(), env: {...process.env}, stderr: 'pipe', stdout: 'pipe'},
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
    childProcess.exited,
  ])

  return exitCode === 0
    ? {errorMessage: null, exitCode}
    : {errorMessage: getIsolatedImportErrorMessage({exitCode, stderr, stdout}), exitCode}
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

const recordImportLeaseSkip = async (jobId: string) => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET last_import_completed_at = current_timestamp,
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

const isLeaseConflictError = (errorMessage: string) => {
  return errorMessage.includes('SQLite job lease')
}

export const runJudgmentJobSqliteBackgroundImport = async ({claimedBy}: {claimedBy: string}) => {
  await getJudgmentJobSqliteService().syncOwnedLeases([])

  const jobIds = await getImportableJudgmentJobIds()

  return jobIds.reduce(
    async (summaryPromise, jobId) => {
      const summary = await summaryPromise
      await recordImportStart(jobId)

      const result = await runIsolatedImportForJob({claimedBy, jobId})

      if (result.errorMessage === null) {
        await recordImportSuccess({exitCode: result.exitCode, jobId})
        return {...summary, attemptedCount: summary.attemptedCount + 1, succeededCount: summary.succeededCount + 1}
      }

      if (isLeaseConflictError(result.errorMessage)) {
        judgmentJobSqliteBackgroundImportLogger.log(
          `judgment-job-sqlite-background-import:lease:${jobId}`,
          '[judgment-job-sqlite-background-import] skipped job because the SQLite lease is busy',
          {claimedBy, jobId},
        )
        await recordImportLeaseSkip(jobId)
        return {...summary, attemptedCount: summary.attemptedCount + 1, skippedCount: summary.skippedCount + 1}
      }

      const [failureState] = await recordImportFailure({
        errorMessage: result.errorMessage,
        exitCode: result.exitCode,
        jobId,
      })

      judgmentJobSqliteBackgroundImportLogger.warn(
        `judgment-job-sqlite-background-import:failed:${jobId}`,
        '[judgment-job-sqlite-background-import] isolated importer failed',
        {
          claimedBy,
          errorMessage: result.errorMessage,
          exitCode: result.exitCode,
          importFailureCount: failureState?.importFailureCount ?? null,
          jobId,
          storageState: failureState?.storageState ?? null,
        },
      )

      return {...summary, attemptedCount: summary.attemptedCount + 1, failedCount: summary.failedCount + 1}
    },
    Promise.resolve({attemptedCount: 0, failedCount: 0, skippedCount: 0, succeededCount: 0}),
  )
}
