import {and, desc, eq, gte, inArray, lt, sum} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'
import {decideForWaiting, type NextDecision, waitingThreshold} from './judgmentsJobsAdjustBatchSize/decideForWaiting.ts'
import {getGPUMultiplier} from './judgmentsJobsAdjustBatchSize/getGPUMultiplier.ts'
import {getSecondHighestBatchSizeInHistory} from './judgmentsJobsAdjustBatchSize/getSecondHighestBatchSizeInHistory.ts'
import {getWarmupTarget} from './judgmentsJobsAdjustBatchSize/getWarmupTarget.ts'
import {getServerSentStats} from './judgmentsJobsArticlesRepository.ts'
import {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

type Snapshot = {start: Date; end: Date; totalTokens: number; total: number}

type InstanceState = {
  timestamp: Date | null
  lastTotal: number | null
  rotation: number
  snapshots: Snapshot[]
  history: {ts: Date; note: string}[]
  lastWaitingCount: number | null
  lastNonZeroTotal: number | null
  sleeping: boolean
  hasSeenWaiting: boolean
  maxCeilingTotal: number | null
  pinnedAtCeilingCount: number
}

const instanceStates = new Map<string, InstanceState>()
const gpuMultiplier = getGPUMultiplier()
const warmup = {start: 6 * gpuMultiplier, max: 16 * gpuMultiplier}

const clamp = (v: number, lo: number, hi: number): number => {
  return Math.max(lo, Math.min(hi, v))
}

const toNow = (): Date => {
  return new Date()
}

const getState = (instanceId: string): InstanceState => {
  const cur = instanceStates.get(instanceId)
  if (cur) return cur
  const init: InstanceState = {
    timestamp: null,
    lastTotal: null,
    rotation: 0,
    snapshots: [],
    history: [],
    lastWaitingCount: null,
    lastNonZeroTotal: null,
    sleeping: false,
    hasSeenWaiting: false,
    maxCeilingTotal: null,
    pinnedAtCeilingCount: 0,
  }
  instanceStates.set(instanceId, init)
  return init
}

const pushHistory = (instanceId: string, note: string): void => {
  const s = getState(instanceId)
  const ts = toNow()
  s.history = [...s.history, {ts, note}].slice(-20)
}

const getLatestCountsFor = async (
  db: PostgresJsDatabase<typeof schema>,
  instanceId: string,
  modelName: string,
): Promise<{waiting: number; running: number; ts: Date | null}> => {
  const rows = await db
    .select({waiting: schema.llmStatus.numQueueReqs, running: schema.llmStatus.numRunningReqs, ts: schema.llmStatus.ts})
    .from(schema.llmStatus)
    .where(
      and(
        eq(schema.llmStatus.engine, 'sglang'),
        eq(schema.llmStatus.instanceId, instanceId),
        eq(schema.llmStatus.modelName, modelName),
      ),
    )
    .orderBy(desc(schema.llmStatus.ts))
    .limit(1)

  return {
    waiting: Number(rows[0]?.waiting ?? 0),
    running: Number(rows[0]?.running ?? 0),
    ts: rows[0]?.ts ? new Date(rows[0].ts) : null,
  }
}

const sumTokensSince = async (
  db: PostgresJsDatabase<typeof schema>,
  jobIds: string[],
  start: Date,
  end: Date,
): Promise<number> => {
  if (jobIds.length === 0) return 0
  const [row] = await db
    .select({total: sum(schema.tokenUse.totalTokens)})
    .from(schema.tokenUse)
    .where(
      and(
        inArray(schema.tokenUse.judgmentsJobId, jobIds),
        gte(schema.tokenUse.createdAt, start),
        lt(schema.tokenUse.createdAt, end),
      ),
    )
  return Number(row?.total ?? 0)
}

const distribute = (total: number, n: number, rotation: number): number[] => {
  const base = Math.floor(total / Math.max(1, n))
  const rem = total - base * Math.max(1, n)
  const idx = (k: number): number => {
    return (rotation + k) % Math.max(1, n)
  }
  const build = (k: number, acc: number[]): number[] => {
    return k >= n ? acc : build(k + 1, [...acc, base + (k < rem ? 1 : 0)])
  }
  const assigned = build(0, [])
  const rotate = (arr: number[], r: number, k = 0, out: number[] = []): number[] => {
    return k >= arr.length ? out : rotate(arr, r, k + 1, [...out, arr[idx(k)] ?? 0])
  }
  return rotate(assigned, rotation)
}

const sumBatchSizes = (jobs: {sendToLLMBatchSize: number | null}[]): number => {
  return jobs.reduce((acc, j) => {
    return acc + Number(j.sendToLLMBatchSize || 0)
  }, 0)
}

const applyBatches = async (
  db: PostgresJsDatabase<typeof schema>,
  jobIds: string[],
  batches: number[],
): Promise<void> => {
  const pairs = jobIds.map((id, i) => {
    return {id, size: batches[i] ?? 1}
  })
  await Promise.all(
    pairs.map((p) => {
      return db
        .update(schema.judgmentsJobs)
        .set({sendToLLMBatchSize: p.size, updatedAt: toNow()})
        .where(eq(schema.judgmentsJobs.id, p.id))
    }),
  )
}

const nextFromCompareWithStep = (snapshots: Snapshot[], curTotal: number, upStep: number, downStep: number): number => {
  const a = snapshots.at(-1)
  const b = snapshots.at(-2)
  if (!a || !b) return curTotal + upStep
  const larger = a.total >= b.total ? a : b
  const smaller = a.total >= b.total ? b : a
  return larger.totalTokens > smaller.totalTokens ? larger.total + upStep : larger.total - downStep
}

// moved helpers: getSecondHighestBatchSizeInHistory, getWarmupTarget
const decideNextTotal = (
  cur: number,
  waitingCount: number,
  prevWaiting: number | null,
  warmupTarget: number | undefined,
  snapshots: Snapshot[],
  lastNonZeroTotal: number | null,
  staleStatus: boolean,
  upStep: number,
  overCap: boolean,
  hasStaleSent: boolean,
): NextDecision => {
  if (overCap) {
    return {nextTotal: 0, sleeping: true, historyNote: 'adjust-batch-size: sent>=1000 -> sleep'}
  }
  if (hasStaleSent) {
    return {nextTotal: 0, sleeping: true, historyNote: 'adjust-batch-size: stale-sent>5m -> sleep'}
  }
  if (staleStatus) {
    return {nextTotal: 0, sleeping: true, historyNote: 'adjust-batch-size: waiting=stale-status>1m -> sleep'}
  }
  const waiting = decideForWaiting(waitingCount, prevWaiting, cur, lastNonZeroTotal)
  if (waiting) return waiting

  if (warmupTarget !== undefined) {
    return {nextTotal: warmupTarget, sleeping: false, historyNote: null}
  }

  return {nextTotal: nextFromCompareWithStep(snapshots, cur, upStep, 1), sleeping: false, historyNote: null}
}

export const judgmentsJobsAdjustBatchSize = async (db: PostgresJsDatabase<typeof schema>, serverJobId: string) => {
  const jobs = await judgmentsJobsGetJobs(db)
  const hasJobs = jobs.length > 0

  if (!hasJobs) {
    console.log('adjust-batch-size skipped: no running jobs', {ts: toNow().toISOString()})
  } else {
    const now = toNow()
    const MAX_SENT = 250 * gpuMultiplier
    const STALE_MS = 5 * 60 * 1000
    const {sentCount, oldestSentAt} = await getServerSentStats(db, serverJobId)
    const overCap = sentCount >= MAX_SENT
    const oldestDate = oldestSentAt ? new Date(oldestSentAt) : null
    const hasStaleSent = oldestDate ? now.getTime() - oldestDate.getTime() > STALE_MS : false

    const jobConfigs = await db
      .select({
        jobId: schema.judgmentsJobs.id,
        sendToLLMBatchSize: schema.judgmentsJobs.sendToLLMBatchSize,
        baseURL: schema.models.baseURL,
        modelName: schema.models.modelName,
      })
      .from(schema.judgmentsJobs)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.judgmentsJobs.projectId))
      .innerJoin(schema.models, eq(schema.models.id, schema.projects.modelId))
      .where(eq(schema.judgmentsJobs.status, 'running'))

    const filtered = jobConfigs.filter((j) => {
      return !!j.baseURL
    })

    const byInstance = filtered.reduce((acc, j) => {
      const key = String(j.baseURL)
      const cur = acc.get(key) ?? []
      acc.set(key, [...cur, j])
      return acc
    }, new Map<string, (typeof filtered)[number][]>())

    const allJobIds: string[] = []
    const allBatches: number[] = []
    let anyPinnedThreePlus = false
    const summary: Record<
      string,
      {timestamp: Date | null; rotation: number; snapshotCount: number; batchSize: number; jobCount: number}
    > = {}

    for (const [instanceId, list] of byInstance.entries()) {
      const modelName = list[0]?.modelName ?? 'unknown'
      const s = getState(instanceId)

      const jobIds = list.map((x) => {
        return x.jobId
      })
      const currentTotalFromDb = sumBatchSizes(list)
      const prevTimestamp = s.timestamp
      const lastTotal = s.lastTotal ?? (currentTotalFromDb > 0 ? currentTotalFromDb : null)

      const isFirstRun = !prevTimestamp
      const inWarmup = isFirstRun || (lastTotal ?? 0) < warmup.max

      const tokens = prevTimestamp ? await sumTokensSince(db, jobIds, prevTimestamp, now) : 0
      const prevSnap =
        prevTimestamp && lastTotal ? [{start: prevTimestamp, end: now, totalTokens: tokens, total: lastTotal}] : []
      s.snapshots = [...s.snapshots, ...prevSnap].slice(-32)

      const warmupTarget = getWarmupTarget(isFirstRun, inWarmup, lastTotal, warmup.start, warmup.max)
      const cur = lastTotal ?? warmup.start

      const counts = await getLatestCountsFor(db, instanceId, modelName)
      const waitingCount = counts.waiting
      const lastStatusTs = counts.ts
      const ageMs = lastStatusTs ? now.getTime() - new Date(lastStatusTs).getTime() : Number.POSITIVE_INFINITY
      const staleStatus = !inWarmup && ageMs > 1 * 60 * 1000

      if (waitingCount > waitingThreshold || staleStatus) s.hasSeenWaiting = true

      // Lock a ceiling the first time we observe waiting > threshold
      if (waitingCount > waitingThreshold && s.maxCeilingTotal == null) {
        const secondHighest = getSecondHighestBatchSizeInHistory(s.snapshots, cur)
        const ceiling = secondHighest != null ? secondHighest : Math.max(1, cur - 1)
        s.maxCeilingTotal = ceiling
        console.log(
          `\x1b[31madjust-batch-size: wait>${waitingThreshold} -> locking max ceiling to ${secondHighest != null ? `2nd-highest-in-history=${ceiling}` : `(fallback current-1)=${ceiling}`} for instance=${instanceId} model=${modelName} at ${now.toISOString()}\x1b[0m`,
        )
      }

      const upStep = s.hasSeenWaiting ? 2 : 4
      const decision = decideNextTotal(
        cur,
        waitingCount,
        s.lastWaitingCount,
        warmupTarget,
        s.snapshots,
        s.lastNonZeroTotal,
        staleStatus,
        upStep,
        overCap,
        hasStaleSent,
      )

      const wasSleeping = s.sleeping
      s.sleeping = decision.sleeping
      if (decision.historyNote) pushHistory(instanceId, decision.historyNote)
      s.lastWaitingCount = waitingCount

      const maxTotal = 400
      // If we just woke up from sleep, start a bit lower (minus 4)
      let next = decision.nextTotal
      if (!s.sleeping && wasSleeping) {
        const base = s.lastNonZeroTotal ?? next
        next = base - 4
        pushHistory(instanceId, `adjust-batch-size: wake-from-sleep -> base=${base} - 4`)
      }
      const maxHi = s.maxCeilingTotal != null ? Math.min(maxTotal, s.maxCeilingTotal) : maxTotal
      const finalTotal = s.sleeping ? 0 : clamp(next, 1, maxHi)
      const batches = distribute(finalTotal, list.length, s.rotation)

      // track consecutive runs pinned at ceiling for this instance
      const atCeiling = !s.sleeping && s.maxCeilingTotal != null && finalTotal === Math.min(maxTotal, s.maxCeilingTotal)
      s.pinnedAtCeilingCount = atCeiling ? s.pinnedAtCeilingCount + 1 : 0
      if (s.pinnedAtCeilingCount >= 3) anyPinnedThreePlus = true

      // accumulate for single update
      allJobIds.push(...jobIds)
      allBatches.push(...batches)

      // update instance state
      s.rotation = (s.rotation + 1) % Math.max(1, list.length)
      s.timestamp = now
      s.lastTotal = finalTotal
      s.lastNonZeroTotal = finalTotal > 0 ? finalTotal : s.lastNonZeroTotal

      summary[instanceId] = {
        timestamp: s.timestamp,
        rotation: s.rotation,
        snapshotCount: s.snapshots.length,
        batchSize: finalTotal,
        jobCount: list.length,
      }
    }

    if (allJobIds.length > 0) await applyBatches(db, allJobIds, allBatches)

    const gpu = {
      nnodes: env.GPU_NNODES,
      gpusPerNode: env.GPU_GPUS_PER_NODE,
      totalGpus: env.GPU_TOTAL_GPUS,
      tpSize: env.TP_SIZE,
      dpSize: env.DP_SIZE,
    }

    if (anyPinnedThreePlus) {
      console.log('\x1b[32madjust-batch-size latest state\x1b[0m', {instances: summary, gpu})
    } else {
      console.log('adjust-batch-size latest state', {instances: summary, gpu})
    }
  }
}
