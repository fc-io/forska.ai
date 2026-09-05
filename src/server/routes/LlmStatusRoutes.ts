import {Elysia} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
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

type LlmStatusResponseBody = {data: LlmStatusRow[]; hasMetricsCompatibleJob: boolean}

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
    return {data: [], hasMetricsCompatibleJob: hasCompatibleJob}
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

  return {data, hasMetricsCompatibleJob: hasCompatibleJob}
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
    return cachedLlmStatus
  }

  const status = await withTimeout(refreshLlmStatus(), llmStatusForegroundBudgetMs)

  return status ?? {data: [], hasMetricsCompatibleJob: false}
})
