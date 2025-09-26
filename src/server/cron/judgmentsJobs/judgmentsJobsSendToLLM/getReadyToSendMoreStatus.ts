import {and, eq, inArray, isNotNull, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../../db/schema.ts'
export const P95_TARGET_MS = 3 * 60 * 1000
import {env} from '../../../utils/env.ts'
export const SLOPE_THRESHOLD_MS_PER_MIN = 20_000

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

const isLatencyIncreasingToMuch = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  judged: number,
): Promise<boolean> => {
  const t = schema.judgmentsJobsArticles
  const maxRowsToCountDurationFor = Math.min(Math.round(judged / 2), 200)
  const [row] = await db.select({slopeMsPerMin: sql<number>`regr_slope(duration_ms, sent_min)`}).from(sql`
      (SELECT
         EXTRACT(EPOCH FROM (${t.judgedAt} - ${t.sentAt})) * 1000 AS duration_ms,
         EXTRACT(EPOCH FROM ${t.sentAt}) / 60 AS sent_min
       FROM ${t}
       WHERE ${and(eq(t.serverId, serverJobId), eq(t.status, 'judged'), isNotNull(t.sentAt), isNotNull(t.judgedAt))}
       ORDER BY ${t.sentAt} DESC
       LIMIT ${maxRowsToCountDurationFor}
      ) AS s
    `)
  const slopeMsPerMin = Number(row?.slopeMsPerMin ?? 0)
  const isTooLarge = slopeMsPerMin > SLOPE_THRESHOLD_MS_PER_MIN
  if (maxRowsToCountDurationFor % 50 === 0 && maxRowsToCountDurationFor !== 200) {
    console.log('maxRowsToCountDurationFor', maxRowsToCountDurationFor)
  }
  if (isTooLarge === true) {
    console.log(`isLatencyIncreasingToMuch ${isTooLarge} (${slopeMsPerMin})`)
  }

  return isTooLarge
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
  // console.log('sent', sent, 'judged', judged)
  return (
    hasSuccessfullyJudgedArticles(judged)
    && hasEnoughArticlesInBacklog(sent)
    && (await isLatencyIncreasingToMuch(db, serverJobId, judged))
  )
}

export const getReadyToSendMoreStatus = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<{isReady: boolean; state: string}> => {
  const isServerResponding = await isLLMServerResponding()
  // console.log('isServerResponding', isServerResponding)

  if (!isServerResponding) {
    return {isReady: false, state: 'server not responding'}
  } else if (await isQueueFull(db, serverJobId)) {
    return {isReady: false, state: 'severe latency'}
  }

  return {isReady: true, state: 'ready'}
}
