import {getStoredProviderModelRuntimeMatch} from '../../providers/providerRuntimeModelGuard.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'

const runningJobsLogger = createRateLimitedLogger({windowMs: 30_000})

export type RunningJudgmentJob = {
  id: string
  modelId: string
  modelName: string | null
  modelProvider: string | null
  projectId: string
}

const getRunningJobsFromDatabase = async (): Promise<RunningJudgmentJob[]> => {
  return getAppDatabaseService().queryJson<RunningJudgmentJob>(`
    SELECT
      jj.id AS id,
      jj.project_id AS projectId,
      pc.provider_kind AS modelProvider,
      m.id AS modelId,
      m.remote_model_id AS modelName
    FROM app.judgment_job jj
    INNER JOIN app.project p ON jj.project_id = p.id
    INNER JOIN app.model m ON p.model_id = m.id
    LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE jj.status = 'running'
      AND p.archived = FALSE
      AND COALESCE(m.enabled, TRUE) = TRUE
      AND COALESCE(pc.enabled, TRUE) = TRUE
  `)
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
      `judgments-job-runtime-mismatch:${job.id}`,
      '[judgments] skipping running job because provider runtime is unavailable or mismatched',
      {
        jobId: job.id,
        message: runtimeMatch.message,
        modelId: job.modelId,
        modelName: job.modelName,
        provider: job.modelProvider,
        projectId: job.projectId,
      },
    )

    return []
  })
}

export const judgmentsJobsGetRunningJobs = async ({
  applyRuntimeMatchFilter = true,
}: {applyRuntimeMatchFilter?: boolean} = {}) => {
  const jobs = await getRunningJobsFromDatabase()

  return applyRuntimeMatchFilter ? filterRunningJobsByRuntimeMatch(jobs) : jobs
}
