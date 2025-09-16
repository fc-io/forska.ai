import {and, desc, eq, inArray, isNotNull} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import {judge} from '../../../agent/judge.ts'
import * as schema from '../../../db/schema.ts'
import {markArticlesAsJudged} from './judgmentsJobsArticlesRepository.ts'

type ArticleToProcess = {jobId: string; articleId: string; recordId: string; projectId: string}

// --- Adaptive controller state (in-memory only) ---
const CRON_INTERVAL_MS = 15_000
const P95_TARGET_MS = Math.floor((CRON_INTERVAL_MS * 2) / 3) // ~10 seconds for 15s interval
const MAX_BATCH = 16
const MIN_BATCH = 1

let currentBatch = 1
let nextAllowedRunAt: number | null = null

type Metrics = {p95Ms: number | null; sampleSize: number; backlogSent: number}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx]
}

const computeLatencyP95 = async (
  db: PostgresJsDatabase<typeof schema>,
): Promise<{p95Ms: number | null; sampleSize: number}> => {
  // Fetch recent token_use rows corresponding to single-article judge calls
  const rows = await db
    .select({duration: schema.tokenUse.duration})
    .from(schema.tokenUse)
    .where(and(eq(schema.tokenUse.requests, 1), isNotNull(schema.tokenUse.judgmentsJobId)))
    .orderBy(desc(schema.tokenUse.createdAt))
    .limit(100)

  const durations = rows
    .map((r) => {
      return typeof r.duration === 'number' ? r.duration : null
    })
    .filter((v): v is number => v !== null && Number.isFinite(v))

  const sampleSize = durations.length
  if (sampleSize < 5) return {p95Ms: null, sampleSize}
  return {p95Ms: percentile(durations, 95), sampleSize}
}

const getBacklogSentCount = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<number> => {
  const rows = await db
    .select({id: schema.judgmentsJobsArticles.id})
    .from(schema.judgmentsJobsArticles)
    .where(and(eq(schema.judgmentsJobsArticles.status, 'sent'), eq(schema.judgmentsJobsArticles.serverId, serverJobId)))

  return rows.length
}

const getAndUpdateReadyArticles = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  limit: number,
): Promise<ArticleToProcess[]> => {
  // Select up to `limit` ready rows for this server deterministically (oldest first)
  const readyRows = await db
    .select({
      id: schema.judgmentsJobsArticles.id,
      articleId: schema.judgmentsJobsArticles.articleId,
      jobId: schema.judgmentsJobsArticles.jobId,
    })
    .from(schema.judgmentsJobsArticles)
    .where(
      and(eq(schema.judgmentsJobsArticles.status, 'ready'), eq(schema.judgmentsJobsArticles.serverId, serverJobId)),
    )
    .orderBy(schema.judgmentsJobsArticles.createdAt)
    .limit(limit)

  if (readyRows.length === 0) return []

  // Update only the selected rows to 'sent' and return their fields
  const readyIds = readyRows.map((r) => {
    return r.id
  })

  const articlesWithJobs = await db
    .update(schema.judgmentsJobsArticles)
    .set({status: 'sent', updatedAt: new Date()})
    .where(
      and(
        eq(schema.judgmentsJobsArticles.serverId, serverJobId),
        inArray(schema.judgmentsJobsArticles.id, readyIds),
      ),
    )
    .returning({
      recordId: schema.judgmentsJobsArticles.id,
      articleId: schema.judgmentsJobsArticles.articleId,
      jobId: schema.judgmentsJobsArticles.jobId,
    })

  // Filter returned rows to the ones we selected (some DBs may not support WHERE IN with returning easily in Drizzle update)
  const selectedMap = new Set(readyIds)
  const selectedArticles = articlesWithJobs.filter((row) => selectedMap.has(row.recordId))

  const articlesWithProjects = await Promise.all(
    selectedArticles.map(async (article) => {
      const [job] = await db
        .select({projectId: schema.judgmentsJobs.projectId})
        .from(schema.judgmentsJobs)
        .where(eq(schema.judgmentsJobs.id, article.jobId))
        .limit(1)

      return {...article, projectId: job?.projectId || ''}
    }),
  )

  return articlesWithProjects.filter((article) => {
    return article.projectId
  })
}

const processArticleWithLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  articleToProcess: ArticleToProcess,
): Promise<void> => {
  const sessionId = null

  try {
    const [article] = await db
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.id, articleToProcess.articleId))
      .limit(1)

    const prompts = await db
      .select()
      .from(schema.prompts)
      .where(eq(schema.prompts.projectId, articleToProcess.projectId))

    if (article && prompts.length > 0) {
      await judge({articles: [article], prompts, sessionId, judgmentsJobId: articleToProcess.jobId})
      await markArticlesAsJudged(db, articleToProcess.jobId, [articleToProcess.articleId])
    }
  } catch (error) {
    console.error('Error sending to LLM:', error)
  }
}

export const judgmentsJobsSendToLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<void> => {
  // Cooldown gating: skip if not yet allowed
  const now = Date.now()
  if (nextAllowedRunAt && now < nextAllowedRunAt) {
    console.log('send to LLM: skipped due to cooldown until', new Date(nextAllowedRunAt).toISOString())
    return
  }

  // Gather metrics
  const [{p95Ms, sampleSize}, backlogSent] = await Promise.all([
    computeLatencyP95(db),
    getBacklogSentCount(db, serverJobId),
  ])

  // Decide AIMD adjustment
  const highGate = 2 * currentBatch
  const hardGate = 3 * currentBatch
  let decision: 'increase' | 'decrease' | 'hold' | 'cooldown' = 'hold'

  const severeLatency = typeof p95Ms === 'number' && p95Ms >= 2 * P95_TARGET_MS
  if (backlogSent >= hardGate || severeLatency) {
    const cooldownMs = Math.min(2 * (typeof p95Ms === 'number' ? p95Ms : P95_TARGET_MS), 2 * CRON_INTERVAL_MS)
    nextAllowedRunAt = now + cooldownMs
    decision = 'cooldown'
    console.log(
      'send to LLM: cooldown engaged',
      JSON.stringify({p95Ms, sampleSize, backlogSent, currentBatch, cooldownMs}),
    )
    return
  }

  if ((typeof p95Ms === 'number' && p95Ms > P95_TARGET_MS) || backlogSent > highGate) {
    currentBatch = Math.max(Math.ceil(currentBatch * 0.5), MIN_BATCH)
    decision = 'decrease'
  } else if (typeof p95Ms === 'number' && p95Ms <= P95_TARGET_MS && backlogSent <= highGate) {
    currentBatch = Math.min(currentBatch + 1, MAX_BATCH)
    decision = 'increase'
  } else {
    decision = 'hold'
  }

  console.log(
    'send to LLM: metrics and decision',
    JSON.stringify({p95Ms, sampleSize, backlogSent, decision, currentBatch}),
  )

  // Acquire up to currentBatch items to process
  const articlesToProcess = await getAndUpdateReadyArticles(db, serverJobId, currentBatch)
  console.log('articlesToProcess length:', articlesToProcess.length, 'batch:', currentBatch)

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
