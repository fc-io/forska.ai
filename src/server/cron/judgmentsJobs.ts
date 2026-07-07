import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {writeRuntimeFailureLogEvent} from '../utils/runtimeLogger.ts'
import {isExpectedDuckdbOwnerRoleLossError, shouldCurrentServerRunMaintenanceLoops} from '../utils/serverRuntimeRole.ts'
import {getDefaultJudgmentServerJobId} from './judgmentsJobs/judgmentJobServerIdentity.ts'
import {judgmentsJobsAddToQueue} from './judgmentsJobs/judgmentsJobsAddToQueue.ts'
import {judgmentsJobsCheckLLMStatus} from './judgmentsJobs/judgmentsJobsCheckLLMStatus.ts'
import {judgmentsJobsCleanupStale} from './judgmentsJobs/judgmentsJobsCleanupStale.ts'
import {judgmentsJobsSampleProviderTelemetry} from './judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts'
import {judgmentsJobsCronState} from './judgmentsJobsCronState.ts'
import {importJudgmentsCron} from './judgmentsJobsImportCron.ts'

const serverJobId = getDefaultJudgmentServerJobId()

const cronLogger = createRateLimitedLogger({windowMs: 30_000})

const logJudgingCronError = (label: string, error: unknown) => {
  if (!isExpectedDuckdbOwnerRoleLossError(error)) {
    writeRuntimeFailureLogEvent({
      attrs: {error},
      event: 'judgments.cron.failure',
      message: label,
      terminalArgs: [error instanceof Error ? error.message : error],
    })
  }
}

const shouldRunJudgmentMaintenanceCron = (): boolean => {
  return shouldCurrentServerRunMaintenanceLoops()
}

const NEW_ARTICLES_INTERVAL = '*/1 * * * * *'
const IMPORT_JUDGMENTS_INTERVAL = '*/1 * * * * *'
const SAMPLE_PROVIDER_TELEMETRY = '*/30 * * * * *'
const CHECK_LLM_STATUS = '*/30 * * * * *'
const CLEANUP_STALE_REQUESTS = '0 */1 * * * *'
const START_DELAY_MS = 1000
const ADD_TO_QUEUE_STILL_RUNNING_WARN_AFTER_MS = 30_000

let isAddingToQueue = false
let addToQueueStartedAtMs: number | null = null
let isSamplingProviderTelemetry = false
let providerTelemetrySamplerStartedAtMs: number | null = null

const runAddToQueue = async (): Promise<void> => {
  if (!shouldRunJudgmentMaintenanceCron()) return
  if (judgmentsJobsCronState.isImportingJudgments) return

  if (isAddingToQueue) {
    const runningForMs = addToQueueStartedAtMs ? Date.now() - addToQueueStartedAtMs : null
    if (runningForMs !== null && runningForMs >= ADD_TO_QUEUE_STILL_RUNNING_WARN_AFTER_MS) {
      cronLogger.warn('cron:add-to-queue:already-running', '[cron] add-to-queue still running', {
        serverJobId,
        runningForMs,
        warnAfterMs: ADD_TO_QUEUE_STILL_RUNNING_WARN_AFTER_MS,
      })
    }
    return
  }

  isAddingToQueue = true
  addToQueueStartedAtMs = Date.now()
  try {
    await judgmentsJobsAddToQueue(serverJobId)
  } catch (err) {
    logJudgingCronError('[cron] runAddToQueue error:', err)
  } finally {
    isAddingToQueue = false
    addToQueueStartedAtMs = null
  }
}

const checkLLMStatusCron = async (): Promise<void> => {
  if (!shouldRunJudgmentMaintenanceCron()) return
  try {
    await judgmentsJobsCheckLLMStatus()
  } catch (err) {
    logJudgingCronError('[cron] checkLLMStatusCron error:', err)
  }
}

const sampleProviderTelemetryCron = async (): Promise<void> => {
  if (!shouldRunJudgmentMaintenanceCron()) return

  if (isSamplingProviderTelemetry) {
    const runningForMs = providerTelemetrySamplerStartedAtMs ? Date.now() - providerTelemetrySamplerStartedAtMs : null
    cronLogger.warn(
      'cron:sample-provider-telemetry:already-running',
      '[cron] provider telemetry sampler still running',
      {runningForMs, serverJobId},
    )
    return
  }

  isSamplingProviderTelemetry = true
  providerTelemetrySamplerStartedAtMs = Date.now()

  try {
    await judgmentsJobsSampleProviderTelemetry()
  } catch (err) {
    logJudgingCronError('[cron] sampleProviderTelemetryCron error:', err)
  } finally {
    isSamplingProviderTelemetry = false
    providerTelemetrySamplerStartedAtMs = null
  }
}

const cleanupStaleQueueCron = async (): Promise<void> => {
  if (!shouldRunJudgmentMaintenanceCron()) return
  try {
    await judgmentsJobsCleanupStale()
  } catch (err) {
    logJudgingCronError('[cron] cleanupStaleQueueCron error:', err)
  }
}

export const judgmentsJobsMaintenanceCron = new Elysia()
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
      name: 'judgments-jobs-import-judgments',
      pattern: IMPORT_JUDGMENTS_INTERVAL,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: importJudgmentsCron,
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
  .use(
    cron({
      name: 'judgments-jobs-sample-provider-telemetry',
      pattern: SAMPLE_PROVIDER_TELEMETRY,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: sampleProviderTelemetryCron,
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
