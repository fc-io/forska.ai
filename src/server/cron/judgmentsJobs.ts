import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {env} from '../utils/env.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {judgmentsJobsAddToQueue} from './judgmentsJobs/judgmentsJobsAddToQueue.ts'
import {judgmentsJobsCheckLLMStatus} from './judgmentsJobs/judgmentsJobsCheckLLMStatus.ts'
import {judgmentsJobsCleanupStale} from './judgmentsJobs/judgmentsJobsCleanupStale.ts'
import {judgmentsJobsGetRunningJobs} from './judgmentsJobs/judgmentsJobsGetRunningJobs.ts'
import {judgmentsJobsSendToLLM} from './judgmentsJobs/judgmentsJobsSendToLLM.ts'

const buildDefaultServerJobId = (): string => {
  const hostname = String(process.env.HOSTNAME ?? '').trim() || 'unknown-host'
  const port = String(env.API_SERVER_PORT)
  return `server-job-${hostname}-${port}`
}

const serverJobId = String(process.env.SERVER_JOB_ID ?? '').trim() || buildDefaultServerJobId()

const shouldRunJudgingCron = (): boolean => {
  return env.RUN_SERVER_JUDGING && !!env.SGLANG_MODEL && env.SGLANG_MODEL !== 'not set'
}

const NEW_ARTICLES_INTERVAL = '*/1 * * * * *'
const LLM_PROCESSING_INTERVAL = '*/1 * * * * *'
const CHECK_LLM_STATUS = '*/30 * * * * *'
const CLEANUP_STALE_REQUESTS = '0 */1 * * * *'
const START_DELAY_MS = 1000

let isAddingToQueue = false

const runAddToQueue = async (): Promise<void> => {
  if (!shouldRunJudgingCron() || isAddingToQueue) return
  isAddingToQueue = true
  try {
    const db = getDatabase()
    await judgmentsJobsAddToQueue(db, serverJobId)
  } catch (err) {
    console.error('[cron] runAddToQueue error:', err instanceof Error ? err.message : err)
  } finally {
    isAddingToQueue = false
  }
}

const sendToLLM = async (): Promise<void> => {
  if (!shouldRunJudgingCron()) return
  try {
    const db = getDatabase()
    const runningJobs = await judgmentsJobsGetRunningJobs(db)
    await judgmentsJobsSendToLLM(db, runningJobs, serverJobId)
  } catch (err) {
    console.error('[cron] sendToLLM error:', err instanceof Error ? err.message : err)
  }
}

const checkLLMStatusCron = async (): Promise<void> => {
  if (!shouldRunJudgingCron()) return
  try {
    const db = getDatabase()
    await judgmentsJobsCheckLLMStatus(db)
  } catch (err) {
    console.error('[cron] checkLLMStatusCron error:', err instanceof Error ? err.message : err)
  }
}

const cleanupStaleQueueCron = async (): Promise<void> => {
  try {
    const db = getDatabase()
    await judgmentsJobsCleanupStale(db)
  } catch (err) {
    console.error('[cron] cleanupStaleQueueCron error:', err instanceof Error ? err.message : err)
  }
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
