import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {env} from '../utils/env.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {judgmentsJobsAddToJobsQueue} from './judgmentsJobs/judgmentsJobsAddToJobsQueue.ts'
import {judgmentsJobsCleanupStale} from './judgmentsJobs/judgmentsJobsCleanupStale.ts'
import {judgmentsJobsGetJobs} from './judgmentsJobs/judgmentsJobsGetJobs.ts'
import {judgmentsJobsGetNewArticles} from './judgmentsJobs/judgmentsJobsGetNewArticles.ts'
import {judgmentsJobsSendToLLM} from './judgmentsJobs/judgmentsJobsSendToLLM.ts'

const serverJobId = `server-job-${crypto.randomUUID()}`

const NEW_ARTICLES_INTERVAL = '*/5 * * * * *' // Every 5 seconds
const LLM_PROCESSING_INTERVAL = '*/15 * * * * *' // Every 15 seconds
const CLEANUP_STALE_INTERVAL = '0 */5 * * * *' // Every 5 minutes

const getNewArticlesForJobs = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING) return
  const db = getDatabase()
  const allJobs = await judgmentsJobsGetJobs(db)
  const newArticlesToProcess = await judgmentsJobsGetNewArticles(db, allJobs)
  await judgmentsJobsAddToJobsQueue(db, newArticlesToProcess, serverJobId)
}

const sendToLLMCronJob = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING) return

  const db = getDatabase()
  await judgmentsJobsSendToLLM(db, serverJobId)
}

const cleanupStaleCronJob = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING) return
  const db = getDatabase()
  await judgmentsJobsCleanupStale(db)
}

export const judgmentsJobsCron = new Elysia()
  .use(cron({name: 'judgments-jobs-fetch-articles', pattern: NEW_ARTICLES_INTERVAL, run: getNewArticlesForJobs}))
  .use(cron({name: 'judgments-jobs-send-to-llm', pattern: LLM_PROCESSING_INTERVAL, run: sendToLLMCronJob}))
  .use(cron({name: 'judgments-jobs-cleanup-stale', pattern: CLEANUP_STALE_INTERVAL, run: cleanupStaleCronJob}))
