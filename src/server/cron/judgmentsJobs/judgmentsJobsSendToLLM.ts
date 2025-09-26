import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {registerCooldownEvent} from './judgmentsJobsAdjustBatchSize.ts'
import type {judgmentsJobsGetJobs} from './judgmentsJobsGetJobs.ts'
import {type ArticleToProcess, getAndUpdateReadyArticles} from './judgmentsJobsSendToLLM/getAndUpdateReadyArticles.ts'
import {getReadyToSendMoreStatus} from './judgmentsJobsSendToLLM/getReadyToSendMoreStatus.ts'
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

const sendToLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
  jobId: string,
  batchSize: number,
): Promise<void> => {
  const articlesToProcess = await getAndUpdateReadyArticles(db, serverJobId, jobId, batchSize)
  const hasArticles = articlesToProcess.length > 0

  if (hasArticles) {
    // console.log('1 send to LLM')
    await processArticles(db, articlesToProcess)
  } else {
    console.log('No articles to proces – this should not happen, prob bug if it does')
  }
}

export const judgmentsJobsSendToLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  allJobs: Awaited<ReturnType<typeof judgmentsJobsGetJobs>>,
  serverJobId: string,
): Promise<void> => {
  // console.log('0')
  const sendMoreStatus = await getReadyToSendMoreStatus(db, serverJobId)

  if (sendMoreStatus.isReady) {
    // console.log('0 loop jobs')
    await Promise.allSettled(
      allJobs.map((job) => {
        return sendToLLM(db, serverJobId, job.id, job.sendToLLMBatchSize)
      }),
    )
  } else {
    registerCooldownEvent(sendMoreStatus.state)
    console.log('waiting for cooldown:', sendMoreStatus.state)
  }
  // console.log('2 end send to LLM')
  // console.log('---------------------------')
}
