import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {env} from '../utils/env.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {getNewArticlesForJobs} from './judgmentsJobs/getNewArticlesForJobs.ts'
import {judgmentsJobsCheckLLMStatus} from './judgmentsJobs/judgmentsJobsCheckLLMStatus.ts'
import {judgmentsJobsCleanupStale} from './judgmentsJobs/judgmentsJobsCleanupStale.ts'
import {judgmentsJobsGetJobs} from './judgmentsJobs/judgmentsJobsGetJobs.ts'
import {judgmentsJobsSendToLLM} from './judgmentsJobs/judgmentsJobsSendToLLM.ts'

const serverJobId = `server-job-${crypto.randomUUID()}`

const NEW_ARTICLES_INTERVAL = '*/1 * * * * *'
const LLM_PROCESSING_INTERVAL = '*/1 * * * * *'
const CHECK_LLM_STATUS = '*/30 * * * * *'
const CLEANUP_STALE_REQUESTS = '0 */5 * * * *'
const START_DELAY_MS = 1000

let isRunningGetNewArticlesForJobs = false

const runGetNewArticlesForJobs = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING || env.GPU_TOTAL_GPUS === 0 || isRunningGetNewArticlesForJobs) return
  isRunningGetNewArticlesForJobs = true
  const db = getDatabase()
  await getNewArticlesForJobs(db, serverJobId)
  isRunningGetNewArticlesForJobs = false
}

const sendToLLMCron = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING || env.GPU_TOTAL_GPUS === 0) return

  const db = getDatabase()
  const allJobs = await judgmentsJobsGetJobs(db)
  await judgmentsJobsSendToLLM(db, allJobs, serverJobId)
}

const checkLLMStatusCron = async (): Promise<void> => {
  const db = getDatabase()
  await judgmentsJobsCheckLLMStatus(db)
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
      run: runGetNewArticlesForJobs,
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
      name: 'judgments-jobs-check-llm-status',
      pattern: CHECK_LLM_STATUS,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: checkLLMStatusCron,
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
