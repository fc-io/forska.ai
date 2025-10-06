import {and, desc, eq, gte, isNotNull, lt, sql, sum} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {env} from '../../utils/env.ts'
import {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'

type Snapshot = {from: Date; to: Date; totalTokens: number; totalBatch: number}

type TuningState = {phase: 'warmup' | 'adjust'; totalBatch: number; lastSnapshotAt: Date | null; snapshots: Snapshot[]}

const state: {current: TuningState | null} = {current: null}

const now = () => {
  return new Date()
}

const clamp = (v: number, lo: number, hi: number) => {
  return Math.max(lo, Math.min(hi, v))
}

const distribute = (total: number, ids: string[]) => {
  const n = ids.length
  const baseTotal = Math.max(total, n)
  const base = Math.floor(baseTotal / n)
  const rem = baseTotal % n
  const sorted = [...ids].sort()
  return sorted.map((_, i) => {
    return base + (i < rem ? 1 : 0)
  })
}

const applyDistribution = async (db: PostgresJsDatabase<typeof schema>, jobIds: string[], perJob: number[]) => {
  const updates = jobIds
    .map((id, i) => {
      return {id, size: clamp(perJob[i] ?? 1, 1, 1000)}
    })
    .map((u) => {
      return db.update(schema.judgmentsJobs).set({sendToLLMBatchSize: u.size}).where(eq(schema.judgmentsJobs.id, u.id))
    })
  await Promise.all(updates)
}

const sumTokensInRange = async (db: PostgresJsDatabase<typeof schema>, from: Date, to: Date) => {
  const rows = await db
    .select({totalTokens: sum(schema.tokenUse.totalTokens).as('totalTokens')})
    .from(schema.tokenUse)
    .where(
      and(
        isNotNull(schema.tokenUse.judgmentsJobId),
        gte(schema.tokenUse.createdAt, from),
        lt(schema.tokenUse.createdAt, to),
      ),
    )
  const v = Number(rows[0]?.totalTokens ?? 0)
  return Number.isFinite(v) ? v : 0
}

const latestVllmStatus = async (db: PostgresJsDatabase<typeof schema>) => {
  const instanceId = env.VITE_LLM_SERVER_URL
  const jobModels = await db
    .select({modelName: schema.models.modelName})
    .from(schema.judgmentsJobs)
    .leftJoin(schema.projects, eq(schema.judgmentsJobs.projectId, schema.projects.id))
    .leftJoin(schema.models, eq(schema.projects.modelId, schema.models.id))
  const modelName = jobModels[0]?.modelName ?? 'unknown'
  const rows = await db
    .select()
    .from(schema.vllmStatus)
    .where(and(eq(schema.vllmStatus.instanceId, instanceId), eq(schema.vllmStatus.modelName, modelName)))
    .orderBy(desc(schema.vllmStatus.ts))
    .limit(1)
  return rows[0]
}

const parseLastAction = (s: string | null) => {
  try {
    return s ? (JSON.parse(s) as unknown) : null
  } catch (_e) {
    return null
  }
}

const nextWarmupTotal = (current: number | null) => {
  return current == null ? 6 : current + 1
}

const toSnapshot = async (db: PostgresJsDatabase<typeof schema>, prev: Date | null, totalBatch: number) => {
  const t1 = prev ?? now()
  const t2 = now()
  const tokens = await sumTokensInRange(db, t1, t2)
  return {from: t1, to: t2, totalTokens: tokens, totalBatch}
}

const getJobIds = async (db: PostgresJsDatabase<typeof schema>) => {
  const jobs = await judgmentsJobsGetJobs(db)
  const jobIds = jobs.map((j) => {
    return j.id
  })
  return jobIds
}

export const judgmentsJobsAdjustBatchSize = async (db: PostgresJsDatabase<typeof schema>) => {
  const jobIds = await getJobIds(db)
  const s = state.current

  if (jobIds.length === 0) {
    state.current = s
    console.log('judgmentsJobsAdjustBatchSize: no running jobs')
    return
  }

  const isWarmup = !s || s.phase === 'warmup'
  const nextTotal = isWarmup ? nextWarmupTotal(s?.totalBatch ?? null) : s.totalBatch

  if (isWarmup) {
    const dist = distribute(nextTotal, jobIds)
    await applyDistribution(db, [...jobIds].sort(), dist)

    const snap = s?.lastSnapshotAt ? await toSnapshot(db, s.lastSnapshotAt, s.totalBatch) : null
    const newSnaps = snap ? [...(s?.snapshots ?? []), snap] : (s?.snapshots ?? [])
    const phase = nextTotal >= 8 ? 'adjust' : 'warmup'

    state.current = {phase, totalBatch: nextTotal, lastSnapshotAt: now(), snapshots: newSnaps.slice(-2)}
    console.log('judgmentsJobsAdjustBatchSize: warmup set total', nextTotal)
    return
  }

  const last = await latestVllmStatus(db)
  const action = parseLastAction(last?.lastAction ?? null)
  const smallQueue =
    typeof action === 'object' && action && 'smallQueue' in action ? Boolean((action as any).smallQueue) : true

  const snap = s.lastSnapshotAt ? await toSnapshot(db, s.lastSnapshotAt, s.totalBatch) : null
  const snaps = (snap ? [...s.snapshots, snap] : s.snapshots).slice(-2)

  const chooseNextTotal = () => {
    if (!smallQueue) return s.totalBatch - 2
    if (snaps.length < 2) return s.totalBatch
    const [a, b] = snaps
    const larger = a.totalBatch === b.totalBatch ? b : a.totalBatch > b.totalBatch ? a : b
    const smaller = larger === a ? b : a
    return larger.totalTokens > smaller.totalTokens ? larger.totalBatch + 1 : larger.totalBatch - 2
  }

  const proposed = clamp(chooseNextTotal(), runningCount, 10_000)
  const dist = distribute(proposed, jobIds)
  await applyDistribution(db, [...jobIds].sort(), dist)

  state.current = {phase: 'adjust', totalBatch: proposed, lastSnapshotAt: now(), snapshots: snaps.slice(-2)}
  console.log('judgmentsJobsAdjustBatchSize: adjust set total', proposed, 'smallQueue', smallQueue)
}
