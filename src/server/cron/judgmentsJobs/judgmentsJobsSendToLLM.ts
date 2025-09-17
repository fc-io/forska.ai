import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js'

import * as schema from '../../../db/schema.ts'
import {MAX_ARTICLES_BATCH_SIZE} from '../judgmentsJobs.ts'
import {getAndUpdateReadyArticles} from './judgmentsJobsSendToLLM/getAndUpdateReadyArticles.ts'
import {getReadyToSendMoreStatus} from './judgmentsJobsSendToLLM/getReadyToSendMoreStatus.ts'
import {processArticleWithLLM} from './judgmentsJobsSendToLLM/processArticleWithLLM.ts'
import type {ArticleToProcess} from './judgmentsJobsSendToLLM/types.ts'

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

const sendToLLM = async (db: PostgresJsDatabase<typeof schema>, serverJobId: string): Promise<void> => {
  // ARTICLES_BATH_MULTIPLIER  = basically LLM_PROCESSING_INTERVAL / NEW_ARTICLES_INTERVAL (this could be nicer)
  // this is a bit helpful when there are a lot of ready articles but non has been sent to the LLM yet
  const ARTICLES_BATH_MULTIPLIER = 3
  const articlesToProcess = await getAndUpdateReadyArticles(
    db,
    serverJobId,
    MAX_ARTICLES_BATCH_SIZE * ARTICLES_BATH_MULTIPLIER,
  )
  const hasArticles = articlesToProcess.length > 0

  if (hasArticles) {
    await processArticles(db, articlesToProcess)
  } else {
    console.log('No articles to proces – this should not happen, prob bug if it does')
  }
}

export const judgmentsJobsSendToLLM = async (
  db: PostgresJsDatabase<typeof schema>,
  serverJobId: string,
): Promise<void> => {
  console.log('0')
  const sendMoreStatus = await getReadyToSendMoreStatus(db, serverJobId)

  if (sendMoreStatus.isReady) {
    console.log('1 send to LLM')
    await sendToLLM(db, serverJobId)
  } else {
    console.log('waiting for cooldown', sendMoreStatus.state)
  }
  console.log('2 end send to LLM')
  console.log('---------------------------')
}
