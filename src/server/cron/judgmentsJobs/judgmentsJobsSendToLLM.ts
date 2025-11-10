import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'
import {type ArticleToProcess, getAndUpdateReadyArticles} from './judgmentsJobsSendToLLM/getAndUpdateReadyArticles.ts'
import {processArticleWithLLM} from './judgmentsJobsSendToLLM/processArticleWithLLM.ts'

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

// With the cron now running every 1s (was 9s), we scale the per-tick
// batch size down to keep effective throughput roughly constant while
// we evaluate smoother arrivals. Adjuster logic will still tune totals.
const SEND_TO_LLM_TICK_DIVISOR = 9

const sendToLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  jobId: string,
  batchSize: number,
): Promise<void> => {
  const scaledBatch = Math.max(1, Math.ceil(batchSize / SEND_TO_LLM_TICK_DIVISOR))
  const articlesToProcess = await getAndUpdateReadyArticles(db, serverJobId, jobId, scaledBatch)
  const hasArticles = articlesToProcess.length > 0

  if (hasArticles) {
    // console.log('1 send to LLM')
    await processArticles(db, articlesToProcess)
  } else {
    console.log('No articles to proces – this should not happen, prob bug if it does')
  }
}

let hasLogged = false
export const judgmentsJobsSendToLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  allJobs: Awaited<ReturnType<typeof judgmentsJobsGetJobs>>,
  serverJobId: string,
): Promise<void> => {
  if (!hasLogged) {
    console.log(`1. send ${allJobs.length} jobs to LLM`)
  }
  await Promise.allSettled(
    allJobs.map((job) => {
      return sendToLLM(db, serverJobId, job.id, job.sendToLLMBatchSize)
    }),
  )
  if (!hasLogged) {
    console.log('2. send to LLM done')
    hasLogged = true
  }
}
