import {desc, eq} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {llmStatus} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const llmStatusRoutes = new Elysia().use(withErrorHandler()).get('/api/llmstatus', async () => {
  const db = getDatabase()
  const data = await db
    .select({
      ts: llmStatus.ts,
      instanceId: llmStatus.instanceId,
      modelName: llmStatus.modelName,
      engineVersion: llmStatus.engineVersion,
      prefillTps: llmStatus.prefillTps,
      genTps: llmStatus.genTps,
      rps: llmStatus.rps,
      numQueueReqs: llmStatus.numQueueReqs,
      numRunningReqs: llmStatus.numRunningReqs,
      numGrammarQueueReqs: llmStatus.numGrammarQueueReqs,
      numRunningReqsOfflineBatch: llmStatus.numRunningReqsOfflineBatch,
      numPrefillPreallocQueueReqs: llmStatus.numPrefillPreallocQueueReqs,
      numPrefillInflightQueueReqs: llmStatus.numPrefillInflightQueueReqs,
      numDecodePreallocQueueReqs: llmStatus.numDecodePreallocQueueReqs,
      numDecodeTransferQueueReqs: llmStatus.numDecodeTransferQueueReqs,
      utilization: llmStatus.utilization,
      cacheHitRate: llmStatus.cacheHitRate,
      inFlight: llmStatus.inFlight,
      maxInFlight: llmStatus.maxInFlight,
    })
    .from(llmStatus)
    .where(eq(llmStatus.engine, 'sglang'))
    .orderBy(desc(llmStatus.ts))
    .limit(50)

  return {data}
})
