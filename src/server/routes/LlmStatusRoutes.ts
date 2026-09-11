import {Elysia} from 'elysia'

import {
  type CronRuntimeClassState,
  cronRuntimeTickNames,
  type CronRuntimeTickState,
  getCronRuntimeDiagnostics,
} from '../cron/cronRuntimeState.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getDateValue} from '../services/appQueryHelpers.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

const metricsCompatibleProviderKinds = ['sglang']
const llmStatusRowsLimit = 50
const llmStatusRouteWorkloadContext: DuckdbWorkloadContext = {
  fallbackIntent: 'serveStale',
  routeOrJobKey: 'llmStatus.route',
  workloadClass: 'foreground-diagnostic',
}
const llmStatusSingleRowWorkloadContext: DuckdbWorkloadContext = {...llmStatusRouteWorkloadContext, maxResultRows: 1}
const llmStatusRowsWorkloadContext: DuckdbWorkloadContext = {
  ...llmStatusRouteWorkloadContext,
  maxResultRows: llmStatusRowsLimit,
}
const llmStatusForegroundBudgetMs = 2500
const llmStatusStaleAfterMs = 3 * 60 * 1000

type LlmStatusRow = {
  ts: string
  instanceId: string
  modelName: string
  engineVersion: string | null
  prefillTps: number | null
  genTps: number | null
  rps: number | null
  numQueueReqs: number | null
  numRunningReqs: number | null
  numGrammarQueueReqs: number | null
  numRunningReqsOfflineBatch: number | null
  numPrefillPreallocQueueReqs: number | null
  numPrefillInflightQueueReqs: number | null
  numDecodePreallocQueueReqs: number | null
  numDecodeTransferQueueReqs: number | null
  utilization: number | null
  cacheHitRate: number | null
  inFlight: number | null
  maxInFlight: number | null
}

type LlmStatusStaleReason =
  | 'ingestion-cron-deferred'
  | 'ingestion-cron-inactive'
  | 'latest-row-stale'
  | 'llm-status-table-missing'
  | 'no-ingested-rows'

type LlmStatusCronMetadata = {
  duckdbMemoryLimit: string | null
  duckdbMemoryLimitMiB: number | null
  heavyMaintenanceCrons: CronRuntimeClassState
  llmStatusIngestionCron: CronRuntimeTickState
  lowMemoryOwner: boolean
  lowMemoryThresholdMiB: number
  operationalJudgmentCrons: CronRuntimeClassState
  serverRole: string
}

type LlmStatusResponseMetadata = {
  cron: LlmStatusCronMetadata
  generatedAt: string
  isStale: boolean
  latestIngestedAgeMs: number | null
  latestIngestedAt: string | null
  staleAfterMs: number
  staleMessage: string | null
  staleReason: LlmStatusStaleReason | null
  tableExists: boolean | null
}

type LlmStatusResponseBody = {
  data: LlmStatusRow[]
  hasMetricsCompatibleJob: boolean
  metadata: LlmStatusResponseMetadata
}

let cachedLlmStatus: LlmStatusResponseBody | null = null
let pendingLlmStatusRefresh: Promise<LlmStatusResponseBody> | null = null

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> => {
  let timeout: ReturnType<typeof setTimeout> | null = null

  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      resolve(null)
    }, timeoutMs)
  })

  const result = await Promise.race([promise, timeoutPromise])

  if (timeout !== null) {
    clearTimeout(timeout)
  }

  return result
}

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
  latestIngestedAgeMs,
  latestIngestedAt,
  tableExists,
}: {
  cron: LlmStatusCronMetadata
  hasMetricsCompatibleJob: boolean
  latestIngestedAgeMs: number | null
  latestIngestedAt: Date | null
  tableExists: boolean | null
}): LlmStatusStaleReason | null => {
  const shouldExplainIngestionState = hasMetricsCompatibleJob || latestIngestedAt !== null
  const inactiveReason = shouldExplainIngestionState ? getInactiveIngestionReason(cron.operationalJudgmentCrons) : null

  if (inactiveReason !== null) {
    return inactiveReason
  }

  if (hasMetricsCompatibleJob && tableExists === false) {
    return 'llm-status-table-missing'
  }

  if (hasMetricsCompatibleJob && latestIngestedAt === null) {
    return 'no-ingested-rows'
  }

  return latestIngestedAgeMs !== null && latestIngestedAgeMs > llmStatusStaleAfterMs ? 'latest-row-stale' : null
}

const getLlmStatusStaleMessage = ({
  cron,
  latestIngestedAt,
  staleReason,
}: {
  cron: LlmStatusCronMetadata
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
    return 'Metrics-compatible job is running, but app.llm_status is unavailable.'
  }

  if (staleReason === 'no-ingested-rows') {
    return 'Metrics-compatible job is running, but no SGLang status rows have been ingested.'
  }

  return latestIngestedAt === null
    ? 'Latest SGLang status row is stale.'
    : `Latest SGLang status row was ingested at ${latestIngestedAt.toISOString()}.`
}

const buildLlmStatusResponse = ({
  data,
  hasMetricsCompatibleJob,
  tableExists,
}: {
  data: LlmStatusRow[]
  hasMetricsCompatibleJob: boolean
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
    latestIngestedAgeMs,
    latestIngestedAt,
    tableExists,
  })

  return {
    data,
    hasMetricsCompatibleJob,
    metadata: {
      cron,
      generatedAt: generatedAt.toISOString(),
      isStale: staleReason !== null,
      latestIngestedAgeMs,
      latestIngestedAt: latestIngestedAt?.toISOString() ?? null,
      staleAfterMs: llmStatusStaleAfterMs,
      staleMessage: getLlmStatusStaleMessage({cron, latestIngestedAt, staleReason}),
      staleReason,
      tableExists,
    },
  }
}

const refreshLlmStatusMetadata = (status: LlmStatusResponseBody) => {
  return buildLlmStatusResponse({
    data: status.data,
    hasMetricsCompatibleJob: status.hasMetricsCompatibleJob,
    tableExists: status.metadata.tableExists,
  })
}

const hasMetricsCompatibleRunningJob = async (): Promise<boolean> => {
  const rows = await getAppDatabaseService().queryJson<{count: number}>(
    `
    SELECT COUNT(*) AS count
    FROM app.judgment_job jj
    INNER JOIN app.project p ON jj.project_id = p.id
    INNER JOIN app.model m ON p.model_id = m.id
    INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE jj.status = 'running'
      AND LOWER(TRIM(COALESCE(pc.provider_kind, ''))) IN (${metricsCompatibleProviderKinds
        .map((k) => {
          return `'${k}'`
        })
        .join(', ')})
  `,
    llmStatusSingleRowWorkloadContext,
  )
  return (rows[0]?.count ?? 0) > 0
}

const readLlmStatus = async (): Promise<LlmStatusResponseBody> => {
  const hasCompatibleJob = await hasMetricsCompatibleRunningJob()

  const [tableRow] = await getAppDatabaseService().queryJson<{tableName: string}>(
    `
    SELECT table_name AS tableName
    FROM information_schema.tables
    WHERE table_schema = 'app'
      AND table_name = 'llm_status'
    LIMIT 1
  `,
    llmStatusSingleRowWorkloadContext,
  )

  if (!tableRow) {
    return buildLlmStatusResponse({data: [], hasMetricsCompatibleJob: hasCompatibleJob, tableExists: false})
  }

  const data = await getAppDatabaseService().queryJson<LlmStatusRow>(
    `
    SELECT
      ts,
      instance_id AS instanceId,
      model_name AS modelName,
      engine_version AS engineVersion,
      prefill_tps AS prefillTps,
      gen_tps AS genTps,
      rps,
      num_queue_reqs AS numQueueReqs,
      num_running_reqs AS numRunningReqs,
      num_grammar_queue_reqs AS numGrammarQueueReqs,
      num_running_reqs_offline_batch AS numRunningReqsOfflineBatch,
      num_prefill_prealloc_queue_reqs AS numPrefillPreallocQueueReqs,
      num_prefill_inflight_queue_reqs AS numPrefillInflightQueueReqs,
      num_decode_prealloc_queue_reqs AS numDecodePreallocQueueReqs,
      num_decode_transfer_queue_reqs AS numDecodeTransferQueueReqs,
      utilization,
      cache_hit_rate AS cacheHitRate,
      in_flight AS inFlight,
      max_in_flight AS maxInFlight
    FROM app.llm_status
    WHERE engine = 'sglang'
    ORDER BY ts DESC
    LIMIT ${llmStatusRowsLimit}
  `,
    llmStatusRowsWorkloadContext,
  )

  return buildLlmStatusResponse({data, hasMetricsCompatibleJob: hasCompatibleJob, tableExists: true})
}

const refreshLlmStatus = async () => {
  pendingLlmStatusRefresh ??= readLlmStatus()
    .then((status) => {
      cachedLlmStatus = status
      return status
    })
    .finally(() => {
      pendingLlmStatusRefresh = null
    })

  return pendingLlmStatusRefresh
}

export const __resetLlmStatusCacheForTests = () => {
  cachedLlmStatus = null
  pendingLlmStatusRefresh = null
}

export const llmStatusRoutes = new Elysia().use(withErrorHandler()).get('/api/llmstatus', async () => {
  if (cachedLlmStatus !== null) {
    void refreshLlmStatus().catch(() => {})
    return refreshLlmStatusMetadata(cachedLlmStatus)
  }

  const status = await withTimeout(refreshLlmStatus(), llmStatusForegroundBudgetMs)

  return status ?? buildLlmStatusResponse({data: [], hasMetricsCompatibleJob: false, tableExists: null})
})
