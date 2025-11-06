import {and, desc, eq} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {getSGLangMetrics} from './judgmentsJobsAdjustBatchSize/getSGLangMetrics.ts'

const clamp = (lo: number, hi: number, v: number): number => {
  return Math.min(hi, Math.max(lo, v))
}

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

const toJSON = (data: unknown): string => {
  try {
    return JSON.stringify(data)
  } catch (_e) {
    return ''
  }
}

// Generic LLM status ingestion targeting the new llm_status table.
// Initially feeds engine='vllm' using the existing vLLM metrics adapter.
export const judgmentsJobsCheckLLMStatus = async (db: PostgresJsDatabase<typeof schema>) => {
  const runningJobConfigs = await db
    .select({modelName: schema.models.modelName, baseURL: schema.models.baseURL})
    .from(schema.judgmentsJobs)
    .leftJoin(schema.projects, eq(schema.judgmentsJobs.projectId, schema.projects.id))
    .leftJoin(schema.models, eq(schema.projects.modelId, schema.models.id))
    .where(eq(schema.judgmentsJobs.status, 'running'))

  const validConfigs = runningJobConfigs.filter((r) => {
    return !!r.baseURL
  })

  const baseUrlToModel = new Map<string, string>()
  for (const cfg of validConfigs) {
    const baseURL = String(cfg.baseURL)
    if (!baseUrlToModel.has(baseURL)) baseUrlToModel.set(baseURL, cfg.modelName ?? 'unknown')
  }

  const uniqueBaseUrls = [...baseUrlToModel.keys()]
  if (uniqueBaseUrls.length === 0) return

  for (const baseURL of uniqueBaseUrls) {
    const engine = 'sglang' as const
    const instanceId = baseURL
    const modelName = baseUrlToModel.get(baseURL) ?? 'unknown'
    const prev = await getLatestStatus(db, engine, instanceId, modelName)

    const m = await getSGLangMetrics(baseURL)
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
    const maxInFlight = clamp(64, 4096, Math.round(Math.max(rps, 1) * 60))

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
      lastAction: toJSON({bestGen, smallQueue: wasSmall, safety: isUnsafe}),
      timeToFirstTokenSeconds: m.timeToFirstTokenSeconds ?? null,
      e2eRequestLatencySeconds: m.e2eRequestLatencySeconds ?? null,
      interTokenLatencySeconds: m.interTokenLatencySeconds ?? null,
      perStageReqLatencySeconds: m.perStageReqLatencySeconds ?? null,
      queueTimeSeconds: m.queueTimeSeconds ?? null,
    }

    await db.insert(schema.llmStatus).values(llmStatusData)
  }
}
