import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import type {DuckdbWorkloadContext} from '../../../utils/duckdbService.ts'
import {buildLlmStatusResponse} from './buildLlmStatusResponse.ts'
import type {LlmStatusResponseBody, LlmStatusRow} from './llmStatusTypes.ts'

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

type MetricsCompatibleSourceState = {hasMetricsCompatibleJob: boolean; hasMetricsCompatibleRuntime: boolean}

const getMetricsCompatibleSourceState = async (): Promise<MetricsCompatibleSourceState> => {
  const [jobRows, runtimeRows] = await Promise.all([
    getAppDatabaseService().queryJson<{count: number}>(
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
    ),
    getAppDatabaseService().queryJson<{count: number}>(
      `
      SELECT COUNT(*) AS count
      FROM app.provider_connection pc
      WHERE COALESCE(pc.enabled, TRUE) = TRUE
        AND LOWER(TRIM(COALESCE(pc.provider_kind, ''))) IN (${metricsCompatibleProviderKinds
          .map((k) => {
            return `'${k}'`
          })
          .join(', ')})
    `,
      llmStatusSingleRowWorkloadContext,
    ),
  ])

  return {
    hasMetricsCompatibleJob: (jobRows[0]?.count ?? 0) > 0,
    hasMetricsCompatibleRuntime: (runtimeRows[0]?.count ?? 0) > 0,
  }
}

export const readLlmStatus = async (): Promise<LlmStatusResponseBody> => {
  const sourceState = await getMetricsCompatibleSourceState()

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
    return buildLlmStatusResponse({...sourceState, data: [], tableExists: false})
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

  return buildLlmStatusResponse({...sourceState, data, tableExists: true})
}
