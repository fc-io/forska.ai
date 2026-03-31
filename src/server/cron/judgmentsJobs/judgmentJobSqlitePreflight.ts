import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {HttpError} from '../../utils/httpError.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'

const judgmentJobSqlitePreflightLogger = createRateLimitedLogger({windowMs: 30_000})

type JudgmentJobSqlitePreflightCandidate = {id: string; quarantineReason?: string | null; storageState?: string}

const getPreflightFailureMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getQuarantinedJobErrorMessage = ({jobId, reason}: {jobId: string; reason: string | null | undefined}) => {
  const suffix = reason && reason.trim() !== '' ? ` ${reason}` : ' SQLite preflight previously failed.'
  return `Job ${jobId} is quarantined.${suffix} Repair or recreate the local SQLite job DB before starting or resuming it.`
}

const quarantineJobForPreflightFailure = async ({errorMessage, jobId}: {errorMessage: string; jobId: string}) => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET status = 'failed',
        storage_state = 'quarantined',
        quarantined_at = current_timestamp,
        quarantine_reason = ${getSqlLiteral(errorMessage)},
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
  `)
}

export const filterRunningJobsBySqlitePreflight = async <T extends JudgmentJobSqlitePreflightCandidate>(jobs: T[]) => {
  const sqliteService = getJudgmentJobSqliteService()
  const results = await Promise.all(
    jobs.map(async (job) => {
      if (job.storageState === 'quarantined') {
        judgmentJobSqlitePreflightLogger.warn(
          `judgment-job-sqlite-preflight:skip-quarantined:${job.id}`,
          '[judgments] skipping running job because the SQLite job DB is quarantined',
          {jobId: job.id, quarantineReason: job.quarantineReason ?? null},
        )
        return null
      }

      if (!sqliteService.hasJob(job.id)) {
        return job
      }

      try {
        await sqliteService.runIsolatedPreflight(job.id)
        return job
      } catch (error) {
        const errorMessage = getPreflightFailureMessage(error)
        await quarantineJobForPreflightFailure({errorMessage, jobId: job.id})
        judgmentJobSqlitePreflightLogger.warn(
          `judgment-job-sqlite-preflight:quarantined:${job.id}`,
          '[judgments] quarantined running job after isolated SQLite preflight failed',
          {errorMessage, jobId: job.id},
        )
        return null
      }
    }),
  )

  return results.flatMap((job) => {
    return job ? [job] : []
  })
}

export const assertJudgmentJobCanRunSqlitePreflight = async ({
  jobId,
  quarantineReason,
  storageState,
}: {
  jobId: string
  quarantineReason?: string | null
  storageState: string
}) => {
  if (storageState === 'quarantined') {
    throw new HttpError(409, getQuarantinedJobErrorMessage({jobId, reason: quarantineReason}))
  }

  const sqliteService = getJudgmentJobSqliteService()

  if (!sqliteService.hasJob(jobId)) {
    return
  }

  try {
    await sqliteService.runIsolatedPreflight(jobId)
  } catch (error) {
    const errorMessage = getPreflightFailureMessage(error)
    await quarantineJobForPreflightFailure({errorMessage, jobId})
    throw new HttpError(409, getQuarantinedJobErrorMessage({jobId, reason: errorMessage}))
  }
}
