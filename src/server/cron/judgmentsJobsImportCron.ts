import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {hasActiveProjectTransferBackgroundActivity} from '../services/projectTransfer/projectTransferBackgroundActivity.ts'
import {hasActiveDuckdbExclusiveWork, isDuckdbExclusiveWorkAdmissionError} from '../utils/duckdbExclusiveWork.ts'
import {writeRuntimeFailureLogEvent} from '../utils/runtimeLogger.ts'
import {isExpectedDuckdbOwnerRoleLossError, shouldCurrentServerRunMaintenanceLoops} from '../utils/serverRuntimeRole.ts'
import {cronRuntimeTickNames, recordCronRuntimeTick} from './cronRuntimeState.ts'
import {getDefaultJudgmentServerJobId} from './judgmentsJobs/judgmentJobServerIdentity.ts'
import {runJudgmentJobSqliteBackgroundImport} from './judgmentsJobs/judgmentJobSqliteBackgroundImport.ts'
import {judgmentsJobsCronState} from './judgmentsJobsCronState.ts'

const IMPORT_JUDGMENTS_INTERVAL = '*/1 * * * * *'
const START_DELAY_MS = 1000
const serverJobId = getDefaultJudgmentServerJobId()

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

  if (!shouldCurrentServerRunMaintenanceLoops() || judgmentsJobsCronState.isImportingJudgments) {
    recordCronRuntimeTick(cronName, 'skipped')
    return
  }

  if (hasActiveDuckdbExclusiveWork() || hasActiveProjectTransferBackgroundActivity()) {
    recordCronRuntimeTick(cronName, 'skipped')
    return
  }

  judgmentsJobsCronState.isImportingJudgments = true
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
    judgmentsJobsCronState.isImportingJudgments = false
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
