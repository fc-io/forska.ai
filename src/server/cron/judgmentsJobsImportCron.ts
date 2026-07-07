import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {writeRuntimeFailureLogEvent} from '../utils/runtimeLogger.ts'
import {isExpectedDuckdbOwnerRoleLossError, shouldCurrentServerRunMaintenanceLoops} from '../utils/serverRuntimeRole.ts'
import {getDefaultJudgmentServerJobId} from './judgmentsJobs/judgmentJobServerIdentity.ts'
import {runJudgmentJobSqliteBackgroundImport} from './judgmentsJobs/judgmentJobSqliteBackgroundImport.ts'
import {judgmentsJobsCronState} from './judgmentsJobsCronState.ts'

const IMPORT_JUDGMENTS_INTERVAL = '*/1 * * * * *'
const START_DELAY_MS = 1000
const serverJobId = getDefaultJudgmentServerJobId()

const logImportCronError = (label: string, error: unknown) => {
  if (!isExpectedDuckdbOwnerRoleLossError(error)) {
    writeRuntimeFailureLogEvent({
      attrs: {error},
      event: 'judgments.cron.failure',
      message: label,
      terminalArgs: [error instanceof Error ? error.message : error],
    })
  }
}

export const importJudgmentsCron = async (): Promise<void> => {
  if (!shouldCurrentServerRunMaintenanceLoops() || judgmentsJobsCronState.isImportingJudgments) return

  judgmentsJobsCronState.isImportingJudgments = true

  try {
    await runJudgmentJobSqliteBackgroundImport({claimedBy: serverJobId})
  } catch (err) {
    logImportCronError('[cron] importJudgmentsCron error:', err)
  } finally {
    judgmentsJobsCronState.isImportingJudgments = false
  }
}

export const judgmentsJobsImportCron = new Elysia().use(
  cron({
    name: 'judgments-jobs-import-judgments',
    pattern: IMPORT_JUDGMENTS_INTERVAL,
    startAt: new Date(Date.now() + START_DELAY_MS),
    run: importJudgmentsCron,
  }),
)
