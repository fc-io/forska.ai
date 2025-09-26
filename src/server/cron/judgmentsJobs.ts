import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {env} from '../utils/env.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {getNumberOfArticlesInReadyQueue} from './judgmentsJobs/getNumberOfArticlesInReadyQueue.ts'
import {isReadyToGetMoreArticles} from './judgmentsJobs/isReadyToGetMoreArticles.ts'
import {judgmentsJobsAddToJobsQueue} from './judgmentsJobs/judgmentsJobsAddToJobsQueue.ts'
import {judgmentsJobsAdjustBatchSize} from './judgmentsJobs/judgmentsJobsAdjustBatchSize.ts'
import {judgmentsJobsCleanupStale} from './judgmentsJobs/judgmentsJobsCleanupStale.ts'
import {judgmentsJobsGetJobs} from './judgmentsJobs/judgmentsJobsGetJobs.ts'
import {judgmentsJobsGetNewArticles} from './judgmentsJobs/judgmentsJobsGetNewArticles.ts'
import {judgmentsJobsSendToLLM} from './judgmentsJobs/judgmentsJobsSendToLLM.ts'

export const MAX_ARTICLES_BATCH_SIZE = 15
const serverJobId = `server-job-${crypto.randomUUID()}`

const NEW_ARTICLES_INTERVAL = '*/5 * * * * *' // Every 5 seconds
const LLM_PROCESSING_INTERVAL = '*/15 * * * * *' // Every 15 seconds
const ADJUST_BATCH_SIZE_INTERVAL = '0 */1 * * * *' // Every 1 minutes
const CLEANUP_STALE_INTERVAL = '0 */5 * * * *' // Every 5 minutes

const getNewArticlesForJobs = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING) return
  const db = getDatabase()
  const numberOfArticlesInReadyQueue = await getNumberOfArticlesInReadyQueue(db, serverJobId)
  const allJobs = await judgmentsJobsGetJobs(db)
  // console.log('numberOfArticlesInReadyQueue', numberOfArticlesInReadyQueue)
  // console.log('isReadyToGetMoreArticles', isReadyToGetMoreArticles(numberOfArticlesInReadyQueue, allJobs))

  if (isReadyToGetMoreArticles(numberOfArticlesInReadyQueue, allJobs)) {
    const newArticlesToProcess = await judgmentsJobsGetNewArticles(db, allJobs)
    await judgmentsJobsAddToJobsQueue(db, newArticlesToProcess, serverJobId)
  }
}

const sendToLLMCron = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING) return

  const db = getDatabase()
  const allJobs = await judgmentsJobsGetJobs(db)
  await judgmentsJobsSendToLLM(db, allJobs, serverJobId)
}

const adjustBatchSizeCron = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING) return

  const db = getDatabase()
  await judgmentsJobsAdjustBatchSize(db)
}

const cleanupStaleQueueCron = async (): Promise<void> => {
  // if (!env.RUN_SERVER_JUDGING) return
  const db = getDatabase()
  await judgmentsJobsCleanupStale(db)
}

export const judgmentsJobsCron = new Elysia()
  .use(cron({name: 'judgments-jobs-fetch-articles', pattern: NEW_ARTICLES_INTERVAL, run: getNewArticlesForJobs}))
  .use(cron({name: 'judgments-jobs-send-to-llm', pattern: LLM_PROCESSING_INTERVAL, run: sendToLLMCron}))
  .use(cron({name: 'judgments-jobs-adjust-batch-size', pattern: ADJUST_BATCH_SIZE_INTERVAL, run: adjustBatchSizeCron}))
  .use(cron({name: 'judgments-jobs-cleanup-stale', pattern: CLEANUP_STALE_INTERVAL, run: cleanupStaleQueueCron}))
