import {and, desc, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {getSGLangMetrics} from './judgmentsJobsAdjustBatchSize/getSGLangMetrics.ts'

const ema = (prev: number | null | undefined, cur: number, alpha: number): number => {
  return prev == null ? cur : alpha * cur + (1 - alpha) * prev
}

const getLatestStatus = async (
  db: PostgresJsDatabase<typeof schema>,
  engine: 'vllm' | 'sglang',
  instanceId: string,
  modelName: string,
) => {
  const rows = await db
    .select()
    .from(schema.llmStatus)
    .where(
      and(
        eq(schema.llmStatus.engine, engine),
        eq(schema.llmStatus.instanceId, instanceId),
        eq(schema.llmStatus.modelName, modelName),
      ),
    )
    .orderBy(desc(schema.llmStatus.ts))
    .limit(1)
  return rows[0]
}

const computeTps = (
  prev: {prefill: number; gen: number; success: number; ts: Date} | undefined,
  now: {prefill: number; gen: number; success: number; ts: Date},
) => {
  const dtMs = prev ? now.ts.getTime() - prev.ts.getTime() : 0
  const dt = dtMs > 0 ? dtMs / 1000 : 0
  const prefill = dt > 0 ? Math.max(0, now.prefill - (prev?.prefill ?? 0)) / dt : 0
  const gen = dt > 0 ? Math.max(0, now.gen - (prev?.gen ?? 0)) / dt : 0
  const rps = dt > 0 ? Math.max(0, now.success - (prev?.success ?? 0)) / dt : 0
  return {prefill, gen, rps, dtMs}
}

const smallQueue = (waiting: number, running: number): boolean => {
  const thr = Math.max(1, Math.ceil(0.05 * running))
  return waiting <= thr
}

const safetyTriggered = (waiting: number, running: number): boolean => {
  const thr = Math.max(1, Math.ceil(0.15 * running))
  return waiting > 4 * thr
}

const normalizeWorkerUrls = (urls: string[] | null | undefined): string[] => {
  return Array.from(
    new Set(
      (urls ?? [])
        .map((url) => {
          return url.trim()
        })
        .filter((url) => {
          return url.length > 0
        }),
    ),
  )
}

const mergeWorkerLists = (existing: string[], incoming: string[]): string[] => {
  return Array.from(new Set([...existing, ...incoming]))
}

const fallbackWorkerUrls = normalizeWorkerUrls(env.WORKER_URLS)

// Generic LLM status ingestion targeting the new llm_status table.
// Initially feeds engine='vllm' using the existing vLLM metrics adapter.
export const judgmentsJobsCheckLLMStatus = async (db: PostgresJsDatabase<typeof schema>) => {
  const runningJobConfigs = await db
    .select({modelName: schema.models.modelName, baseURL: schema.models.baseURL, workerUrls: schema.models.workerUrls})
    .from(schema.judgmentsJobs)
    .leftJoin(schema.projects, eq(schema.judgmentsJobs.projectId, schema.projects.id))
    .leftJoin(schema.models, eq(schema.projects.modelId, schema.models.id))
    .where(eq(schema.judgmentsJobs.status, 'running'))
  const validConfigs = runningJobConfigs.filter((r) => {
    return !!r.baseURL
  })
  const baseUrlToConfig = validConfigs.reduce((acc, cfg) => {
    const baseURL = String(cfg.baseURL)
    const workerUrls = normalizeWorkerUrls(cfg.workerUrls)
    const existing = acc.get(baseURL)
    const mergedWorkers = existing ? mergeWorkerLists(existing.workerUrls, workerUrls) : workerUrls
    const modelName = existing?.modelName ?? cfg.modelName ?? 'unknown'
    acc.set(baseURL, {modelName, workerUrls: mergedWorkers})
    return acc
  }, new Map<string, {modelName: string; workerUrls: string[]}>())
  if (baseUrlToConfig.size === 0) return

  for (const [baseURL, config] of baseUrlToConfig.entries()) {
    const preferredWorkers = config.workerUrls.length > 0 ? config.workerUrls : fallbackWorkerUrls
    const targetWorkers = (preferredWorkers.length > 0 ? preferredWorkers : [baseURL])
      .map((url) => {
        return url.trim()
      })
      .filter((url) => {
        return url.length > 0
      })
    if (targetWorkers.length === 0) continue
    const engine = 'sglang' as const
    const modelName = config.modelName

    for (const workerUrl of targetWorkers) {
      const instanceId = workerUrl
      const prev = await getLatestStatus(db, engine, instanceId, modelName)

      const m = await getSGLangMetrics(workerUrl)
      const promptTokensTotal = m.promptTokensTotal
      const generationTokensTotal = m.generationTokensTotal
      const numRequestsTotal = m.numRequestsTotal
      const numQueueReqs = m.numQueueReqs
      const numRunningReqs = m.numRunningReqs

      const {prefill, gen, rps, dtMs} = computeTps(
        prev
          ? {
              prefill: Number(prev.promptTokensTotal ?? 0),
              gen: Number(prev.generationTokensTotal ?? 0),
              success: Number(prev.numRequestsTotal ?? 0),
              ts: new Date(prev.ts),
            }
          : undefined,
        {prefill: promptTokensTotal, gen: generationTokensTotal, success: numRequestsTotal, ts: new Date()},
      )

      const alpha = 0.3
      const prefillTps = ema(prev?.prefillTps ?? null, prefill, alpha)
      const genTps = ema(prev?.genTps ?? null, gen, alpha)

      const wasSmall = smallQueue(numQueueReqs, numRunningReqs)

      const prevTargets = {gen: Number(prev?.targetGenTps ?? 0), prefill: Number(prev?.targetPrefillTps ?? 0)}
      const incGen = Math.max(prevTargets.gen, genTps * 1.08 + 50)
      const incPrefill = Math.max(prevTargets.prefill, prefillTps * 1.08 + 50)
      const decGen = prevTargets.gen * 0.85
      const decPrefill = prevTargets.prefill * 0.85
      const targetGenTps = wasSmall ? incGen : decGen
      const targetPrefillTps = wasSmall ? incPrefill : decPrefill

      const prevState = (() => {
        if (!prev?.lastAction) return {bestGen: 0}
        try {
          const parsed = JSON.parse(prev.lastAction) as unknown
          return typeof parsed === 'object'
            && parsed
            && 'bestGen' in parsed
            && typeof (parsed as {bestGen?: unknown}).bestGen === 'number'
            ? {bestGen: (parsed as {bestGen: number}).bestGen}
            : {bestGen: 0}
        } catch (_e) {
          return {bestGen: 0}
        }
      })()

      const bestGenDecay = Math.max(0, prevState.bestGen * 0.98)
      const bestGen = Math.max(bestGenDecay, genTps)
      const plateauGen = 0.92 * bestGen
      const targetGenFinal = Math.max(targetGenTps, plateauGen)
      const targetPrefillFinal = targetPrefillTps

      const isUnsafe = safetyTriggered(numQueueReqs, numRunningReqs)
      const tGen = isUnsafe ? targetGenFinal * 0.6 : targetGenFinal
      const tPre = isUnsafe ? targetPrefillFinal * 0.6 : targetPrefillFinal

      const inFlight = numQueueReqs + numRunningReqs
      // Show per-worker limit (not total across all workers) for accurate per-instance display
      const maxInFlight = getJudgmentsCapacity(1).perWorkerMaxInflightRequests

      // Log when SGLang queue is high - helps diagnose capacity overflow
      if (inFlight > maxInFlight * 0.9) {
        console.warn('[llm-status] Worker queue high:', {
          worker: instanceId,
          sglangQueue: inFlight,
          perWorkerLimit: maxInFlight,
          waiting: numQueueReqs,
          running: numRunningReqs,
        })
      }

      const llmStatusData = {
        engine,
        instanceId,
        modelName,
        engineVersion: null,
        gpuType: null,
        gpuCount: null,
        pollMs: dtMs || 2000,
        promptTokensTotal,
        generationTokensTotal,
        numRequestsTotal,
        cachedTokensTotal: m.cachedTokensTotal,
        numRetractionsCount: m.numRetractionsCount,
        numQueueReqs,
        numRunningReqs,
        numGrammarQueueReqs: m.numGrammarQueueReqs,
        numRunningReqsOfflineBatch: m.numRunningReqsOfflineBatch,
        numPrefillPreallocQueueReqs: m.numPrefillPreallocQueueReqs,
        numPrefillInflightQueueReqs: m.numPrefillInflightQueueReqs,
        numDecodePreallocQueueReqs: m.numDecodePreallocQueueReqs,
        numDecodeTransferQueueReqs: m.numDecodeTransferQueueReqs,
        genThroughput: m.genThroughput,
        tokenUsage: m.tokenUsage,
        utilization: m.utilization,
        cacheHitRate: m.cacheHitRate,
        specAcceptRate: m.specAcceptRate,
        specAcceptLength: m.specAcceptLength,
        isCudaGraph: m.isCudaGraph ?? null,
        swaTokenUsage: m.swaTokenUsage,
        mambaUsage: m.mambaUsage,
        pendingPreallocTokenUsage: m.pendingPreallocTokenUsage,
        kvTransferSpeedGbS: m.kvTransferSpeedGbS,
        kvTransferLatencyMs: m.kvTransferLatencyMs,
        kvTransferBootstrapMs: m.kvTransferBootstrapMs,
        kvTransferAllocMs: m.kvTransferAllocMs,
        prefillTps,
        genTps,
        rps,
        targetGenTps: tGen,
        targetPrefillTps: tPre,
        inFlight,
        maxInFlight,
        timeToFirstTokenSeconds: m.timeToFirstTokenSeconds ?? null,
        e2eRequestLatencySeconds: m.e2eRequestLatencySeconds ?? null,
        interTokenLatencySeconds: m.interTokenLatencySeconds ?? null,
        perStageReqLatencySeconds: m.perStageReqLatencySeconds ?? null,
        queueTimeSeconds: m.queueTimeSeconds ?? null,
      }

      await db.insert(schema.llmStatus).values(llmStatusData)
    }
  }
}
