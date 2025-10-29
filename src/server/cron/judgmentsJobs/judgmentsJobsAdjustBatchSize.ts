import {and, desc, eq, gte, inArray, lt, sum} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

type Snapshot = {start: Date; end: Date; totalTokens: number; total: number}

type InstanceState = {
  lastRun: Date | null
  lastTotal: number | null
  rotation: number
  snapshots: Snapshot[]
  history: {ts: Date; note: string}[]
  lastWaitingCount: number | null
  lastNonZeroTotal: number | null
  sleeping: boolean
  hasSeenWaiting: boolean
}

const instanceStates = new Map<string, InstanceState>()
const warmup = {start: 6, max: 10}

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
    lastRun: null,
    lastTotal: null,
    rotation: 0,
    snapshots: [],
    history: [],
    lastWaitingCount: null,
    lastNonZeroTotal: null,
    sleeping: false,
    hasSeenWaiting: false,
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
    .select({
      waiting: schema.vllmStatus.numRequestsWaiting,
      running: schema.vllmStatus.numRequestsRunning,
      ts: schema.vllmStatus.ts,
    })
    .from(schema.vllmStatus)
    .where(and(eq(schema.vllmStatus.instanceId, instanceId), eq(schema.vllmStatus.modelName, modelName)))
    .orderBy(desc(schema.vllmStatus.ts))
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
    return k >= arr.length ? out : rotate(arr, r, k + 1, [...out, arr[idx(k)]])
  }
  return rotate(assigned, rotation)
}

const extractJobIds = (jobs: {id: string}[]): string[] => {
  return jobs.map((j) => {
    return j.id
  })
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

const nextFromCompare = (snapshots: Snapshot[], curTotal: number): number => {
  return nextFromCompareWithStep(snapshots, curTotal, 1, 1)
}

const nextFromCompareWithStep = (snapshots: Snapshot[], curTotal: number, upStep: number, downStep: number): number => {
  const a = snapshots.at(-1)
  const b = snapshots.at(-2)
  if (!a || !b) return curTotal + upStep
  const larger = a.total >= b.total ? a : b
  const smaller = a.total >= b.total ? b : a
  return larger.totalTokens > smaller.totalTokens ? larger.total + upStep : larger.total - downStep
}

const getWarmupTarget = (
  isFirstRun: boolean,
  inWarmup: boolean,
  lastTotal: number | null,
  warmupStart: number,
  warmupMax: number,
): number | undefined => {
  return isFirstRun ? warmupStart : inWarmup && lastTotal != null ? Math.min(lastTotal + 2, warmupMax) : undefined
}

type NextDecision = {nextTotal: number; sleeping: boolean; historyNote: string | null}

const decideForWaiting = (
  waitingCount: number,
  prevWaiting: number | null,
  cur: number,
  lastNonZeroTotal: number | null,
): NextDecision | null => {
  return waitingCount <= 0
    ? null
    : (() => {
        const firstWait = prevWaiting == null
        const increasedOrSame = firstWait ? true : waitingCount >= prevWaiting

        const remembered = lastNonZeroTotal ?? (cur > 0 ? cur : null)

        return increasedOrSame
          ? {nextTotal: 0, sleeping: true, historyNote: `adjust-batch-size: waiting=${waitingCount} -> sleep`}
          : {
              nextTotal: Math.max(0, (remembered ?? cur) - 1),
              sleeping: false,
              historyNote: `adjust-batch-size: waiting=${waitingCount} < prev=${prevWaiting} -> base-2(${remembered ?? cur}-1)`,
            }
      })()
}

const decideNextTotal = (
  cur: number,
  waitingCount: number,
  runningCount: number,
  prevWaiting: number | null,
  warmupTarget: number | undefined,
  snapshots: Snapshot[],
  lastNonZeroTotal: number | null,
  staleStatus: boolean,
  upStep: number,
): NextDecision => {
  const RUNNING_CAP = 196
  if (runningCount > RUNNING_CAP) {
    return {
      nextTotal: 0,
      sleeping: true,
      historyNote: `adjust-batch-size: running=${runningCount} > cap=${RUNNING_CAP} -> sleep`,
    }
  }
  if (staleStatus) {
    return {nextTotal: 0, sleeping: true, historyNote: 'adjust-batch-size: waiting=stale-status>2m -> sleep'}
  }
  const waiting = decideForWaiting(waitingCount, prevWaiting, cur, lastNonZeroTotal)
  if (waiting) return waiting

  if (warmupTarget !== undefined) {
    return {nextTotal: warmupTarget, sleeping: false, historyNote: null}
  }

  return {nextTotal: nextFromCompareWithStep(snapshots, cur, upStep, 1), sleeping: false, historyNote: null}
}

export const judgmentsJobsAdjustBatchSize = async (db: PostgresJsDatabase<typeof schema>) => {
  const jobs = await judgmentsJobsGetJobs(db)
  const hasJobs = jobs.length > 0

  if (!hasJobs) {
    console.log('adjust-batch-size skipped: no running jobs', {ts: toNow().toISOString()})
  } else {
    const now = toNow()

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
    const summary: Record<
      string,
      {
        lastRun: Date | null
        lastTotal: number | null
        rotation: number
        snapshotCount: number
        assignedTotal: number
        jobCount: number
      }
    > = {}

    for (const [instanceId, list] of byInstance.entries()) {
      const modelName = list[0]?.modelName ?? 'unknown'
      const s = getState(instanceId)

      const jobIds = list.map((x) => {
        return x.jobId
      })
      const currentTotalFromDb = sumBatchSizes(list)
      const lastRun = s.lastRun
      const lastTotal = s.lastTotal ?? (currentTotalFromDb > 0 ? currentTotalFromDb : null)

      const isFirstRun = !lastRun
      const inWarmup = !isFirstRun && (lastTotal ?? 0) < warmup.max

      const tokens = lastRun ? await sumTokensSince(db, jobIds, lastRun, now) : 0
      const prevSnap = lastRun && lastTotal ? [{start: lastRun, end: now, totalTokens: tokens, total: lastTotal}] : []
      s.snapshots = [...s.snapshots, ...prevSnap].slice(-8)

      const warmupTarget = getWarmupTarget(isFirstRun, inWarmup, lastTotal, warmup.start, warmup.max)
      const cur = lastTotal ?? warmup.start

      const counts = await getLatestCountsFor(db, instanceId, modelName)
      const waitingCount = counts.waiting
      const runningCount = counts.running
      const lastStatusTs = counts.ts
      const ageMs = lastStatusTs ? now.getTime() - new Date(lastStatusTs).getTime() : Number.POSITIVE_INFINITY
      const staleStatus = !inWarmup && ageMs > 2 * 60 * 1000

      if (waitingCount > 0 || staleStatus) s.hasSeenWaiting = true

      const upStep = s.hasSeenWaiting ? 2 : 4
      const decision = decideNextTotal(
        cur,
        waitingCount,
        runningCount,
        s.lastWaitingCount,
        warmupTarget,
        s.snapshots,
        s.lastNonZeroTotal,
        staleStatus,
        upStep,
      )

      s.sleeping = decision.sleeping
      if (decision.historyNote) pushHistory(instanceId, decision.historyNote)
      s.lastWaitingCount = waitingCount

      const maxTotal = 200
      const finalTotal = s.sleeping ? 0 : clamp(decision.nextTotal, 1, maxTotal)
      const batches = distribute(finalTotal, list.length, s.rotation)

      // accumulate for single update
      allJobIds.push(...jobIds)
      allBatches.push(...batches)

      // update instance state
      s.rotation = (s.rotation + 1) % Math.max(1, list.length)
      s.lastRun = now
      s.lastTotal = finalTotal
      s.lastNonZeroTotal = finalTotal > 0 ? finalTotal : s.lastNonZeroTotal

      summary[instanceId] = {
        lastRun: s.lastRun,
        lastTotal: s.lastTotal,
        rotation: s.rotation,
        snapshotCount: s.snapshots.length,
        assignedTotal: finalTotal,
        jobCount: list.length,
      }
    }

    if (allJobIds.length > 0) await applyBatches(db, allJobIds, allBatches)

    console.log('adjust-batch-size latest state', {instances: summary})
  }
}
