import {duckdbOwnerPrivateApiPrefix} from '../../routes/apiRouteClassification.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {HttpError} from '../../utils/httpError.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {canCurrentServerOwnDuckdb, getCurrentServerDuckdbOwnerUrl} from '../../utils/serverRuntimeRole.ts'
import {getJudgmentJobSqliteService} from './judgmentJobSqliteService.ts'
import {
  getJudgmentJobSqliteErrorMessage,
  isTransientJudgmentJobSqliteLockMessage,
} from './judgmentJobSqliteTransientLock.ts'

const judgmentJobSqlitePreflightLogger = createRateLimitedLogger({windowMs: 30_000})

type JudgmentJobSqlitePreflightCandidate = {id: string; quarantineReason?: string | null; storageState?: string}
export type JudgmentJobSqlitePreflightRunResult = {clearTransientQuarantine: boolean}

const getPreflightFailureMessage = (error: unknown) => {
  return getJudgmentJobSqliteErrorMessage(error)
}

const getQuarantinedJobErrorMessage = ({jobId, reason}: {jobId: string; reason: string | null | undefined}) => {
  const suffix = reason && reason.trim() !== '' ? ` ${reason}` : ' SQLite preflight previously failed.'
  return `Job ${jobId} is quarantined.${suffix} Repair or recreate the local SQLite job DB before starting or resuming it.`
}

const getDrainingJobErrorMessage = (jobId: string) => {
  return `Job ${jobId} is draining. Wait for the local SQLite judgments to finish exporting before starting or resuming it.`
}

const getTransientLockedJobErrorMessage = ({jobId, reason}: {jobId: string; reason: string}) => {
  return `Job ${jobId} SQLite preflight hit a transient lock. ${reason} Forska will retry automatically once the lock clears; the job was not quarantined.`
}

const getDuckdbOwnerUrlForQuarantine = async (): Promise<string> => {
  const configuredUrl = String(process.env.SERVER_DUCKDB_OWNER_URL ?? '').trim()
  const ownerUrl = configuredUrl.length > 0 ? configuredUrl : await getCurrentServerDuckdbOwnerUrl()

  if (ownerUrl === null) {
    throw new Error('DuckDB owner URL is required to quarantine a judgment job from a non-owner process')
  }

  return ownerUrl.endsWith('/') ? ownerUrl.slice(0, -1) : ownerUrl
}

const requestOwnerJobQuarantine = async ({errorMessage, jobId}: {errorMessage: string; jobId: string}) => {
  const ownerUrl = await getDuckdbOwnerUrlForQuarantine()
  const response = await fetch(
    `${ownerUrl}${duckdbOwnerPrivateApiPrefix}/api/judgmentsjobs/${encodeURIComponent(jobId)}/quarantine`,
    {
      body: JSON.stringify({reason: errorMessage}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    },
  )
  const text = await response.text()
  const parsed = text.trim() === '' ? null : (JSON.parse(text) as {error?: unknown})
  const error = parsed && 'error' in parsed ? parsed.error : null

  if (!response.ok || error) {
    throw new Error(typeof error === 'string' ? error : text || response.statusText)
  }
}

const quarantineJobForPreflightFailure = async ({errorMessage, jobId}: {errorMessage: string; jobId: string}) => {
  if (!canCurrentServerOwnDuckdb()) {
    await requestOwnerJobQuarantine({errorMessage, jobId})
    return
  }

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

        if (isTransientJudgmentJobSqliteLockMessage(errorMessage)) {
          judgmentJobSqlitePreflightLogger.warn(
            `judgment-job-sqlite-preflight:skip-transient-lock:${job.id}`,
            '[judgments] skipping running job because the SQLite job DB is temporarily locked',
            {errorMessage, jobId: job.id},
          )
          return null
        }

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
}): Promise<JudgmentJobSqlitePreflightRunResult> => {
  const sqliteService = getJudgmentJobSqliteService()

  if (storageState === 'quarantined') {
    if (isTransientJudgmentJobSqliteLockMessage(quarantineReason)) {
      try {
        await sqliteService.runIsolatedPreflight(jobId)
        return {clearTransientQuarantine: true}
      } catch (error) {
        const errorMessage = getPreflightFailureMessage(error)
        const message = isTransientJudgmentJobSqliteLockMessage(errorMessage)
          ? getTransientLockedJobErrorMessage({jobId, reason: errorMessage})
          : getQuarantinedJobErrorMessage({jobId, reason: errorMessage})

        throw new HttpError(409, message)
      }
    }

    throw new HttpError(409, getQuarantinedJobErrorMessage({jobId, reason: quarantineReason}))
  }

  if (storageState === 'draining') {
    throw new HttpError(409, getDrainingJobErrorMessage(jobId))
  }

  if (!sqliteService.hasJob(jobId)) {
    return {clearTransientQuarantine: false}
  }

  try {
    await sqliteService.runIsolatedPreflight(jobId)
    return {clearTransientQuarantine: false}
  } catch (error) {
    const errorMessage = getPreflightFailureMessage(error)

    if (isTransientJudgmentJobSqliteLockMessage(errorMessage)) {
      throw new HttpError(409, getTransientLockedJobErrorMessage({jobId, reason: errorMessage}))
    }

    await quarantineJobForPreflightFailure({errorMessage, jobId})
    throw new HttpError(409, getQuarantinedJobErrorMessage({jobId, reason: errorMessage}))
  }
}
