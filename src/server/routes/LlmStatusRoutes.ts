import {desc, eq} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {auth} from '../../auth.ts'
import {llmStatus} from '../../db/schema.ts'
import {requireAdminAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const llmStatusRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireAdminAuth())
  .get('/api/llmstatus', async ({request, set}) => {
    const session = await auth.api.getSession({headers: request.headers})
    const role = session?.user?.role ?? null
    if (role !== 'admin') {
      set.status = 403
      return {data: null, error: 'Administrator access required'}
    }

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
