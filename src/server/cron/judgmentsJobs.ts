import {hostname} from 'node:os'

import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {env} from '../utils/env.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {shouldCurrentServerRunWriterWork} from '../utils/serverRuntimeRole.ts'
import {judgmentsJobsAddToQueue} from './judgmentsJobs/judgmentsJobsAddToQueue.ts'
import {judgmentsJobsCheckLLMStatus} from './judgmentsJobs/judgmentsJobsCheckLLMStatus.ts'
import {judgmentsJobsCleanupStale} from './judgmentsJobs/judgmentsJobsCleanupStale.ts'
import {judgmentsJobsGetRunningJobs} from './judgmentsJobs/judgmentsJobsGetRunningJobs.ts'
import {judgmentsJobsSendToLLM} from './judgmentsJobs/judgmentsJobsSendToLLM.ts'

const buildDefaultServerJobId = (): string => {
  const normalizedHostname = hostname().trim() || 'unknown-host'
  const port = String(env.API_SERVER_PORT)
  return `server-job-${normalizedHostname}-${port}-${process.pid}`
}

const serverJobId = buildDefaultServerJobId()

const cronLogger = createRateLimitedLogger({windowMs: 30_000})

const shouldRunJudgingCron = (): boolean => {
  return env.RUN_SERVER_JUDGING && shouldCurrentServerRunWriterWork()
}

const NEW_ARTICLES_INTERVAL = '*/1 * * * * *'
const LLM_PROCESSING_INTERVAL = '*/1 * * * * *'
const CHECK_LLM_STATUS = '*/30 * * * * *'
const CLEANUP_STALE_REQUESTS = '0 */1 * * * *'
const START_DELAY_MS = 1000

let isAddingToQueue = false
let addToQueueStartedAtMs: number | null = null

const runAddToQueue = async (): Promise<void> => {
  if (!shouldRunJudgingCron()) return

  if (isAddingToQueue) {
    const runningForMs = addToQueueStartedAtMs ? Date.now() - addToQueueStartedAtMs : null
    cronLogger.warn('cron:add-to-queue:already-running', '[cron] add-to-queue still running', {
      serverJobId,
      runningForMs,
    })
    return
  }

  isAddingToQueue = true
  addToQueueStartedAtMs = Date.now()
  try {
    await judgmentsJobsAddToQueue(serverJobId)
  } catch (err) {
    console.error('[cron] runAddToQueue error:', err instanceof Error ? err.message : err)
  } finally {
    isAddingToQueue = false
    addToQueueStartedAtMs = null
  }
}

const sendToLLM = async (): Promise<void> => {
  if (!shouldRunJudgingCron()) return
  try {
    const runningJobs = await judgmentsJobsGetRunningJobs()
    await judgmentsJobsSendToLLM(runningJobs, serverJobId)
  } catch (err) {
    console.error('[cron] sendToLLM error:', err instanceof Error ? err.message : err)
  }
}

const checkLLMStatusCron = async (): Promise<void> => {
  if (!shouldRunJudgingCron()) return
  try {
    await judgmentsJobsCheckLLMStatus()
  } catch (err) {
    console.error('[cron] checkLLMStatusCron error:', err instanceof Error ? err.message : err)
  }
}

const cleanupStaleQueueCron = async (): Promise<void> => {
  if (!shouldCurrentServerRunWriterWork()) return
  try {
    await judgmentsJobsCleanupStale()
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
