import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {hasActiveDuckdbExclusiveWork, isDuckdbExclusiveWorkAdmissionError} from '../utils/duckdbExclusiveWork.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {writeRuntimeFailureLogEvent} from '../utils/runtimeLogger.ts'
import {isExpectedDuckdbOwnerRoleLossError, shouldCurrentServerRunMaintenanceLoops} from '../utils/serverRuntimeRole.ts'
import {type CronRuntimeTickName, cronRuntimeTickNames, recordCronRuntimeTick} from './cronRuntimeState.ts'
import {getDefaultJudgmentServerJobId} from './judgmentsJobs/judgmentJobServerIdentity.ts'
import {judgmentsJobsAddToQueue} from './judgmentsJobs/judgmentsJobsAddToQueue.ts'
import {judgmentsJobsCheckLLMStatus} from './judgmentsJobs/judgmentsJobsCheckLLMStatus.ts'
import {judgmentsJobsCleanupStale} from './judgmentsJobs/judgmentsJobsCleanupStale.ts'
import {judgmentsJobsSampleProviderTelemetry} from './judgmentsJobs/judgmentsJobsSampleProviderTelemetry.ts'
import {JUDGMENTS_IMPORT_STALE_AFTER_MS, getJudgmentsImportCronActivity} from './judgmentsJobsCronState.ts'
import {judgmentsJobsImportCron} from './judgmentsJobsImportCron.ts'

const serverJobId = getDefaultJudgmentServerJobId()

const cronLogger = createRateLimitedLogger({windowMs: 30_000})

const logJudgingCronError = (label: string, error: unknown) => {
  if (!isDuckdbExclusiveWorkAdmissionError(error) && !isExpectedDuckdbOwnerRoleLossError(error)) {
    writeRuntimeFailureLogEvent({
      attrs: {error},
      event: 'judgments.cron.failure',
      message: label,
      terminalArgs: [error instanceof Error ? error.message : error],
    })
  }
}

const shouldRunJudgmentMaintenanceCron = (): boolean => {
  return shouldCurrentServerRunMaintenanceLoops() && !hasActiveDuckdbExclusiveWork()
}

const shouldRunOperationalJudgmentCron = (cronName: CronRuntimeTickName): boolean => {
  if (shouldRunJudgmentMaintenanceCron()) {
    return true
  }

  recordCronRuntimeTick(cronName, 'skipped')
  return false
}

const recordJudgmentCronError = (cronName: CronRuntimeTickName, label: string, error: unknown) => {
  const status =
    isDuckdbExclusiveWorkAdmissionError(error) || isExpectedDuckdbOwnerRoleLossError(error) ? 'skipped' : 'failure'

  recordCronRuntimeTick(cronName, status, error)
  logJudgingCronError(label, error)
}

const NEW_ARTICLES_INTERVAL = '*/1 * * * * *'
const SAMPLE_PROVIDER_TELEMETRY = '*/30 * * * * *'
const CHECK_LLM_STATUS = '*/30 * * * * *'
const CLEANUP_STALE_REQUESTS = '0 */1 * * * *'
const START_DELAY_MS = 1000
const ADD_TO_QUEUE_STILL_RUNNING_WARN_AFTER_MS = 30_000

let isAddingToQueue = false
let addToQueueStartedAtMs: number | null = null
let isCheckingLlmStatus = false
let llmStatusCheckerStartedAtMs: number | null = null
let isSamplingProviderTelemetry = false
let providerTelemetrySamplerStartedAtMs: number | null = null

const runAddToQueue = async (): Promise<void> => {
  const cronName = cronRuntimeTickNames.addToQueue

  if (!shouldRunOperationalJudgmentCron(cronName)) return
  const importActivity = getJudgmentsImportCronActivity()
  if (importActivity.shouldBlockOtherJudgmentWork) {
    recordCronRuntimeTick(cronName, 'skipped')
    return
  }

  if (importActivity.stale) {
    cronLogger.warn('cron:add-to-queue:stale-import-latch', '[cron] stale importJudgments latch ignored', {
      runningForMs: importActivity.runningForMs,
      serverJobId,
      staleAfterMs: JUDGMENTS_IMPORT_STALE_AFTER_MS,
      staleRunId: importActivity.runId,
    })
  }

  if (isAddingToQueue) {
    const runningForMs = addToQueueStartedAtMs ? Date.now() - addToQueueStartedAtMs : null
    if (runningForMs !== null && runningForMs >= ADD_TO_QUEUE_STILL_RUNNING_WARN_AFTER_MS) {
      cronLogger.warn('cron:add-to-queue:already-running', '[cron] add-to-queue still running', {
        serverJobId,
        runningForMs,
        warnAfterMs: ADD_TO_QUEUE_STILL_RUNNING_WARN_AFTER_MS,
      })
    }
    recordCronRuntimeTick(cronName, 'skipped')
    return
  }

  isAddingToQueue = true
  addToQueueStartedAtMs = Date.now()
  recordCronRuntimeTick(cronName, 'started')
  try {
    await judgmentsJobsAddToQueue(serverJobId)
    recordCronRuntimeTick(cronName, 'success')
  } catch (err) {
    recordJudgmentCronError(cronName, '[cron] runAddToQueue error:', err)
  } finally {
    isAddingToQueue = false
    addToQueueStartedAtMs = null
  }
}

const checkLLMStatusCron = async (): Promise<void> => {
  const cronName = cronRuntimeTickNames.checkLlmStatus

  if (!shouldRunOperationalJudgmentCron(cronName)) return

  if (isCheckingLlmStatus) {
    const runningForMs = llmStatusCheckerStartedAtMs ? Date.now() - llmStatusCheckerStartedAtMs : null
    cronLogger.warn('cron:check-llm-status:already-running', '[cron] llm status checker still running', {
      runningForMs,
      serverJobId,
    })
    recordCronRuntimeTick(cronName, 'skipped')
    return
  }

  isCheckingLlmStatus = true
  llmStatusCheckerStartedAtMs = Date.now()
  recordCronRuntimeTick(cronName, 'started')
  try {
    await judgmentsJobsCheckLLMStatus()
    recordCronRuntimeTick(cronName, 'success')
  } catch (err) {
    recordJudgmentCronError(cronName, '[cron] checkLLMStatusCron error:', err)
  } finally {
    isCheckingLlmStatus = false
    llmStatusCheckerStartedAtMs = null
  }
}

const sampleProviderTelemetryCron = async (): Promise<void> => {
  const cronName = cronRuntimeTickNames.sampleProviderTelemetry

  if (!shouldRunOperationalJudgmentCron(cronName)) return

  if (isSamplingProviderTelemetry) {
    const runningForMs = providerTelemetrySamplerStartedAtMs ? Date.now() - providerTelemetrySamplerStartedAtMs : null
    cronLogger.warn(
      'cron:sample-provider-telemetry:already-running',
      '[cron] provider telemetry sampler still running',
      {runningForMs, serverJobId},
    )
    recordCronRuntimeTick(cronName, 'skipped')
    return
  }

  isSamplingProviderTelemetry = true
  providerTelemetrySamplerStartedAtMs = Date.now()
  recordCronRuntimeTick(cronName, 'started')

  try {
    await judgmentsJobsSampleProviderTelemetry()
    recordCronRuntimeTick(cronName, 'success')
  } catch (err) {
    recordJudgmentCronError(cronName, '[cron] sampleProviderTelemetryCron error:', err)
  } finally {
    isSamplingProviderTelemetry = false
    providerTelemetrySamplerStartedAtMs = null
  }
}

const cleanupStaleQueueCron = async (): Promise<void> => {
  const cronName = cronRuntimeTickNames.cleanupStale

  if (!shouldRunOperationalJudgmentCron(cronName)) return
  recordCronRuntimeTick(cronName, 'started')
  try {
    await judgmentsJobsCleanupStale()
    recordCronRuntimeTick(cronName, 'success')
  } catch (err) {
    recordJudgmentCronError(cronName, '[cron] cleanupStaleQueueCron error:', err)
  }
}

export const judgmentsJobsOperationalCron = new Elysia()
  .use(
    cron({
      name: cronRuntimeTickNames.addToQueue,
      pattern: NEW_ARTICLES_INTERVAL,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: runAddToQueue,
    }),
  )
  .use(judgmentsJobsImportCron)
  .use(
    cron({
      name: cronRuntimeTickNames.cleanupStale,
      pattern: CLEANUP_STALE_REQUESTS,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: cleanupStaleQueueCron,
    }),
  )
  .use(
    cron({
      name: cronRuntimeTickNames.sampleProviderTelemetry,
      pattern: SAMPLE_PROVIDER_TELEMETRY,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: sampleProviderTelemetryCron,
    }),
  )
  .use(
    cron({
      name: cronRuntimeTickNames.checkLlmStatus,
      pattern: CHECK_LLM_STATUS,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: checkLLMStatusCron,
    }),
  )
