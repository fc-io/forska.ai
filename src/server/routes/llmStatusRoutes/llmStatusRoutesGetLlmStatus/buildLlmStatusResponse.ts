import {
  type CronRuntimeClassState,
  cronRuntimeTickNames,
  getCronRuntimeDiagnostics,
} from '../../../cron/cronRuntimeState.ts'
import {getDateValue} from '../../../services/appQueryHelpers.ts'
import type {
  LlmStatusCronMetadata,
  LlmStatusResponseBody,
  LlmStatusRow,
  LlmStatusStaleReason,
} from './llmStatusTypes.ts'

const llmStatusStaleAfterMs = 3 * 60 * 1000

const getLatestIngestedAt = (rows: LlmStatusRow[]) => {
  const latestTimestampMs = rows.reduce<number | null>((latest, row) => {
    const timestamp = getDateValue(row.ts)?.getTime() ?? null

    return timestamp === null ? latest : Math.max(latest ?? timestamp, timestamp)
  }, null)

  return latestTimestampMs === null ? null : new Date(latestTimestampMs)
}

const getLlmStatusCronMetadata = (): LlmStatusCronMetadata => {
  const cronRuntime = getCronRuntimeDiagnostics()

  return {
    duckdbMemoryLimit: cronRuntime.duckdbMemoryLimit,
    duckdbMemoryLimitMiB: cronRuntime.duckdbMemoryLimitMiB,
    heavyMaintenanceCrons: cronRuntime.heavyMaintenanceCrons,
    llmStatusIngestionCron: cronRuntime.crons[cronRuntimeTickNames.checkLlmStatus],
    lowMemoryOwner: cronRuntime.lowMemoryOwner,
    lowMemoryThresholdMiB: cronRuntime.lowMemoryThresholdMiB,
    operationalJudgmentCrons: cronRuntime.operationalJudgmentCrons,
    serverRole: cronRuntime.serverRole,
  }
}

const getInactiveIngestionReason = (operationalJudgmentCrons: CronRuntimeClassState): LlmStatusStaleReason | null => {
  if (operationalJudgmentCrons.active) {
    return null
  }

  return operationalJudgmentCrons.reason === 'deferred-low-memory-owner'
    ? 'ingestion-cron-deferred'
    : 'ingestion-cron-inactive'
}

const getLlmStatusStaleReason = ({
  cron,
  hasMetricsCompatibleJob,
  hasMetricsCompatibleRuntime,
  latestIngestedAgeMs,
  latestIngestedAt,
  tableExists,
}: {
  cron: LlmStatusCronMetadata
  hasMetricsCompatibleJob: boolean
  hasMetricsCompatibleRuntime: boolean
  latestIngestedAgeMs: number | null
  latestIngestedAt: Date | null
  tableExists: boolean | null
}): LlmStatusStaleReason | null => {
  const hasMetricsCompatibleSource = hasMetricsCompatibleJob || hasMetricsCompatibleRuntime
  const shouldExplainIngestionState = hasMetricsCompatibleSource || latestIngestedAt !== null
  const inactiveReason = shouldExplainIngestionState ? getInactiveIngestionReason(cron.operationalJudgmentCrons) : null

  if (inactiveReason !== null) {
    return inactiveReason
  }

  if (hasMetricsCompatibleSource && tableExists === false) {
    return 'llm-status-table-missing'
  }

  if (hasMetricsCompatibleSource && latestIngestedAt === null) {
    return 'no-ingested-rows'
  }

  return latestIngestedAgeMs !== null && latestIngestedAgeMs > llmStatusStaleAfterMs ? 'latest-row-stale' : null
}

const getLlmStatusStaleMessage = ({
  cron,
  hasMetricsCompatibleJob,
  hasMetricsCompatibleRuntime,
  latestIngestedAt,
  staleReason,
}: {
  cron: LlmStatusCronMetadata
  hasMetricsCompatibleJob: boolean
  hasMetricsCompatibleRuntime: boolean
  latestIngestedAt: Date | null
  staleReason: LlmStatusStaleReason | null
}) => {
  if (staleReason === null) {
    return null
  }

  if (staleReason === 'ingestion-cron-deferred') {
    return `Ingestion cron deferred: ${cron.operationalJudgmentCrons.reason ?? 'unknown reason'}.`
  }

  if (staleReason === 'ingestion-cron-inactive') {
    return `Ingestion cron inactive: ${cron.operationalJudgmentCrons.reason ?? 'unknown reason'}.`
  }

  if (staleReason === 'llm-status-table-missing') {
    return hasMetricsCompatibleJob
      ? 'Metrics-compatible job is running, but app.llm_status is unavailable.'
      : 'Enabled SGLang runtime source exists, but app.llm_status is unavailable.'
  }

  if (staleReason === 'no-ingested-rows') {
    return hasMetricsCompatibleJob
      ? 'Metrics-compatible job is running, but no SGLang status rows have been ingested.'
      : 'Enabled SGLang runtime source exists, but no SGLang status rows have been ingested.'
  }

  if (latestIngestedAt === null) {
    return 'Latest SGLang status row is stale.'
  }

  if (hasMetricsCompatibleRuntime && !hasMetricsCompatibleJob) {
    return `Latest SGLang status row was ingested at ${latestIngestedAt.toISOString()}. An enabled SGLang runtime source exists, so ingestion may be failing to sample /metrics.`
  }

  if (!hasMetricsCompatibleRuntime && !hasMetricsCompatibleJob) {
    return `Latest SGLang status row was ingested at ${latestIngestedAt.toISOString()}, and no enabled SGLang metrics source is currently available.`
  }

  return `Latest SGLang status row was ingested at ${latestIngestedAt.toISOString()}.`
}

export const buildLlmStatusResponse = ({
  data,
  hasMetricsCompatibleJob,
  hasMetricsCompatibleRuntime,
  tableExists,
}: {
  data: LlmStatusRow[]
  hasMetricsCompatibleJob: boolean
  hasMetricsCompatibleRuntime: boolean
  tableExists: boolean | null
}): LlmStatusResponseBody => {
  const generatedAt = new Date()
  const latestIngestedAt = getLatestIngestedAt(data)
  const latestIngestedAgeMs =
    latestIngestedAt === null ? null : Math.max(0, generatedAt.getTime() - latestIngestedAt.getTime())
  const cron = getLlmStatusCronMetadata()
  const staleReason = getLlmStatusStaleReason({
    cron,
    hasMetricsCompatibleJob,
    hasMetricsCompatibleRuntime,
    latestIngestedAgeMs,
    latestIngestedAt,
    tableExists,
  })

  return {
    data,
    hasMetricsCompatibleJob,
    hasMetricsCompatibleRuntime,
    metadata: {
      cron,
      generatedAt: generatedAt.toISOString(),
      isStale: staleReason !== null,
      latestIngestedAgeMs,
      latestIngestedAt: latestIngestedAt?.toISOString() ?? null,
      staleAfterMs: llmStatusStaleAfterMs,
      staleMessage: getLlmStatusStaleMessage({
        cron,
        hasMetricsCompatibleJob,
        hasMetricsCompatibleRuntime,
        latestIngestedAt,
        staleReason,
      }),
      staleReason,
      tableExists,
    },
  }
}
