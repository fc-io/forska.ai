import {Elysia} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const llmStatusRoutes = new Elysia().use(withErrorHandler()).get('/api/llmstatus', async () => {
  const [tableRow] = await getAppDatabaseService().queryJson<{tableName: string}>(`
    SELECT table_name AS tableName
    FROM information_schema.tables
    WHERE table_schema = 'app'
      AND table_name = 'llm_status'
    LIMIT 1
  `)

  if (!tableRow) {
    return {data: []}
  }

  const data = await getAppDatabaseService().queryJson<{
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
  }>(`
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
    LIMIT 50
  `)

  return {data}
})
