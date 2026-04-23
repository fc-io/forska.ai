import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {parseDuckdbMemoryLimitToMiB} from '../utils/duckdbMemoryLimit.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {writeRuntimeFailureLogEvent} from '../utils/runtimeLogger.ts'
import {
  isExpectedDuckdbOwnerRoleLossError,
  shouldCurrentServerRunJudgingLoops,
  shouldCurrentServerRunMaintenanceLoops,
} from '../utils/serverRuntimeRole.ts'
import {getDefaultJudgmentServerJobId} from './judgmentsJobs/judgmentJobServerIdentity.ts'
import {runJudgmentJobSqliteBackgroundImport} from './judgmentsJobs/judgmentJobSqliteBackgroundImport.ts'
import {getJudgmentJobSqliteService} from './judgmentsJobs/judgmentJobSqliteService.ts'
import {judgmentsJobsAddToQueue} from './judgmentsJobs/judgmentsJobsAddToQueue.ts'
import {judgmentsJobsCheckLLMStatus} from './judgmentsJobs/judgmentsJobsCheckLLMStatus.ts'
import {judgmentsJobsCleanupStale} from './judgmentsJobs/judgmentsJobsCleanupStale.ts'
import {judgmentsJobsGetRunningJobs} from './judgmentsJobs/judgmentsJobsGetRunningJobs.ts'
import {judgmentsJobsSendToLLM} from './judgmentsJobs/judgmentsJobsSendToLLM.ts'

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

const shouldRunJudgingCron = (): boolean => {
  return shouldCurrentServerRunJudgingLoops()
}

const shouldRunJudgmentMaintenanceCron = (): boolean => {
  return shouldCurrentServerRunMaintenanceLoops()
}

const NEW_ARTICLES_INTERVAL = '*/1 * * * * *'
const LLM_PROCESSING_INTERVAL = '*/1 * * * * *'
const IMPORT_JUDGMENTS_INTERVAL = '*/1 * * * * *'
const CHECK_LLM_STATUS = '*/30 * * * * *'
const CLEANUP_STALE_REQUESTS = '0 */1 * * * *'
const START_DELAY_MS = 1000
const lowMemoryJudgmentsWorkerDuckdbLimitMiB = 6400

let isAddingToQueue = false
let addToQueueStartedAtMs: number | null = null
let isImportingJudgments = false

const shouldUseLowMemoryJudgmentsCronMode = () => {
  const workerDuckdbMemoryLimitMiB = parseDuckdbMemoryLimitToMiB(process.env.DUCKDB_MEMORY_LIMIT)
  return workerDuckdbMemoryLimitMiB !== null && workerDuckdbMemoryLimitMiB <= lowMemoryJudgmentsWorkerDuckdbLimitMiB
}

const runAddToQueue = async (): Promise<void> => {
  if (!shouldRunJudgmentMaintenanceCron()) return
  if (isImportingJudgments) return

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
    logJudgingCronError('[cron] runAddToQueue error:', err)
  } finally {
    isAddingToQueue = false
    addToQueueStartedAtMs = null
  }
}

const sendToLLM = async (): Promise<void> => {
  if (!shouldRunJudgingCron()) return
  if (isImportingJudgments) return
  try {
    const runningJobs = await judgmentsJobsGetRunningJobs({applyRuntimeMatchFilter: false})
    if (shouldRunJudgmentMaintenanceCron()) {
      await getJudgmentJobSqliteService().syncOwnedLeases(
        runningJobs.map((job) => {
          return job.id
        }),
      )
    }
    if (!shouldRunJudgingCron()) return
    await judgmentsJobsSendToLLM(runningJobs, serverJobId, {
      filterJobs: shouldUseLowMemoryJudgmentsCronMode()
        ? async (jobs: typeof runningJobs) => {
            return jobs
          }
        : undefined,
    })
    if (shouldRunJudgmentMaintenanceCron()) {
      await getJudgmentJobSqliteService().publishHealthProjections(
        runningJobs.map((job) => {
          return job.id
        }),
      )
    }
  } catch (err) {
    logJudgingCronError('[cron] sendToLLM error:', err)
  }
}

const importJudgmentsCron = async (): Promise<void> => {
  if (!shouldRunJudgmentMaintenanceCron() || isImportingJudgments || shouldUseLowMemoryJudgmentsCronMode()) return

  isImportingJudgments = true

  try {
    await runJudgmentJobSqliteBackgroundImport({claimedBy: serverJobId})
  } catch (err) {
    logJudgingCronError('[cron] importJudgmentsCron error:', err)
  } finally {
    isImportingJudgments = false
  }
}

const checkLLMStatusCron = async (): Promise<void> => {
  if (!shouldRunJudgingCron()) return
  try {
    await judgmentsJobsCheckLLMStatus()
  } catch (err) {
    logJudgingCronError('[cron] checkLLMStatusCron error:', err)
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
      name: 'judgments-jobs-import-judgments',
      pattern: IMPORT_JUDGMENTS_INTERVAL,
      startAt: new Date(Date.now() + START_DELAY_MS),
      run: importJudgmentsCron,
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
