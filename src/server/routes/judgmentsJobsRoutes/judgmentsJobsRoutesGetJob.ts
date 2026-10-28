import {getJudgmentJobAdmittedArticleCount} from '../../cron/judgmentsJobs/judgmentJobAdmittedArticles.ts'
import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getJudgmentJobStorageTransferRuntime} from '../../cron/judgmentsJobs/judgmentJobStorageTransferRuntime.ts'
import {getJudgmentProviderTelemetrySnapshot} from '../../cron/judgmentsJobs/judgmentProviderTelemetrySnapshot.ts'
import {getFullTextStrategyLabelsById} from '../../fullText/fullTextStrategyRepository.ts'
import {getProviderConnectionForStoredModel} from '../../providers/providerConnectionRepository.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {getProjectFullTextGate} from '../../services/judgmentJobFullTextGate.ts'
import {shouldCurrentServerRunJudgingLoops} from '../../utils/serverRuntimeRole.ts'
import {getJobContext} from './getJobContext.ts'
import {getJobFullTextStrategyLabel} from './getJobFullTextStrategyLabel.ts'
import {getJudgmentJobControlPlaneDiagnostics} from './getJudgmentJobControlPlaneDiagnostics.ts'
import {getJudgmentJobsReadDatabase} from './getJudgmentJobsReadDatabase.ts'
import {getProjectFullTextGateApi} from './getProjectFullTextGateApi.ts'
import {getProviderHealthApi} from './getProviderHealthApi.ts'
import {getJudgingRuntime} from './judgingRuntime.ts'
import {getStoragePolicy} from './judgmentJobStorageHealth.ts'
import {getFailedRequestSummaryFromDatabase} from './judgmentsJobsRoutesGetJob/getFailedRequestSummaryFromDatabase.ts'
import {getProviderHealthForReadableRoute} from './providerHealthForReadableRoute.ts'
import {runJudgmentJobsRead} from './runJudgmentJobsRead.ts'
import {getSqliteHealthForReadableRoute} from './sqliteHealthForReadableRoute.ts'

export const judgmentsJobsRoutesGetJob = async ({params, request}: {params: {id: string}; request: Request}) => {
  return runJudgmentJobsRead({
    operation: async () => {
      const db = getJudgmentJobsReadDatabase()
      const {job, projectModelId} = await getJobContext({db, jobId: params.id})
      const sqliteService = getJudgmentJobSqliteService()
      const sqliteHealthPromise = getSqliteHealthForReadableRoute({db, job, jobId: job.id})
      const providerConnectionPromise = getProviderConnectionForStoredModel(projectModelId, db)
      const leaseMetadataPromise = shouldCurrentServerRunJudgingLoops()
        ? sqliteService.getJudgmentJobLeaseMetadata(job.id)
        : Promise.resolve(null)
      const failedRequestSummaryPromise = providerConnectionPromise.then((providerConnection) => {
        return getFailedRequestSummaryFromDatabase({
          db,
          jobId: job.id,
          modelProvider: providerConnection?.providerKind ?? null,
        })
      })

      const judgingRuntimePromise = getJudgingRuntime()
      const admittedArticleCountPromise = getJudgmentJobAdmittedArticleCount({
        db,
        jobId: job.id,
        stopAfterArticles: job.stopAfterArticles,
      })
      const [
        sqliteHealth,
        leaseMetadata,
        totalTokenUsage,
        failedRequestSummary,
        judgingRuntime,
        providerConnection,
        providerHealth,
        admittedArticleCount,
        fullTextStrategyLabelsById,
        fullTextGate,
      ] = await Promise.all([
        sqliteHealthPromise,
        leaseMetadataPromise,
        db.queryJson<{
          totalTokens: number | null
          totalPromptTokens: number | null
          totalCompletionTokens: number | null
          totalRequests: number | null
        }>(`
          SELECT
            SUM(total_tokens) AS totalTokens,
            SUM(total_prompt_tokens) AS totalPromptTokens,
            SUM(total_completion_tokens) AS totalCompletionTokens,
            SUM(requests) AS totalRequests
          FROM app.token_use
          WHERE judgment_job_id = '${escapeSqlString(job.id)}'
        `),
        failedRequestSummaryPromise,
        judgingRuntimePromise,
        providerConnectionPromise,
        getProviderHealthForReadableRoute({db, jobId: job.id}),
        admittedArticleCountPromise,
        getFullTextStrategyLabelsById(db, [job.fullTextStrategyId]),
        getProjectFullTextGate(job.projectId, db),
      ])
      const storagePolicy = getStoragePolicy({job, sqliteHealth})
      const recentTransfer = getJudgmentJobStorageTransferRuntime(job.id)
      const controlPlane = getJudgmentJobControlPlaneDiagnostics()
      const providerTelemetry = await getJudgmentProviderTelemetrySnapshot({
        job: {
          id: job.id,
          maxInflightRequests: providerConnection?.maxInflightRequests ?? null,
          modelId: projectModelId,
          modelProvider: providerConnection?.providerKind ?? null,
          providerConnectionId: providerConnection?.id ?? null,
          providerName: providerConnection?.label ?? null,
        },
        providerConnection,
        readyCount: sqliteHealth.promptCounts.ready,
      })
      const dispatchTelemetry = providerTelemetry.dispatchTelemetry
      const endpointAvailability = providerTelemetry.endpointAvailability
      const dispatchStats = dispatchTelemetry.dispatch
      const requestRuntimeStats = dispatchTelemetry.request

      const activePromptsNotMarkedRunning = Math.max(
        0,
        dispatchStats.jobActivePrompts - sqliteHealth.promptCounts.running,
      )
      const promptStats = {
        claimed: Math.max(0, sqliteHealth.promptCounts.claimed - activePromptsNotMarkedRunning),
        judged: sqliteHealth.promptCounts.judged,
        ready: sqliteHealth.promptCounts.ready,
        running: Math.max(sqliteHealth.promptCounts.running, dispatchStats.jobActivePrompts),
        skipped: sqliteHealth.promptCounts.skipped,
      }
      const lifecycleCounters = {
        claimedPrompts: promptStats.claimed,
        liveLlmCalls: requestRuntimeStats.inFlight,
        providerKey: dispatchTelemetry.provider.providerKey,
        runningPrompts: promptStats.running,
        workerActivePrompts: dispatchStats.jobActivePrompts,
        workerQueuedPrompts: dispatchStats.jobQueuedPrompts,
      }
      const storageHealth = {...sqliteHealth, ...(recentTransfer ? {recentTransfer} : {})}

      return {
        ...job,
        admittedArticleCount,
        fullTextGate: getProjectFullTextGateApi(fullTextGate),
        fullTextStrategyLabel: getJobFullTextStrategyLabel(job, fullTextStrategyLabelsById),
        leaseMetadata,
        promptStats,
        providerHealth: getProviderHealthApi({jobStatus: job.status, providerHealth}),
        storagePolicy,
        storageHealth,
        judgingRuntime,
        totalTokenUsage: {
          totalTokens: Number(totalTokenUsage[0]?.totalTokens || 0),
          totalPromptTokens: Number(totalTokenUsage[0]?.totalPromptTokens || 0),
          totalCompletionTokens: Number(totalTokenUsage[0]?.totalCompletionTokens || 0),
        },
        requestStats: {
          controlPlane,
          dispatch: {
            jobActivePrompts: dispatchStats.jobActivePrompts,
            jobQueuedPrompts: dispatchStats.jobQueuedPrompts,
            providerAdaptiveInflight: dispatchStats.providerAdaptiveInflight,
            providerDispatchActivePromptFillPct: dispatchStats.providerDispatchActivePromptFillPct,
            providerDispatchActivePromptLimit: dispatchStats.providerDispatchActivePromptLimit,
            providerDispatchActivePrompts: dispatchStats.providerDispatchActivePrompts,
            providerDispatchPrefetchFillPct: dispatchStats.providerDispatchPrefetchFillPct,
            providerDispatchQueueLimit: dispatchStats.providerDispatchQueueLimit,
            providerDispatchQueuedPrompts: dispatchStats.providerDispatchQueuedPrompts,
          },
          endpointAvailability,
          failures: failedRequestSummary,
          inFlight: requestRuntimeStats.inFlight,
          lifecycle: dispatchTelemetry.lifecycle,
          lifecycleCounters,
          liveLlmCalls: requestRuntimeStats.inFlight,
          providerTelemetry: dispatchTelemetry.provider,
          requestSlotWaiters: requestRuntimeStats.requestSlotWaiters,
          requestWorkBacklog: requestRuntimeStats.requestWorkBacklog,
          telemetrySource: dispatchTelemetry.source,
          waitingForRequestSlot: requestRuntimeStats.waitingForRequestSlot,
          attempts: Number(totalTokenUsage[0]?.totalRequests || 0) + requestRuntimeStats.pendingPersistedAttempts,
        },
      }
    },
    request,
  })
}
