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

export const judgmentsJobsSendToLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<void> => {
  const now = Date.now()
  const cooldownUntil = getNextAllowedRunAt()
  if (cooldownUntil && now < cooldownUntil) {
    console.log('send to LLM: skipped due to cooldown until', new Date(cooldownUntil).toISOString())
    return
  }

  const [{p95Ms, sampleSize}, backlogSent] = await Promise.all([
    computeLatencyP95(db),
    getBacklogSentCount(db, serverJobId),
  ])

  const currentBatch = getCurrentBatch()
  const highGate = 2 * currentBatch
  const hardGate = 3 * currentBatch
  let decision: 'increase' | 'decrease' | 'hold' | 'cooldown' = 'hold'

  const severeLatency = typeof p95Ms === 'number' && p95Ms >= 2 * P95_TARGET_MS
  if (backlogSent >= hardGate || severeLatency) {
    const cooldownMs = Math.min(2 * (typeof p95Ms === 'number' ? p95Ms : P95_TARGET_MS), 2 * CRON_INTERVAL_MS)
    setNextAllowedRunAt(now + cooldownMs)
    decision = 'cooldown'
    console.log(
      'send to LLM: cooldown engaged',
      JSON.stringify({p95Ms, sampleSize, backlogSent, currentBatch, cooldownMs}),
    )
    return
  }

  if ((typeof p95Ms === 'number' && p95Ms > P95_TARGET_MS) || backlogSent > highGate) {
    setCurrentBatch(Math.max(Math.ceil(currentBatch * 0.5), MIN_BATCH))
    decision = 'decrease'
  } else if (typeof p95Ms === 'number' && p95Ms <= P95_TARGET_MS && backlogSent <= highGate) {
    setCurrentBatch(Math.min(currentBatch + 1, MAX_BATCH))
    decision = 'increase'
  } else {
    decision = 'hold'
  }

  console.log(
    'send to LLM: metrics and decision',
    JSON.stringify({p95Ms, sampleSize, backlogSent, decision, currentBatch: getCurrentBatch()}),
  )

  const batch = getCurrentBatch()
  const articlesToProcess = await getAndUpdateReadyArticles(db, serverJobId, batch)
  console.log('articlesToProcess length:', articlesToProcess.length, 'batch:', batch)

  if (articlesToProcess.length === 0) {
    console.log('No articles to process')
    return
  }

  await Promise.all(
    articlesToProcess.map(async (article) => {
      await processArticleWithLLM(db, article)
    }),
  )

  console.log('end send to LLM')
}
