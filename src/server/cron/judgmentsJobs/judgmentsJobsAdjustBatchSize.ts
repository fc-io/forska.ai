import {and, desc, eq, inArray} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'

type PromValue = number
type PromSample = {name: string; labels: Record<string, string>; value: PromValue}

const parsePrometheusText = (text: string): PromSample[] => {
  const lines = text.split(/\n+/)
  const parse = (line: string): PromSample | undefined => {
    if (!line || line.startsWith('#')) return undefined
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/)
    if (!m) return undefined
    const [, name, labelStr, valStr] = m
    const labels: Record<string, string> = !labelStr
      ? {}
      : Object.fromEntries(
          labelStr
            .slice(1, -1)
            .split(',')
            .filter(Boolean)
            .map((kv) => {
              const idx = kv.indexOf('=')
              const k = kv.slice(0, idx)
              const v = kv.slice(idx + 1).replace(/^"|"$/g, '')
              return [k, v]
            }),
        )
    const value = Number(valStr)
    return Number.isFinite(value) ? {name, labels, value} : undefined
  }
  return lines.map(parse).filter(Boolean) as PromSample[]
}

const sumByName = (samples: PromSample[], names: string[]): number => {
  const set = new Set(names)
  return samples.reduce((acc, s) => {
    return set.has(s.name) ? acc + s.value : acc
  }, 0)
}

const maxByName = (samples: PromSample[], names: string[]): number => {
  const set = new Set(names)
  let max = 0
  for (const s of samples) if (set.has(s.name) && s.value > max) max = s.value
  return max
}

const pickOne = (samples: PromSample[], names: string[], def = 0): number => {
  for (const n of names) {
    const s = samples.find((x) => {
      return x.name === n
    })
    if (s) return s.value
  }
  return def
}

const clamp = (lo: number, hi: number, v: number): number => {
  return Math.min(hi, Math.max(lo, v))
}

const ema = (prev: number | null | undefined, cur: number, alpha: number): number => {
  return prev == null ? cur : alpha * cur + (1 - alpha) * prev
}

const getLatestStatus = async (db: PostgresJsDatabase<typeof schema>, instanceId: string, modelName: string) => {
  const rows = await db
    .select()
    .from(schema.vllmStatus)
    .where(and(eq(schema.vllmStatus.instanceId, instanceId), eq(schema.vllmStatus.modelName, modelName)))
    .orderBy(desc(schema.vllmStatus.ts))
    .limit(1)
  return rows[0]
}

const computeTps = (
  prev: {prompt: number; gen: number; success: number; ts: Date} | undefined,
  now: {prompt: number; gen: number; success: number; ts: Date},
) => {
  const dtMs = prev ? now.ts.getTime() - prev.ts.getTime() : 0
  const dt = dtMs > 0 ? dtMs / 1000 : 0
  const prefill = dt > 0 ? Math.max(0, now.prompt - (prev?.prompt ?? 0)) / dt : 0
  const gen = dt > 0 ? Math.max(0, now.gen - (prev?.gen ?? 0)) / dt : 0
  const rps = dt > 0 ? Math.max(0, now.success - (prev?.success ?? 0)) / dt : 0
  return {prefill, gen, rps, dtMs}
}

const smallQueue = (waiting: number, running: number): boolean => {
  const thr = Math.max(1, Math.ceil(0.15 * running))
  return waiting <= thr
}

const safetyTriggered = (
  waiting: number,
  running: number,
  gpuCache: number,
  swapped: number | null | undefined,
): boolean => {
  const thr = Math.max(1, Math.ceil(0.15 * running))
  return waiting > 4 * thr || (Number.isFinite(gpuCache) && gpuCache > 0.95) || (swapped ?? 0) > 0
}

const computeAdmission = (genTpsEma: number, targetGenTps: number, running: number, waiting: number) => {
  const inFlight = waiting + running
  const maxInFlight = clamp(64, 4096, Math.round(running * 6))
  const headroom = Math.max(0, maxInFlight - inFlight)
  const perReqGenTps = running > 0 ? genTpsEma / running : 20
  const effPerReq = perReqGenTps > 1 ? perReqGenTps : 20
  const tpsHeadroom = Math.max(0, targetGenTps - genTpsEma)
  const needForTps = Math.ceil(tpsHeadroom / effPerReq)
  const admit = Math.max(0, Math.min(headroom, needForTps))
  return {admit, inFlight, maxInFlight}
}

const toJSON = (data: unknown): string => {
  try {
    return JSON.stringify(data)
  } catch (_e) {
    return ''
  }
}

export const judgmentsJobsAdjustBatchSize = async (db: PostgresJsDatabase<typeof schema>) => {
  const jobs = await db
    .select({
      id: schema.judgmentsJobs.id,
      sendToLLMBatchSize: schema.judgmentsJobs.sendToLLMBatchSize,
      sendToLLMInterval: schema.judgmentsJobs.sendToLLMInterval,
    })
    .from(schema.judgmentsJobs)
  const vllmMetricsUrl = 'http://localhost:8000' + '/metrics'

  const res = await fetch(vllmMetricsUrl).catch(() => {
    return undefined
  })
  if (!res || !res.ok) return
  const text = await res.text()
  const samples = parsePrometheusText(text)

  const nowTs = new Date()
  const instanceId = env.VITE_LLM_SERVER_URL
  const modelName = 'unknown'

  const promptTokensTotal = Math.floor(sumByName(samples, ['vllm:prompt_tokens_total', 'vllm_prompt_tokens_total']))
  const generationTokensTotal = Math.floor(
    sumByName(samples, ['vllm:generation_tokens_total', 'vllm_generated_tokens_total']),
  )
  const requestSuccessTotal = Math.floor(sumByName(samples, ['vllm:request_success_total']))
  const requestErrorTotal = Math.floor(sumByName(samples, ['vllm:request_error_total']))
  const numPreemptionsTotal = Math.floor(sumByName(samples, ['vllm:num_preemptions_total']))

  const numRequestsWaiting = Math.floor(pickOne(samples, ['vllm:num_requests_waiting']))
  const numRequestsRunning = Math.floor(pickOne(samples, ['vllm:num_requests_running']))
  const numRequestsSwapped = Math.floor(pickOne(samples, ['vllm:num_requests_swapped'], 0))
  const gpuCacheUsagePerc = maxByName(samples, ['vllm:gpu_cache_usage_ratio', 'vllm:gpu_cache_usage_perc'])

  const prev = await getLatestStatus(db, instanceId, modelName)
  const {prefill, gen, rps, dtMs} = computeTps(
    prev
      ? {
          prompt: Number(prev.promptTokensTotal ?? 0),
          gen: Number(prev.generationTokensTotal ?? 0),
          success: Number(prev.requestSuccessTotal ?? 0),
          ts: new Date(prev.ts),
        }
      : undefined,
    {prompt: promptTokensTotal, gen: generationTokensTotal, success: requestSuccessTotal, ts: nowTs},
  )

  const alpha = 0.3
  const prefillTps = ema(prev?.prefillTps ?? null, prefill, alpha)
  const genTps = ema(prev?.genTps ?? null, gen, alpha)

  const wasSmall = smallQueue(numRequestsWaiting, numRequestsRunning)

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
      const parsed = JSON.parse(prev.lastAction)
      return typeof parsed === 'object' && parsed ? parsed : {bestGen: 0}
    } catch (_e) {
      return {bestGen: 0}
    }
  })() as {bestGen: number}

  const bestGenDecay = Math.max(0, prevState.bestGen * 0.98)
  const bestGen = Math.max(bestGenDecay, genTps)
  const plateauGen = 0.92 * bestGen
  const targetGenFinal = Math.max(targetGenTps, plateauGen)
  const targetPrefillFinal = targetPrefillTps

  const isUnsafe = safetyTriggered(
    numRequestsWaiting,
    numRequestsRunning,
    Number.isFinite(gpuCacheUsagePerc) ? gpuCacheUsagePerc : 0,
    Number.isFinite(numRequestsSwapped) ? numRequestsSwapped : 0,
  )
  const tGen = isUnsafe ? targetGenFinal * 0.6 : targetGenFinal
  const tPre = isUnsafe ? targetPrefillFinal * 0.6 : targetPrefillFinal

  const {admit, inFlight, maxInFlight} = computeAdmission(genTps, tGen, numRequestsRunning, numRequestsWaiting)

  const jobCount = Math.max(1, jobs.length)
  const suggestedPerJob = Math.max(1, Math.round(admit / jobCount))
  const boundedPerJob = clamp(1, 512, suggestedPerJob)

  const jobIds = jobs.map((j) => {
    return j.id
  })
  if (jobIds.length > 0) {
    await db
      .update(schema.judgmentsJobs)
      .set({sendToLLMBatchSize: boundedPerJob})
      .where(inArray(schema.judgmentsJobs.id, jobIds))
  }

  await db
    .insert(schema.vllmStatus)
    .values({
      instanceId,
      modelName,
      vllmVersion: null,
      gpuType: null,
      gpuCount: null,
      pollMs: dtMs || 2000,
      promptTokensTotal,
      generationTokensTotal,
      requestSuccessTotal,
      requestErrorTotal,
      numPreemptionsTotal,
      numRequestsWaiting,
      numRequestsRunning,
      gpuCacheUsagePerc,
      numRequestsSwapped,
      prefillTps,
      genTps,
      impliedRps: rps,
      targetGenTps: tGen,
      targetPrefillTps: tPre,
      inFlight,
      maxInFlight,
      lastAction: toJSON({bestGen, smallQueue: wasSmall, safety: isUnsafe, admit, perJob: boundedPerJob}),
      e2eLatency: null,
      ttftLatency: null,
      itlLatency: null,
    })
}

export const registerCooldownEvent = (_reason: string): void => {
  // Hook for external callers; keep lightweight to avoid side-effects
}
