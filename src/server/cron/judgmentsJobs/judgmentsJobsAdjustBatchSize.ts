import {eq, gte, or} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'

type ChangeDirection = 'increase' | 'decrease' | 'none'

type JobSnapshot = {id: string; sendToLLMBatchSize: number; sendToLLMInterval: number}

type TokenTotals = {totalTokens: number; totalPromptTokens: number; totalCompletionTokens: number; requests: number}

type Snapshot = {
  recordedAt: Date
  change: ChangeDirection
  totalsCurrentMinute: TokenTotals
  totalsPreviousMinute: TokenTotals
  totalBatchSize: number
  totalInterval: number
  jobSettings: JobSnapshot[]
}

type JobRow = {id: string; sendToLLMBatchSize: number; sendToLLMInterval: number}

type Adjustment = 'increase' | 'decrease' | 'revert' | 'none'
type DirectionalAdjustment = Extract<Adjustment, 'increase' | 'decrease'>
type ResolvedAdjustment = Exclude<Adjustment, 'none'>

const SNAPSHOT_LOG_LIMIT = 20
const MIN_BATCH_SIZE = 1
const MAX_BATCH_SIZE = 100
const COOLDOWN_STATES = new Set(['severe latency', 'cooldown'])

let lastChange: ChangeDirection = 'none'
let currentSnapshot: Snapshot | null = null
let previousSnapshot: Snapshot | null = null
const snapshotsLog: Snapshot[] = []
let cooldownEventsSinceLastBatchUpdate = 0

const isCooldownState = (state: string): boolean => {
  return COOLDOWN_STATES.has(state)
}

export const registerCooldownEvent = (state: string): void => {
  if (!isCooldownState(state)) {
    return
  }
  cooldownEventsSinceLastBatchUpdate += 1
}

const resetCooldownEvents = (): void => {
  cooldownEventsSinceLastBatchUpdate = 0
}

const resolveCooldownOverride = (adjustment: Adjustment): Adjustment => {
  return cooldownEventsSinceLastBatchUpdate < 1 ? adjustment : 'decrease'
}

const emptyTotals = (): TokenTotals => {
  return {totalTokens: 0, totalPromptTokens: 0, totalCompletionTokens: 0, requests: 0}
}

const addToTotals = (totals: TokenTotals, row: TokenTotals): TokenTotals => {
  return {
    totalTokens: totals.totalTokens + row.totalTokens,
    totalPromptTokens: totals.totalPromptTokens + row.totalPromptTokens,
    totalCompletionTokens: totals.totalCompletionTokens + row.totalCompletionTokens,
    requests: totals.requests + row.requests,
  }
}

const logSnapshot = (snapshot: Snapshot): void => {
  if (currentSnapshot) {
    previousSnapshot = currentSnapshot
  }
  currentSnapshot = snapshot
  snapshotsLog.push(snapshot)
  if (snapshotsLog.length > SNAPSHOT_LOG_LIMIT) {
    snapshotsLog.shift()
  }
}

const getRowTimestamp = (row: {finishedAt: Date | null; startedAt: Date | null}): Date => {
  return row.finishedAt ?? row.startedAt ?? new Date(0)
}

const collectTotals = (
  rows: {
    finishedAt: Date | null
    startedAt: Date | null
    totalTokens: number
    totalPromptTokens: number
    totalCompletionTokens: number
    requests: number
  }[],
  predicate: (timestamp: Date) => boolean,
): TokenTotals => {
  return rows.reduce((acc, row) => {
    const timestamp = getRowTimestamp(row)
    if (!predicate(timestamp)) {
      return acc
    }
    return addToTotals(acc, {
      totalTokens: row.totalTokens,
      totalPromptTokens: row.totalPromptTokens,
      totalCompletionTokens: row.totalCompletionTokens,
      requests: row.requests,
    })
  }, emptyTotals())
}

const isFasterThanPrevious = (currentTotals: TokenTotals, previousTotals: TokenTotals): boolean => {
  const hasCurrentTokens = currentTotals.totalTokens > 0
  const hasPreviousTokens = previousTotals.totalTokens > 0
  if (!hasCurrentTokens) {
    return false
  }
  if (!hasPreviousTokens) {
    return true
  }
  return currentTotals.totalTokens > previousTotals.totalTokens
}

const nextAdjustmentWhenFaster = (): Adjustment => {
  const fastAdjustments: Record<ChangeDirection, Adjustment> = {
    increase: 'increase',
    decrease: 'decrease',
    none: 'increase',
  }
  return fastAdjustments[lastChange]
}

const nextAdjustmentWhenSlower = (hasBaseline: boolean): Adjustment => {
  return hasBaseline ? 'revert' : 'increase'
}

const determineAdjustment = (isFaster: boolean, hasBaseline: boolean): Adjustment => {
  return isFaster ? nextAdjustmentWhenFaster() : nextAdjustmentWhenSlower(hasBaseline)
}

const resolveIncrease = (job: JobRow): JobRow => {
  return {...job, sendToLLMBatchSize: Math.min(MAX_BATCH_SIZE, job.sendToLLMBatchSize + 1)}
}

const resolveDecrease = (job: JobRow): JobRow => {
  return {...job, sendToLLMBatchSize: Math.max(MIN_BATCH_SIZE, job.sendToLLMBatchSize - 3)}
}

const collectRevertUpdatesForBaseline = (jobs: JobRow[], baseline: Snapshot): JobRow[] => {
  const baselineMap = new Map(
    baseline.jobSettings.map((setting) => {
      return [setting.id, setting]
    }),
  )
  return jobs.reduce<JobRow[]>((acc, job) => {
    const target = baselineMap.get(job.id)
    if (!target) {
      return acc
    }
    const updated: JobRow = {
      ...job,
      sendToLLMBatchSize: target.sendToLLMBatchSize,
      sendToLLMInterval: target.sendToLLMInterval,
    }
    if (job.sendToLLMBatchSize === updated.sendToLLMBatchSize && job.sendToLLMInterval === updated.sendToLLMInterval) {
      return acc
    }
    return acc.concat(updated)
  }, [])
}

const collectRevertUpdates = (jobs: JobRow[], baseline: Snapshot | null): JobRow[] => {
  return baseline ? collectRevertUpdatesForBaseline(jobs, baseline) : []
}

const resolveDirectionalUpdate = (job: JobRow, adjustment: DirectionalAdjustment): JobRow => {
  const resolver = adjustment === 'increase' ? resolveIncrease : resolveDecrease
  return resolver(job)
}

const collectDirectionalUpdates = (jobs: JobRow[], adjustment: DirectionalAdjustment): JobRow[] => {
  return jobs.reduce<JobRow[]>((acc, job) => {
    const updated = resolveDirectionalUpdate(job, adjustment)
    if (job.sendToLLMBatchSize === updated.sendToLLMBatchSize && job.sendToLLMInterval === updated.sendToLLMInterval) {
      return acc
    }
    return acc.concat(updated)
  }, [])
}

const collectUpdatesForResolvedAdjustment = (
  jobs: JobRow[],
  adjustment: ResolvedAdjustment,
  baseline: Snapshot | null,
): JobRow[] => {
  return adjustment === 'revert' ? collectRevertUpdates(jobs, baseline) : collectDirectionalUpdates(jobs, adjustment)
}

const buildJobUpdates = (jobs: JobRow[], adjustment: Adjustment, baseline: Snapshot | null): JobRow[] => {
  return adjustment === 'none' ? [] : collectUpdatesForResolvedAdjustment(jobs, adjustment, baseline)
}

const mergeJobSettings = (jobs: JobRow[]): JobSnapshot[] => {
  return jobs.map((job) => {
    return {id: job.id, sendToLLMBatchSize: job.sendToLLMBatchSize, sendToLLMInterval: job.sendToLLMInterval}
  })
}

const sumJobTotals = (jobs: JobRow[]): {totalBatchSize: number; totalInterval: number} => {
  return jobs.reduce(
    (acc, job) => {
      return {
        totalBatchSize: acc.totalBatchSize + job.sendToLLMBatchSize,
        totalInterval: acc.totalInterval + job.sendToLLMInterval,
      }
    },
    {totalBatchSize: 0, totalInterval: 0},
  )
}

const snapshotForJobs = (jobs: JobRow[], currentTotals: TokenTotals, previousTotals: TokenTotals): Snapshot => {
  const {totalBatchSize, totalInterval} = sumJobTotals(jobs)
  return {
    recordedAt: new Date(),
    change: lastChange,
    totalsCurrentMinute: currentTotals,
    totalsPreviousMinute: previousTotals,
    totalBatchSize,
    totalInterval,
    jobSettings: mergeJobSettings(jobs),
  }
}

const applyUpdates = async (db: PostgresJsDatabase<typeof schema>, updates: JobRow[]): Promise<void> => {
  await Promise.all(
    updates.map((job) => {
      return db
        .update(schema.judgmentsJobs)
        .set({sendToLLMBatchSize: job.sendToLLMBatchSize, sendToLLMInterval: job.sendToLLMInterval})
        .where(eq(schema.judgmentsJobs.id, job.id))
    }),
  )
}

const updateStateAfterRevert = (baseline: Snapshot): void => {
  currentSnapshot = {...baseline, recordedAt: new Date(), change: 'none'}
  previousSnapshot = null
  lastChange = 'none'
}

const updateStateAfterAdjustment = (nextChange: ChangeDirection): void => {
  lastChange = nextChange
}

export const judgmentsJobsAdjustBatchSize = async (db: PostgresJsDatabase<typeof schema>) => {
  const jobs = await db
    .select({
      id: schema.judgmentsJobs.id,
      sendToLLMBatchSize: schema.judgmentsJobs.sendToLLMBatchSize,
      sendToLLMInterval: schema.judgmentsJobs.sendToLLMInterval,
    })
    .from(schema.judgmentsJobs)

  const now = new Date()
  const previousWindowStart = new Date(now.getTime() - 2 * 60 * 1000)
  const currentWindowStart = new Date(now.getTime() - 60 * 1000)

  const tokenRows = await db
    .select({
      finishedAt: schema.tokenUse.finishedAt,
      startedAt: schema.tokenUse.startedAt,
      totalTokens: schema.tokenUse.totalTokens,
      totalPromptTokens: schema.tokenUse.totalPromptTokens,
      totalCompletionTokens: schema.tokenUse.totalCompletionTokens,
      requests: schema.tokenUse.requests,
    })
    .from(schema.tokenUse)
    .where(
      or(gte(schema.tokenUse.finishedAt, previousWindowStart), gte(schema.tokenUse.startedAt, previousWindowStart)),
    )

  const tokensWithinWindow = tokenRows.filter((row) => {
    const timestamp = getRowTimestamp(row)
    return timestamp >= previousWindowStart && timestamp <= now
  })

  const totalsPreviousMinute = collectTotals(tokensWithinWindow, (timestamp) => {
    return timestamp >= previousWindowStart && timestamp < currentWindowStart
  })

  const totalsCurrentMinute = collectTotals(tokensWithinWindow, (timestamp) => {
    return timestamp >= currentWindowStart
  })

  const snapshot = snapshotForJobs(jobs, totalsCurrentMinute, totalsPreviousMinute)
  logSnapshot(snapshot)

  if (jobs.length === 0) {
    return
  }

  const faster = isFasterThanPrevious(totalsCurrentMinute, totalsPreviousMinute)
  const plannedAdjustment = determineAdjustment(faster, previousSnapshot !== null)
  const adjustment = resolveCooldownOverride(plannedAdjustment)
  console.log('isFasterThanPrevious', faster)
  console.log('adjustment', adjustment)
  if (adjustment === 'none') {
    lastChange = 'none'
    return
  }

  const updates = buildJobUpdates(jobs, adjustment, previousSnapshot)
  console.log('updates', updates)
  if (updates.length === 0) {
    lastChange = 'none'
    if (adjustment === 'revert' && previousSnapshot) {
      updateStateAfterRevert(previousSnapshot)
    }
    return
  }

  await applyUpdates(db, updates)
  resetCooldownEvents()

  if (adjustment === 'revert' && previousSnapshot) {
    updateStateAfterRevert(previousSnapshot)
    return
  }

  updateStateAfterAdjustment(adjustment === 'increase' ? 'increase' : 'decrease')
}
