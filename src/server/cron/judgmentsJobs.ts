import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {env} from '../utils/env.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {judgmentsJobsAddToQueue} from './judgmentsJobs/judgmentsJobsAddToQueue.ts'
import {judgmentsJobsCheckLLMStatus} from './judgmentsJobs/judgmentsJobsCheckLLMStatus.ts'
import {judgmentsJobsCleanupStale} from './judgmentsJobs/judgmentsJobsCleanupStale.ts'
import {judgmentsJobsGetRunningJobs} from './judgmentsJobs/judgmentsJobsGetRunningJobs.ts'
import {judgmentsJobsSendToLLM} from './judgmentsJobs/judgmentsJobsSendToLLM.ts'

const serverJobId = `server-job-${crypto.randomUUID()}`

const NEW_ARTICLES_INTERVAL = '*/1 * * * * *'
const LLM_PROCESSING_INTERVAL = '*/1 * * * * *'
const CHECK_LLM_STATUS = '*/30 * * * * *'
const CLEANUP_STALE_REQUESTS = '0 */1 * * * *'
const START_DELAY_MS = 1000

let isAddingToQueue = false

const runAddToQueue = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING || env.GPU_TOTAL_GPUS === 0 || isAddingToQueue) return
  isAddingToQueue = true
  const db = getDatabase()
  await judgmentsJobsAddToQueue(db, serverJobId)
  isAddingToQueue = false
}

const sendToLLM = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING || env.GPU_TOTAL_GPUS === 0) return

  const db = getDatabase()
  const runningJobs = await judgmentsJobsGetRunningJobs(db)
  await judgmentsJobsSendToLLM(db, runningJobs, serverJobId)
}

const checkLLMStatusCron = async (): Promise<void> => {
  if (!env.RUN_SERVER_JUDGING || env.GPU_TOTAL_GPUS === 0) return
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
      name: 'judgments-jobs-add-to-queue',
      pattern: NEW_ARTICLES_INTERVAL,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: runAddToQueue,
    }),
  )
  .use(
    cron({
      name: 'judgments-jobs-send-to-llm',
      pattern: LLM_PROCESSING_INTERVAL,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: sendToLLM,
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
