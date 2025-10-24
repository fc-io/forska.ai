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
} = {lastRun: null, lastTotal: null, rotation: 0, snapshots: [], warmupStart: 6, warmupMax: 10, history: []}

const clamp = (v: number, lo: number, hi: number): number => {
  return Math.max(lo, Math.min(hi, v))
}

const toNow = (): Date => {
  return new Date()
}

const getLatestHasWaiting = async (db: PostgresJsDatabase<typeof schema>): Promise<boolean> => {
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

  const waiting = Number(rows[0]?.waiting ?? 0)
  return waiting > 0
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

export const judgmentsJobsAdjustBatchSize = async (db: PostgresJsDatabase<typeof schema>) => {
  const jobs = await judgmentsJobsGetJobs(db)
  const hasJobs = jobs.length > 0
  if (!hasJobs) {
    const ts = toNow()
    state.history = [...state.history, {ts, note: 'adjust-batch-size: skipped; no running jobs'}].slice(-20)
    console.log('adjust-batch-size skipped: no running jobs', {
      ts: ts.toISOString(),
      historyCount: state.history.length,
    })
    return
  }
  const now = toNow()

  const jobIds = jobs.map((j) => {
    return j.id
  })
  const currentTotalFromDb = jobs.reduce((acc, j) => {
    return acc + Number(j.sendToLLMBatchSize || 0)
  }, 0)
  const lastRun = state.lastRun
  const lastTotal = state.lastTotal ?? (currentTotalFromDb > 0 ? currentTotalFromDb : null)

  const isFirstRun = !lastRun
  const inWarmup = !isFirstRun && (lastTotal ?? 0) < state.warmupMax

  const tokens = lastRun ? await sumTokensSince(db, jobIds, lastRun, now) : 0
  const prevSnap = lastRun && lastTotal ? [{start: lastRun, end: now, totalTokens: tokens, total: lastTotal}] : []
  state.snapshots = [...state.snapshots, ...prevSnap].slice(-8)

  const getWarmupTarget = (): number | undefined => {
    if (isFirstRun) return state.warmupStart
    if (inWarmup && lastTotal != null) return Math.min(lastTotal + 1, state.warmupMax)
    return undefined
  }

  const warmupOrUndefined = getWarmupTarget()
  const cur = lastTotal ?? state.warmupStart
  let nextTotal: number

  if (warmupOrUndefined !== undefined) {
    nextTotal = warmupOrUndefined
  } else {
    const hasWaiting = await getLatestHasWaiting(db)
    nextTotal = hasWaiting ? cur - 2 : nextFromCompare(state.snapshots, cur)
  }

  const minTotal = Math.max(1, jobs.length)
  const maxTotal = 200 // prop be bad to have an upper limit
  const finalTotal = clamp(nextTotal, minTotal, maxTotal)
  const batches = distribute(finalTotal, jobs.length, state.rotation)

  if (hasJobs) await applyBatches(db, jobIds, batches)

  state.rotation = (state.rotation + 1) % Math.max(1, jobs.length)
  state.lastRun = now
  state.lastTotal = finalTotal
  console.log('adjust-batch-size latest state', {
    lastRun: state.lastRun,
    lastTotal: state.lastTotal,
    rotation: state.rotation,
    snapshotCount: state.snapshots.length,
  })

  return
}
