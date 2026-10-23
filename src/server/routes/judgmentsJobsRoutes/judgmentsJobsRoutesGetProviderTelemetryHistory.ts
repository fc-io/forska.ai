import {getJudgmentProviderTelemetryProviderSnapshot} from '../../cron/judgmentsJobs/judgmentProviderTelemetrySnapshot.ts'
import {getProviderConnectionForStoredModel} from '../../providers/providerConnectionRepository.ts'
import {
  type JudgmentProviderTelemetryBucketedHistory,
  queryJudgmentProviderTelemetryBucketedHistory,
} from '../../services/judgmentProviderTelemetryHistoryService.ts'
import {getJobContext} from './getJobContext.ts'
import {getJudgmentJobsReadDatabase} from './getJudgmentJobsReadDatabase.ts'
import {runJudgmentJobsRead} from './runJudgmentJobsRead.ts'

const getTelemetryHistoryRoutePayload = (history: JudgmentProviderTelemetryBucketedHistory) => {
  return {
    bucketSizeSeconds: history.bucketSizeSeconds,
    buckets: history.buckets.map((bucket) => {
      return {...bucket, bucketEnd: bucket.bucketEnd.toISOString(), bucketStart: bucket.bucketStart.toISOString()}
    }),
    providerKey: history.providerKey,
    rangeEnd: history.rangeEnd.toISOString(),
    rangeStart: history.rangeStart.toISOString(),
  }
}

const getTrimmedProviderKey = (value: string | undefined) => {
  const trimmed = value?.trim() ?? ''

  return trimmed.length > 0 ? trimmed : null
}

export const judgmentsJobsRoutesGetProviderTelemetryHistory = async ({
  query,
  request,
}: {
  query: {jobId: string; providerKey?: string; range: '5m' | '15m' | '1h' | '24h' | '3d'}
  request: Request
}) => {
  return runJudgmentJobsRead({
    operation: async () => {
      const db = getJudgmentJobsReadDatabase()
      const {job, projectModelId} = await getJobContext({db, jobId: query.jobId})
      const requestedProviderKey = getTrimmedProviderKey(query.providerKey)
      const providerKey = requestedProviderKey
        ? requestedProviderKey
        : getJudgmentProviderTelemetryProviderSnapshot({
            job: {id: job.id, modelId: projectModelId},
            providerConnection: await getProviderConnectionForStoredModel(projectModelId, db),
          }).providerKey
      const history = await queryJudgmentProviderTelemetryBucketedHistory({
        jobId: job.id,
        providerKey,
        range: query.range,
        runner: db,
      })

      return getTelemetryHistoryRoutePayload(history)
    },
    request,
  })
}
