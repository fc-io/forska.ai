import {and, eq, inArray, isNotNull, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../../db/schema.ts'
export const P95_TARGET_MS = 3 * 60 * 1000
import {env} from '../../../utils/env.ts'

const countOfArticles = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<{judged: number; sent: number}> => {
  const t = schema.judgmentsJobsArticles

  const result = await db
    .select({
      judged: sql<number>`count(*) FILTER (WHERE ${t.status} = 'judged' AND ${t.judgedAt} IS NOT NULL)`,
      sent: sql<number>`count(*) FILTER (WHERE ${t.status} = 'sent')`,
    })
    .from(t)
    .where(and(eq(t.serverId, serverJobId), isNotNull(t.sentAt), inArray(t.status, ['judged', 'sent'])))

  return result[0] ?? {judged: 0, sent: 0}
}

const isLLMServerResponding = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${env.VITE_LLM_SERVER_URL}/models`)
    return response.ok
  } catch (_error) {
    return false
  }
}

const isBacklogToLarge = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  judged: number,
): Promise<boolean> => {
  const t = schema.judgmentsJobsArticles
  const maxRowsToCountDurationFor = Math.min(Math.round(judged / 2), 200)
  const [first] = await db.select({totalMs: sql<number>`SUM(duration_ms)`, avgMs: sql<number>`AVG(duration_ms)`})
    .from(sql`
    (SELECT EXTRACT(EPOCH FROM (${t.judgedAt} - ${t.sentAt})) * 1000 AS duration_ms
     FROM ${t}
     WHERE ${and(eq(t.serverId, serverJobId), eq(t.status, 'judged'), isNotNull(t.sentAt), isNotNull(t.judgedAt))}
     ORDER BY ${t.sentAt}
     LIMIT ${maxRowsToCountDurationFor}) AS s
  `)
  const [last] = await db.select({totalMs: sql<number>`SUM(duration_ms)`, avgMs: sql<number>`AVG(duration_ms)`})
    .from(sql`
  (SELECT EXTRACT(EPOCH FROM (${t.judgedAt} - ${t.sentAt})) * 1000 AS duration_ms
   FROM ${t}
   WHERE ${and(eq(t.serverId, serverJobId), eq(t.status, 'judged'), isNotNull(t.sentAt), isNotNull(t.judgedAt))}
   ORDER BY ${t.sentAt} DESC
   LIMIT ${maxRowsToCountDurationFor}) AS s
`)
  const firstAvgMs = Number(first?.avgMs ?? 0)
  const lastAvgMs = Number(last?.avgMs ?? 0)
  console.log('maxRowsToCountDurationFor', maxRowsToCountDurationFor)
  console.log('firstAvgMs', firstAvgMs)
  console.log('firstAvgMs * 1.1', firstAvgMs * 1.1)
  console.log('lastAvgMs', lastAvgMs)
  // Check if last 30 average is 20% higher than first 30
  console.log('lastAvgMs > firstAvgMs * 1.2', lastAvgMs > firstAvgMs * 1.1)

  return lastAvgMs > firstAvgMs * 1.1
}

const hasEnoughArticlesInBacklog = (sent: number): boolean => {
  // a meassly a100 fat should at least be able batch 80 articles in vllm
  // but of course multiple instances could be running
  return sent > 1
}

const hasSuccessfullyJudgedArticles = (judged: number): boolean => {
  return judged > 2
}

const isQueueFull = async (db: PostgresJsDatabase<typeof schema>, serverJobId: string): Promise<boolean> => {
  const {judged, sent} = await countOfArticles(db, serverJobId)
  console.log('sent', sent, 'judged', judged)
  return (
    hasSuccessfullyJudgedArticles(judged)
    && hasEnoughArticlesInBacklog(sent)
    && (await isBacklogToLarge(db, serverJobId, judged))
  )
}

export const getReadyToSendMoreStatus = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<{isReady: boolean; state: string}> => {
  const isServerResponding = await isLLMServerResponding()
  console.log('isServerResponding', isServerResponding)

  if (!isServerResponding) {
    return {isReady: false, state: 'server not responding'}
  } else if (await isQueueFull(db, serverJobId)) {
    return {isReady: false, state: 'severe latency'}
  }

  return {isReady: true, state: 'ready'}
}
