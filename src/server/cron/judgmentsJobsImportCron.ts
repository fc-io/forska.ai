import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {hasActiveProjectTransferBackgroundActivity} from '../services/projectTransfer/projectTransferBackgroundActivity.ts'
import {hasActiveDuckdbExclusiveWork, isDuckdbExclusiveWorkAdmissionError} from '../utils/duckdbExclusiveWork.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {writeRuntimeFailureLogEvent} from '../utils/runtimeLogger.ts'
import {isExpectedDuckdbOwnerRoleLossError, shouldCurrentServerRunMaintenanceLoops} from '../utils/serverRuntimeRole.ts'
import {cronRuntimeTickNames, recordCronRuntimeTick} from './cronRuntimeState.ts'
import {getDefaultJudgmentServerJobId} from './judgmentsJobs/judgmentJobServerIdentity.ts'
import {runJudgmentJobSqliteBackgroundImport} from './judgmentsJobs/judgmentJobSqliteBackgroundImport.ts'
import {
  JUDGMENTS_IMPORT_STALE_AFTER_MS,
  beginJudgmentsImportCronRun,
  finishJudgmentsImportCronRun,
  getJudgmentsImportCronActivity,
} from './judgmentsJobsCronState.ts'

const IMPORT_JUDGMENTS_INTERVAL = '*/1 * * * * *'
const START_DELAY_MS = 1000
const serverJobId = getDefaultJudgmentServerJobId()
const cronLogger = createRateLimitedLogger({windowMs: 30_000})

const logImportCronError = (label: string, error: unknown) => {
  if (!isDuckdbExclusiveWorkAdmissionError(error) && !isExpectedDuckdbOwnerRoleLossError(error)) {
    writeRuntimeFailureLogEvent({
      attrs: {error},
      event: 'judgments.cron.failure',
      message: label,
      terminalArgs: [error instanceof Error ? error.message : error],
    })
  }
}

export const importJudgmentsCron = async (): Promise<void> => {
  const cronName = cronRuntimeTickNames.importJudgments

  if (!shouldCurrentServerRunMaintenanceLoops()) {
    recordCronRuntimeTick(cronName, 'skipped')
    return
  }

  const importActivity = getJudgmentsImportCronActivity()
  if (importActivity.shouldBlockOtherJudgmentWork) {
    recordCronRuntimeTick(cronName, 'skipped')
    return
  }

  if (importActivity.stale) {
    cronLogger.warn('cron:import-judgments:stale-latch', '[cron] stale importJudgments latch ignored', {
      runningForMs: importActivity.runningForMs,
      serverJobId,
      staleAfterMs: JUDGMENTS_IMPORT_STALE_AFTER_MS,
      staleRunId: importActivity.runId,
    })
  }

  if (hasActiveDuckdbExclusiveWork() || hasActiveProjectTransferBackgroundActivity()) {
    recordCronRuntimeTick(cronName, 'skipped')
    return
  }

  const importRunId = beginJudgmentsImportCronRun()
  recordCronRuntimeTick(cronName, 'started')

  try {
    await runJudgmentJobSqliteBackgroundImport({claimedBy: serverJobId})
    recordCronRuntimeTick(cronName, 'success')
  } catch (err) {
    recordCronRuntimeTick(
      cronName,
      isDuckdbExclusiveWorkAdmissionError(err) || isExpectedDuckdbOwnerRoleLossError(err) ? 'skipped' : 'failure',
      err,
    )
    logImportCronError('[cron] importJudgmentsCron error:', err)
  } finally {
    finishJudgmentsImportCronRun(importRunId)
  }
}

export const judgmentsJobsImportCron = new Elysia().use(
  cron({
    name: cronRuntimeTickNames.importJudgments,
    pattern: IMPORT_JUDGMENTS_INTERVAL,
    startAt: new Date(Date.now() + START_DELAY_MS),
    run: importJudgmentsCron,
  }),
)
