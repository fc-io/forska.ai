import {getJobContext} from './getJobContext.ts'
import {getJudgmentImportConsumerAvailability} from './getJudgmentImportConsumerAvailability.ts'
import {getJudgmentImportWorkLeasesByJobId} from './getJudgmentImportWorkLeasesByJobId.ts'
import {getJudgmentJobControlPlaneDiagnostics} from './getJudgmentJobControlPlaneDiagnostics.ts'
import {getJudgmentJobEndpointHealth} from './getJudgmentJobEndpointHealth.ts'
import {getJudgmentJobHealthProgress} from './getJudgmentJobHealthProgress.ts'
import {getJudgmentJobsReadDatabase} from './getJudgmentJobsReadDatabase.ts'
import {getJudgmentJobWorkIdentity} from './getJudgmentJobWorkIdentity.ts'
import {getProviderHealthApi} from './getProviderHealthApi.ts'
import {getRecommendedHealthAction} from './getRecommendedHealthAction.ts'
import {getStoragePolicy} from './judgmentJobStorageHealth.ts'
import {getProviderHealthForReadableRoute} from './providerHealthForReadableRoute.ts'
import {runJudgmentJobsRead} from './runJudgmentJobsRead.ts'
import {getSqliteHealthForReadableRoute} from './sqliteHealthForReadableRoute.ts'

export const judgmentsJobsRoutesGetJobHealth = async ({params, request}: {params: {id: string}; request: Request}) => {
  return runJudgmentJobsRead({
    operation: async () => {
      const db = getJudgmentJobsReadDatabase()
      const currentNow = new Date()
      const {job, projectModelId} = await getJobContext({db, jobId: params.id})
      const workIdentity = getJudgmentJobWorkIdentity({job, modelId: projectModelId})
      const [sqliteHealth, importConsumer, importWorkLeasesByJobId, endpointHealth, providerHealth] = await Promise.all(
        [
          getSqliteHealthForReadableRoute({db, job, jobId: job.id}),
          getJudgmentImportConsumerAvailability(),
          getJudgmentImportWorkLeasesByJobId({db, jobIds: [job.id], now: currentNow}),
          getJudgmentJobEndpointHealth({db, modelId: projectModelId}),
          getProviderHealthForReadableRoute({db, jobId: job.id}),
        ],
      )
      const storagePolicy = getStoragePolicy({job, sqliteHealth})
      const recommendedNextAction = getRecommendedHealthAction({job, sqliteHealth})
      const controlPlane = getJudgmentJobControlPlaneDiagnostics()
      const progress = getJudgmentJobHealthProgress({
        endpointHealth,
        importConsumer,
        importWorkLeases: importWorkLeasesByJobId.get(job.id) ?? [],
        job,
        now: currentNow,
        recommendedNextAction,
        sqliteHealth,
        workIdentity,
      })

      return {
        ...progress,
        jobId: job.id,
        storageState: job.storageState,
        storagePolicy,
        recommendedNextAction,
        endpointAvailability: endpointHealth.diagnostics,
        providerDiagnostics: endpointHealth.providerDiagnostics,
        providerHealth: getProviderHealthApi({jobStatus: job.status, providerHealth}),
        controlPlane,
        importMetadata: {
          importFailureCount: job.importFailureCount,
          lastImportCompletedAt: job.lastImportCompletedAt,
          lastImportError: job.lastImportError,
          lastImportErrorAt: job.lastImportErrorAt,
          lastImportExitCode: job.lastImportExitCode,
          lastImportStartedAt: job.lastImportStartedAt,
          pauseRequestedAt: job.pauseRequestedAt,
        },
        quarantine: {quarantinedAt: job.quarantinedAt, quarantineReason: job.quarantineReason},
        liveSqlite: sqliteHealth,
      }
    },
    request,
  })
}
