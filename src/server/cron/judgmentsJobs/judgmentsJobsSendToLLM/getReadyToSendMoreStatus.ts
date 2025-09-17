import {and, count, eq, inArray, isNotNull, sql} from 'drizzle-orm'
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../../db/schema.ts'
export const P95_TARGET_MS = 3 * 60 * 1000
import {env} from '../../../utils/env.ts'
import {MAX_ARTICLES_BATCH_SIZE} from '../../judgmentsJobs.ts'
// const percentileCompute = (values: number[], p: number): number => {
//   const sorted = [...values].sort((a, b) => {
//     return a - b
//   })
//   const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
//   return sorted[idx]
// }

// const percentile = (values: number[], p: number): number => {
//   const isEmpty = values.length === 0
//   return isEmpty ? 0 : percentileCompute(values, p)
// }
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
// const hasSevereLatency = async (
//   db: PostgresJsDatabase<typeof schema>,
//   serverJobId: string,
// ): Promise<{p95Ms: number | null; sampleSize: number}> => {
//   const top = db
//     .select({total: count().mapWith(Number)}) // -> number
//     .from(schema.judgmentsJobsArticles)
//     .where(
//       and(
//         eq(schema.judgmentsJobsArticles.status, 'judged'),
//         eq(schema.judgmentsJobsArticles.serverId, serverJobId),
//         isNotNull(schema.judgmentsJobsArticles.sentAt),
//         isNotNull(schema.judgmentsJobsArticles.judgedAt),
//       ),
//     )

//   console.log('rows')
//   console.log(rows)

//   const durations = rows
//     .map((r) => {
//       const start =
//         r.sentAt instanceof Date ? r.sentAt.getTime() : new Date((r.sentAt as unknown as string) ?? '').getTime()
//       const end =
//         r.judgedAt instanceof Date ? r.judgedAt.getTime() : new Date((r.judgedAt as unknown as string) ?? '').getTime()
//       const diff = end - start
//       return Number.isFinite(diff) && diff >= 0 ? diff : null
//     })
//     .filter((v): v is number => {
//       return v !== null && Number.isFinite(v)
//     })

//   const sampleSize = durations.length
//   console.log('durations', durations)

//   const insufficient = sampleSize < 5
//   console.log('insufficient', insufficient)
//   return insufficient ? {p95Ms: null, sampleSize} : {p95Ms: percentile(durations, 95), sampleSize}
// }

// const isFiniteNumber = (v: unknown): v is number => {
//   return typeof v === 'number' && Number.isFinite(v)
// }

const isLLMServerResponding = async (): Promise<boolean> => {
  const response = await fetch(`${env.VITE_LLM_SERVER_URL}/models`)
  return response.ok
}

const isBacklogToLarge = ({judged, sent}: {judged: number; sent: number}): boolean => {
  return sent > judged * 4
}

const hasEnoughArticlesInBacklog = (sent: number): boolean => {
  return sent > 100
}

const hasSuccessfullyJudgedArticles = (judged: number): boolean => {
  // why not just look for > 0?
  return judged > Math.ceil(MAX_ARTICLES_BATCH_SIZE / 2)
}

const isQueueFull = async (db: PostgresJsDatabase<typeof schema>, serverJobId: string): Promise<boolean> => {
  const {judged, sent} = await countOfArticles(db, serverJobId)
  console.log('judged', judged)
  console.log('sent', sent)
  return hasSuccessfullyJudgedArticles(judged) && hasEnoughArticlesInBacklog(sent) && isBacklogToLarge({judged, sent})
}

export const getReadyToSendMoreStatus = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<{isReady: boolean; state: string}> => {
  const isServerResonding = await isLLMServerResponding()
  console.log('isServerResonding', isServerResonding)

  if (!isServerResonding) {
    return {isReady: false, state: 'server not responding'}
  } else if (await isQueueFull(db, serverJobId)) {
    return {isReady: false, state: 'severe latency'}
  }

  return {isReady: true, state: 'ready'}
}
