import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {computeLatencyP95} from './judgmentsJobsSendToLLM/computeLatencyP95.ts'
import {getAndUpdateReadyArticles} from './judgmentsJobsSendToLLM/getAndUpdateReadyArticles.ts'
import {getBacklogSentCount} from './judgmentsJobsSendToLLM/getBacklogSentCount.ts'
import {processArticleWithLLM} from './judgmentsJobsSendToLLM/processArticleWithLLM.ts'
import {
  CRON_INTERVAL_MS,
  getCurrentBatch,
  getNextAllowedRunAt,
  MAX_BATCH,
  MIN_BATCH,
  P95_TARGET_MS,
  setCurrentBatch,
  setNextAllowedRunAt,
} from './judgmentsJobsSendToLLM/state.ts'
import type {ArticleToProcess} from './judgmentsJobsSendToLLM/types.ts'

type DecisionResult =
  | {kind: 'cooldown'; cooldownMs: number; newBatch: number}
  | {kind: 'increase' | 'decrease' | 'hold'; newBatch: number}

const isFiniteNumber = (v: unknown): v is number => {
  return typeof v === 'number' && Number.isFinite(v)
}

const decideBatchAction = (p95Ms: number | null, backlogSent: number, currentBatch: number): DecisionResult => {
  const highGate = 2 * currentBatch
  const hardGate = 3 * currentBatch
  const severeLatency = isFiniteNumber(p95Ms) && p95Ms >= 2 * P95_TARGET_MS

  if (backlogSent >= hardGate || severeLatency) {
    const base = isFiniteNumber(p95Ms) ? p95Ms : P95_TARGET_MS
    const cooldownMs = Math.min(2 * base, 2 * CRON_INTERVAL_MS)
    return {kind: 'cooldown', cooldownMs, newBatch: currentBatch}
  }

  if ((isFiniteNumber(p95Ms) && p95Ms > P95_TARGET_MS) || backlogSent > highGate) {
    const newBatch = Math.max(Math.ceil(currentBatch * 0.5), MIN_BATCH)
    return {kind: 'decrease', newBatch}
  }

  if (isFiniteNumber(p95Ms) && p95Ms <= P95_TARGET_MS && backlogSent <= highGate) {
    const newBatch = Math.min(currentBatch + 1, MAX_BATCH)
    return {kind: 'increase', newBatch}
  }

  return {kind: 'hold', newBatch: currentBatch}
}

const applyCooldown = (
  now: number,
  cooldownMs: number,
  context: {p95Ms: number | null; sampleSize: number; backlogSent: number; currentBatch: number},
): void => {
  setNextAllowedRunAt(now + cooldownMs)
  console.log('send to LLM: cooldown engaged', JSON.stringify({...context, cooldownMs}))
}

const logNoArticles = async (): Promise<void> => {
  console.log('No articles to process')
}

const processArticles = async (db: PostgresJsDatabase<typeof schema>, articles: ArticleToProcess[]): Promise<void> => {
  const results = await Promise.allSettled(
    articles.map((article) => {
      return processArticleWithLLM(db, article)
    }),
  )
  const rejected = results.filter((r) => {
    return r.status === 'rejected'
  }).length
  if (rejected > 0) {
    console.error('send to LLM: processing errors', JSON.stringify({rejected, total: results.length}))
  }
}

const processArticlesBatch = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  batch: number,
): Promise<void> => {
  const articlesToProcess = await getAndUpdateReadyArticles(db, serverJobId, batch)
  console.log('articlesToProcess length:', articlesToProcess.length, 'batch:', batch)

  const hasNoArticles = articlesToProcess.length === 0
  return hasNoArticles ? logNoArticles() : processArticles(db, articlesToProcess)
}

const logCooldownSkipAndEnd = async (cooldownUntil: number): Promise<void> => {
  console.log('send to LLM: skipped due to cooldown until', new Date(cooldownUntil).toISOString())
  console.log('end send to LLM')
}

const applyCooldownAndEnd = async (
  now: number,
  cooldownMs: number,
  context: {p95Ms: number | null; sampleSize: number; backlogSent: number; currentBatch: number},
): Promise<void> => {
  applyCooldown(now, cooldownMs, context)
  console.log('end send to LLM')
}

const proceedWithDecisionAndEnd = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  currentBatch: number,
  decision: DecisionResult,
  context: {p95Ms: number | null; sampleSize: number; backlogSent: number; currentBatch: number},
): Promise<void> => {
  if (decision.newBatch !== currentBatch) setCurrentBatch(decision.newBatch)

  console.log(
    'send to LLM: metrics and decision',
    JSON.stringify({
      p95Ms: context.p95Ms,
      sampleSize: context.sampleSize,
      backlogSent: context.backlogSent,
      decision: decision.kind,
      currentBatch: getCurrentBatch(),
    }),
  )

  const batch = getCurrentBatch()
  await processArticlesBatch(db, serverJobId, batch)
  console.log('end send to LLM')
}

export const judgmentsJobsSendToLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<void> => {
  const now = Date.now()
  const cooldownUntil = getNextAllowedRunAt()
  const inCooldown = Boolean(cooldownUntil && now < cooldownUntil)

  return inCooldown ? logCooldownSkipAndEnd(cooldownUntil as number) : proceedWhenAllowed(db, serverJobId, now)
}

const proceedWhenAllowed = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  now: number,
): Promise<void> => {
  const [{p95Ms, sampleSize}, backlogSent] = await Promise.all([
    computeLatencyP95(db),
    getBacklogSentCount(db, serverJobId),
  ])

  const currentBatch = getCurrentBatch()
  const decision = decideBatchAction(p95Ms, backlogSent, currentBatch)
  const context = {p95Ms, sampleSize, backlogSent, currentBatch}

  return decision.kind === 'cooldown'
    ? applyCooldownAndEnd(now, decision.cooldownMs, context)
    : proceedWithDecisionAndEnd(db, serverJobId, currentBatch, decision, context)
}
