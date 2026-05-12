import {getProviderConnectionForStoredModel} from '../../providers/providerConnectionRepository.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getJudgmentJobSqliteHealthProjectionService} from '../../services/judgmentJobSqliteHealthProjectionService.ts'
import {
  getJudgmentProviderTelemetryHistorySampleInsertFromSnapshot,
  insertJudgmentProviderTelemetryHistorySamples,
  type JudgmentProviderTelemetryHistoryInsertResult,
  type JudgmentProviderTelemetryHistorySampleInsert,
} from '../../services/judgmentProviderTelemetryHistoryService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {shouldCurrentServerRunMaintenanceLoops} from '../../utils/serverRuntimeRole.ts'
import {getJudgmentProviderTelemetrySnapshot} from './judgmentProviderTelemetrySnapshot.ts'
import {judgmentsJobsGetRunningJobs, type RunningJudgmentJob} from './judgmentsJobsGetRunningJobs.ts'

export type JudgmentProviderTelemetrySamplerResult = JudgmentProviderTelemetryHistoryInsertResult & {
  runningJobCount: number
  sampledAt: Date
}

type JudgmentProviderTelemetrySamplerDatabase = ReturnType<typeof getAppDatabaseService>

const telemetrySamplerLogger = createRateLimitedLogger({windowMs: 30_000})

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getEmptySamplerResult = (sampledAt: Date): JudgmentProviderTelemetrySamplerResult => {
  return {attempted: 0, inserted: 0, runningJobCount: 0, sampledAt, skipped: 0}
}

const getRunningJobsForSampler = async (): Promise<RunningJudgmentJob[] | null> => {
  try {
    return await judgmentsJobsGetRunningJobs({applyRuntimeMatchFilter: false})
  } catch (error) {
    telemetrySamplerLogger.warn(
      'judgments-provider-telemetry-sampler-running-jobs-unavailable',
      '[judgments] provider telemetry sampler could not read running jobs',
      {error: getErrorMessage(error)},
    )
    return null
  }
}

const getReadyCountsByJobId = async ({
  db,
  jobs,
  sampledAt,
}: {
  db: JudgmentProviderTelemetrySamplerDatabase
  jobs: RunningJudgmentJob[]
  sampledAt: Date
}) => {
  const projections = await getJudgmentJobSqliteHealthProjectionService().getFreshJudgmentJobSqliteHealthProjections({
    db,
    jobIds: jobs.map((job) => {
      return job.id
    }),
    now: sampledAt,
  })

  return new Map(
    jobs.map((job) => {
      return [job.id, projections.get(job.id)?.promptCounts.ready ?? 0] as const
    }),
  )
}

const getTelemetrySampleForJob = async ({
  db,
  job,
  readyCount,
  sampledAt,
}: {
  db: JudgmentProviderTelemetrySamplerDatabase
  job: RunningJudgmentJob
  readyCount: number
  sampledAt: Date
}): Promise<JudgmentProviderTelemetryHistorySampleInsert> => {
  const providerConnection = await getProviderConnectionForStoredModel(job.modelId, db)
  const telemetry = await getJudgmentProviderTelemetrySnapshot({job, providerConnection, readyCount})

  return getJudgmentProviderTelemetryHistorySampleInsertFromSnapshot({
    jobId: job.id,
    projectId: job.projectId,
    sampledAt,
    snapshot: telemetry.dispatchTelemetry,
  })
}

const getTelemetrySamplesForRunningJobs = async ({
  jobs,
  sampledAt,
}: {
  jobs: RunningJudgmentJob[]
  sampledAt: Date
}): Promise<JudgmentProviderTelemetryHistorySampleInsert[] | null> => {
  try {
    const db = getAppDatabaseService()
    const readyCountsByJobId = await getReadyCountsByJobId({db, jobs, sampledAt})

    return Promise.all(
      jobs.map((job) => {
        return getTelemetrySampleForJob({db, job, readyCount: readyCountsByJobId.get(job.id) ?? 0, sampledAt})
      }),
    )
  } catch (error) {
    telemetrySamplerLogger.warn(
      'judgments-provider-telemetry-sampler-read-model-unavailable',
      '[judgments] provider telemetry sampler could not read telemetry inputs',
      {error: getErrorMessage(error)},
    )
    return null
  }
}

export const judgmentsJobsSampleProviderTelemetry = async ({
  sampledAt = new Date(),
}: {sampledAt?: Date} = {}): Promise<JudgmentProviderTelemetrySamplerResult> => {
  if (!shouldCurrentServerRunMaintenanceLoops()) {
    return getEmptySamplerResult(sampledAt)
  }

  const runningJobs = await getRunningJobsForSampler()

  if (runningJobs === null || runningJobs.length === 0) {
    return getEmptySamplerResult(sampledAt)
  }

  const samples = await getTelemetrySamplesForRunningJobs({jobs: runningJobs, sampledAt})

  if (samples === null) {
    return getEmptySamplerResult(sampledAt)
  }

  const result = await insertJudgmentProviderTelemetryHistorySamples({samples})

  return {...result, runningJobCount: runningJobs.length, sampledAt}
}
