import {getStoredProviderModelRuntimeMatch} from '../../providers/providerRuntimeModelGuard.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getJudgeWorkerReadOnlyAppDatabaseService} from '../../services/appReadOnlyDatabaseService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getOwnerBackedRunningJudgmentJobs, shouldUseJudgeWorkerOwnerHandoff} from './judgeWorkerCompletionJournal.ts'
import {getJudgmentJobSqliteJobIds} from './judgmentJobPaths.ts'
import {filterRunningJobsBySqlitePreflight} from './judgmentJobSqlitePreflight.ts'

const runningJobsLogger = createRateLimitedLogger({windowMs: 30_000})

const getRuntimeCheckFailureLogMessage = ({
  provider,
  reason,
}: {
  provider: string | null
  reason: Awaited<ReturnType<typeof getStoredProviderModelRuntimeMatch>>['reason']
}): string => {
  const runtimeLabel = provider === 'sglang' ? 'SGLang runtime' : 'provider runtime'

  return reason === 'runtime-unreachable'
    ? `[judgments] skipping running job because the ${runtimeLabel} is unreachable`
    : reason === 'runtime-mismatch'
      ? `[judgments] skipping running job because the ${runtimeLabel} is serving a different model`
      : reason === 'runtime-model-unavailable'
        ? `[judgments] skipping running job because the ${runtimeLabel} did not report which model it serves`
        : reason === 'missing-stored-model'
          ? '[judgments] skipping running job because the project model is missing a remote model id'
          : `[judgments] skipping running job because the ${runtimeLabel} could not be verified`
}

export type RunningJudgmentJob = {
  id: string
  maxInflightRequests: number | null
  modelId: string
  modelName: string | null
  modelProvider: string | null
  quarantineReason: string | null
  providerConnectionId: string | null
  projectId: string
  storageState: string
}

const getRunningJobFromDatabase = async (jobId: string): Promise<RunningJudgmentJob | null> => {
  const [row] = await getJudgeWorkerReadOnlyAppDatabaseService().queryJson<RunningJudgmentJob>(`
    SELECT
      jj.id AS id,
      jj.project_id AS projectId,
      pc.max_inflight_requests AS maxInflightRequests,
      pc.provider_kind AS modelProvider,
      m.id AS modelId,
      m.remote_model_id AS modelName,
      jj.quarantine_reason AS quarantineReason,
      m.provider_connection_id AS providerConnectionId,
      jj.storage_state AS storageState
    FROM app.judgment_job jj
    INNER JOIN app.project p ON jj.project_id = p.id
    INNER JOIN app.model m ON p.model_id = m.id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE jj.id = ${getSqlLiteral(jobId)}
      AND jj.status = 'running'
      AND jj.storage_state = 'active'
      AND p.archived = FALSE
      AND COALESCE(m.enabled, TRUE) = TRUE
      AND COALESCE(pc.enabled, TRUE) = TRUE
    LIMIT 1
  `)

  return row ?? null
}

const getRunningJobsFromDatabase = async (): Promise<RunningJudgmentJob[]> => {
  if (shouldUseJudgeWorkerOwnerHandoff()) {
    return getOwnerBackedRunningJudgmentJobs()
  }

  const trackedJobIds = getJudgmentJobSqliteJobIds().sort()

  if (trackedJobIds.length === 0) {
    return []
  }

  const rows = await Promise.all(
    trackedJobIds.map((jobId) => {
      return getRunningJobFromDatabase(jobId)
    }),
  )

  return rows.filter((row): row is RunningJudgmentJob => {
    return row !== null
  })
}

export const filterRunningJobsByRuntimeMatch = async (
  jobs: RunningJudgmentJob[],
  getRuntimeMatch: typeof getStoredProviderModelRuntimeMatch = getStoredProviderModelRuntimeMatch,
): Promise<RunningJudgmentJob[]> => {
  const results = await Promise.all(
    jobs.map(async (job) => {
      const runtimeMatch = await getRuntimeMatch({modelId: job.modelId})
      return {job, runtimeMatch}
    }),
  )

  return results.flatMap(({job, runtimeMatch}) => {
    if (runtimeMatch.ok) {
      return [job]
    }

    runningJobsLogger.warn(
      `judgments-job-runtime-check-failed:${job.id}`,
      getRuntimeCheckFailureLogMessage({provider: job.modelProvider, reason: runtimeMatch.reason}),
      {
        jobId: job.id,
        message: runtimeMatch.message,
        modelId: job.modelId,
        modelName: job.modelName,
        provider: job.modelProvider,
        projectId: job.projectId,
        reason: runtimeMatch.reason,
      },
    )

    return []
  })
}

export const judgmentsJobsGetRunningJobs = async ({
  applyRuntimeMatchFilter = true,
}: {applyRuntimeMatchFilter?: boolean} = {}) => {
  const jobs = await getRunningJobsFromDatabase()
  const preflightedJobs = await filterRunningJobsBySqlitePreflight(jobs)

  return applyRuntimeMatchFilter ? filterRunningJobsByRuntimeMatch(preflightedJobs) : preflightedJobs
}
