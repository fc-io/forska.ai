import {cron} from '@elysiajs/cron'
import {addMinutes} from 'date-fns'
import {Elysia} from 'elysia'

import {env} from '../utils/env.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {getNumberOfArticlesInReadyQueue} from './judgmentsJobs/getNumberOfArticlesInReadyQueue.ts'
import {isReadyToGetMoreArticles} from './judgmentsJobs/isReadyToGetMoreArticles.ts'
import {judgmentsJobsAddToJobsQueue} from './judgmentsJobs/judgmentsJobsAddToJobsQueue.ts'
import {judgmentsJobsAdjustBatchSize} from './judgmentsJobs/judgmentsJobsAdjustBatchSize.ts'
import {judgmentsJobsCheckVLLMStatus} from './judgmentsJobs/judgmentsJobsCheckVLLMStatus.ts'
import {judgmentsJobsCleanupStale} from './judgmentsJobs/judgmentsJobsCleanupStale.ts'
import {judgmentsJobsGetJobs} from './judgmentsJobs/judgmentsJobsGetJobs.ts'
import {judgmentsJobsGetNewArticles} from './judgmentsJobs/judgmentsJobsGetNewArticles.ts'
import {judgmentsJobsSendToLLM} from './judgmentsJobs/judgmentsJobsSendToLLM.ts'

export const MAX_ARTICLES_BATCH_SIZE = 15
const serverJobId = `server-job-${crypto.randomUUID()}`

const NEW_ARTICLES_INTERVAL = '*/3 * * * * *'
const LLM_PROCESSING_INTERVAL = '*/9 * * * * *'
const BATCH_SIZE_WARMUP = '0 * * * * *'
const BATCH_SIZE_ADJUST = '0 */1 * * * *'
const CHECK_VLLM_STATUS = '0 * * * * *'
const CLEANUP_STALE_REQUESTS = '0 */5 * * * *'
const START_DELAY_MS = 1000

const getNewArticlesForJobs = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING) return
  const db = getDatabase()
  const numberOfArticlesInReadyQueue = await getNumberOfArticlesInReadyQueue(db, serverJobId)
  const allJobs = await judgmentsJobsGetJobs(db)

  if (isReadyToGetMoreArticles(numberOfArticlesInReadyQueue, allJobs)) {
    const newArticlesToProcess = await judgmentsJobsGetNewArticles(db, allJobs)
    const totalArticles = newArticlesToProcess.reduce((sum, job) => {
      return sum + job.articlesToJudgeIds.length
    }, 0)
    console.log(`newArticlesToProcess | jobs: ${newArticlesToProcess.length}, totalArticles: ${totalArticles}`)
    if (totalArticles > 0) {
      await judgmentsJobsAddToJobsQueue(db, newArticlesToProcess, serverJobId)
    }
  }
}

const sendToLLMCron = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING) return

  const db = getDatabase()
  const allJobs = await judgmentsJobsGetJobs(db)
  await judgmentsJobsSendToLLM(db, allJobs, serverJobId)
}
const adjustBatchSizeCron = async (phase: string): Promise<void> => {
  console.log(`~~~adjustBatchSizeCron ${phase} 1.~~~`)
  const db = getDatabase()
  await judgmentsJobsAdjustBatchSize(db)
}

const checkVLLMStatusCron = async (): Promise<void> => {
  const db = getDatabase()
  await judgmentsJobsCheckVLLMStatus(db)
}

const cleanupStaleQueueCron = async (): Promise<void> => {
  // if (!env.RUN_SERVER_JUDGING) return
  const db = getDatabase()
  await judgmentsJobsCleanupStale(db)
}

export const judgmentsJobsCron = new Elysia()
  .use(
    cron({
      name: 'judgments-jobs-fetch-articles',
      pattern: NEW_ARTICLES_INTERVAL,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: getNewArticlesForJobs,
    }),
  )
  .use(
    cron({
      name: 'judgments-jobs-send-to-llm',
      pattern: LLM_PROCESSING_INTERVAL,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: sendToLLMCron,
    }),
  )
  .use(
    cron({
      name: 'judgments-jobs-batch-size-warmup',
      pattern: BATCH_SIZE_WARMUP,
      startAt: new Date(Date.now() + START_DELAY_MS),
      maxRuns: 5,
      run: () => {
        return adjustBatchSizeCron('BATCH_SIZE_WARMUP')
      },
    }),
  )
  .use(
    cron({
      name: 'judgments-jobs-batch-size-adjust',
      pattern: BATCH_SIZE_ADJUST,
      startAt: addMinutes(new Date(), 6),
      run: () => {
        return adjustBatchSizeCron('BATCH_SIZE_ADJUST')
      },
    }),
  )
  .use(
    cron({
      name: 'judgments-jobs-check-vllm-status',
      pattern: CHECK_VLLM_STATUS,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: checkVLLMStatusCron,
    }),
  )
  .use(
    cron({
      name: 'judgments-jobs-cleanup-stale',
      pattern: CLEANUP_STALE_REQUESTS,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: cleanupStaleQueueCron,
    }),
  )
