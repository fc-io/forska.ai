import {and, desc, eq, gte, inArray, lt, sum} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'
import {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

type Snapshot = {start: Date; end: Date; totalTokens: number; total: number}

const state: {
  lastRun: Date | null
  lastTotal: number | null
  rotation: number
  snapshots: Snapshot[]
  warmupStart: number
  warmupMax: number
  history: {ts: Date; note: string}[]
  lastWaitingCount: number | null
  lastNonZeroTotal: number | null
  sleeping: boolean
} = {
  lastRun: null,
  lastTotal: null,
  rotation: 0,
  snapshots: [],
  warmupStart: 6,
  warmupMax: 10,
  history: [],
  lastWaitingCount: null,
  lastNonZeroTotal: null,
  sleeping: false,
}

const clamp = (v: number, lo: number, hi: number): number => {
  return Math.max(lo, Math.min(hi, v))
}

const toNow = (): Date => {
  return new Date()
}

const pushHistory = (note: string): void => {
  const ts = toNow()
  state.history = [...state.history, {ts, note}].slice(-20)
}

const getLatestWaitingCount = async (db: PostgresJsDatabase<typeof schema>): Promise<number> => {
  const instanceId = env.VITE_LLM_SERVER_URL
  const jobModels = await db
    .select({modelName: schema.models.modelName})
    .from(schema.judgmentsJobs)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.judgmentsJobs.projectId))
    .leftJoin(schema.models, eq(schema.models.id, schema.projects.modelId))
  const modelName = jobModels[0]?.modelName ?? 'unknown'

  const rows = await db
    .select({waiting: schema.vllmStatus.numRequestsWaiting})
    .from(schema.vllmStatus)
    .where(and(eq(schema.vllmStatus.instanceId, instanceId), eq(schema.vllmStatus.modelName, modelName)))
    .orderBy(desc(schema.vllmStatus.ts))
    .limit(1)

  return Number(rows[0]?.waiting ?? 0)
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
  const a = snapshots.at(-1)
  const b = snapshots.at(-2)
  if (!a || !b) return curTotal + 1
  const larger = a.total >= b.total ? a : b
  const smaller = a.total >= b.total ? b : a
  return larger.totalTokens > smaller.totalTokens ? larger.total + 1 : larger.total - 2
}

const getWarmupTarget = (
  isFirstRun: boolean,
  inWarmup: boolean,
  lastTotal: number | null,
  warmupStart: number,
  warmupMax: number,
): number | undefined => {
  return isFirstRun ? warmupStart : inWarmup && lastTotal != null ? Math.min(lastTotal + 1, warmupMax) : undefined
}

type NextDecision = {nextTotal: number; sleeping: boolean; historyNote: string | null}

const decideForWaiting = (waitingCount: number, prevWaiting: number | null, cur: number): NextDecision | null => {
  return waitingCount <= 0
    ? null
    : (() => {
        const firstWait = prevWaiting == null
        const increasedOrSame = firstWait ? true : waitingCount >= prevWaiting

        state.lastNonZeroTotal = state.lastNonZeroTotal ?? (cur > 0 ? cur : null)
        state.lastWaitingCount = waitingCount

        return increasedOrSame
          ? {nextTotal: 0, sleeping: true, historyNote: `adjust-batch-size: waiting=${waitingCount} -> sleep`}
          : {
              nextTotal: Math.max(0, (state.lastNonZeroTotal ?? cur) - 2),
              sleeping: false,
              historyNote: `adjust-batch-size: waiting=${waitingCount} < prev=${prevWaiting} -> base-2(${state.lastNonZeroTotal ?? cur}-2)`,
            }
      })()
}

const decideNextTotal = (
  cur: number,
  waitingCount: number,
  prevWaiting: number | null,
  warmupTarget: number | undefined,
  snapshots: Snapshot[],
): NextDecision => {
  const waiting = decideForWaiting(waitingCount, prevWaiting, cur)
  if (waiting) return waiting

  if (warmupTarget !== undefined) {
    return {nextTotal: warmupTarget, sleeping: false, historyNote: null}
  }

  return {nextTotal: nextFromCompare(snapshots, cur), sleeping: false, historyNote: null}
}

export const judgmentsJobsAdjustBatchSize = async (db: PostgresJsDatabase<typeof schema>) => {
  const jobs = await judgmentsJobsGetJobs(db)
  const hasJobs = jobs.length > 0

  if (!hasJobs) {
    pushHistory('adjust-batch-size: skipped; no running jobs')
    console.log('adjust-batch-size skipped: no running jobs', {
      ts: toNow().toISOString(),
      historyCount: state.history.length,
    })
  } else {
    const now = toNow()
    const jobIds = extractJobIds(jobs)
    const currentTotalFromDb = sumBatchSizes(jobs)
    const lastRun = state.lastRun
    const lastTotal = state.lastTotal ?? (currentTotalFromDb > 0 ? currentTotalFromDb : null)

    const isFirstRun = !lastRun
    const inWarmup = !isFirstRun && (lastTotal ?? 0) < state.warmupMax

    const tokens = lastRun ? await sumTokensSince(db, jobIds, lastRun, now) : 0
    const prevSnap = lastRun && lastTotal ? [{start: lastRun, end: now, totalTokens: tokens, total: lastTotal}] : []
    state.snapshots = [...state.snapshots, ...prevSnap].slice(-8)

    const warmupTarget = getWarmupTarget(isFirstRun, inWarmup, lastTotal, state.warmupStart, state.warmupMax)
    const cur = lastTotal ?? state.warmupStart

    const waitingCount = await getLatestWaitingCount(db)
    const decision = decideNextTotal(cur, waitingCount, state.lastWaitingCount, warmupTarget, state.snapshots)

    state.sleeping = decision.sleeping
    if (decision.historyNote) pushHistory(decision.historyNote)

    const minTotal = Math.max(1, jobs.length)
    const maxTotal = 200
    const finalTotal = state.sleeping ? 0 : clamp(decision.nextTotal, minTotal, maxTotal)
    const batches = distribute(finalTotal, jobs.length, state.rotation)

    await applyBatches(db, jobIds, batches)

    state.rotation = (state.rotation + 1) % Math.max(1, jobs.length)
    state.lastRun = now
    state.lastTotal = finalTotal
    state.lastNonZeroTotal = finalTotal > 0 ? finalTotal : state.lastNonZeroTotal
    console.log('adjust-batch-size latest state', {
      lastRun: state.lastRun,
      lastTotal: state.lastTotal,
      rotation: state.rotation,
      snapshotCount: state.snapshots.length,
    })
  }
}
