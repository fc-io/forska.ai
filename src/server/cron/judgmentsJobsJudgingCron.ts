import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {parseDuckdbMemoryLimitToMiB} from '../utils/duckdbMemoryLimit.ts'
import {beginProcessActivity, finishProcessActivity} from '../utils/processActivityState.ts'
import {writeRuntimeFailureLogEvent} from '../utils/runtimeLogger.ts'
import {
  isExpectedDuckdbOwnerRoleLossError,
  shouldCurrentServerRunJudgingLoops,
  shouldCurrentServerRunMaintenanceLoops,
} from '../utils/serverRuntimeRole.ts'
import {getDefaultJudgmentServerJobId} from './judgmentsJobs/judgmentJobServerIdentity.ts'
import {getJudgmentJobSqliteService} from './judgmentsJobs/judgmentJobSqliteService.ts'
import {judgmentsJobsGetRunningJobs} from './judgmentsJobs/judgmentsJobsGetRunningJobs.ts'
import {judgmentsJobsSendToLLM} from './judgmentsJobs/judgmentsJobsSendToLLM.ts'
import {getJudgmentsImportCronActivity} from './judgmentsJobsCronState.ts'

const serverJobId = getDefaultJudgmentServerJobId()

const LLM_PROCESSING_INTERVAL = '*/1 * * * * *'
const START_DELAY_MS = 1000
const lowMemoryJudgmentsWorkerDuckdbLimitMiB = 6400

let isSendingToLLM = false

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

const shouldUseLowMemoryJudgmentsCronMode = () => {
  const workerDuckdbMemoryLimitMiB = parseDuckdbMemoryLimitToMiB(process.env.DUCKDB_MEMORY_LIMIT)
  return workerDuckdbMemoryLimitMiB !== null && workerDuckdbMemoryLimitMiB <= lowMemoryJudgmentsWorkerDuckdbLimitMiB
}

const sendToLLM = async (): Promise<void> => {
  if (!shouldRunJudgingCron()) return
  if (getJudgmentsImportCronActivity().shouldBlockOtherJudgmentWork) return
  if (isSendingToLLM) return

  isSendingToLLM = true
  const activityId = beginProcessActivity({
    category: 'judgment-cron',
    details: {serverJobId},
    label: 'Judgment jobs Send To LLM',
  })
  try {
    const runningJobs = await judgmentsJobsGetRunningJobs({applyRuntimeMatchFilter: false})
    const runningJobIds = runningJobs.map((job) => {
      return job.id
    })
    await getJudgmentJobSqliteService().syncOwnedLeases(runningJobIds)
    if (!shouldRunJudgingCron()) {
      finishProcessActivity(activityId, {details: {runningJobCount: runningJobIds.length}, status: 'skipped'})
      return
    }
    await judgmentsJobsSendToLLM(runningJobs, serverJobId, {
      filterJobs: shouldUseLowMemoryJudgmentsCronMode()
        ? async (jobs: typeof runningJobs) => {
            return jobs
          }
        : undefined,
    })
    if (shouldRunJudgmentMaintenanceCron()) {
      await getJudgmentJobSqliteService().publishHealthProjections(runningJobIds)
    }
    finishProcessActivity(activityId, {details: {runningJobCount: runningJobIds.length}, status: 'completed'})
  } catch (err) {
    finishProcessActivity(activityId, {error: err, status: 'failed'})
    logJudgingCronError('[cron] sendToLLM error:', err)
  } finally {
    isSendingToLLM = false
  }
}

export const judgmentsJobsJudgingCron = new Elysia().use(
  cron({
    name: 'judgments-jobs-send-to-llm',
    pattern: LLM_PROCESSING_INTERVAL,
    startAt: new Date(Date.now() + START_DELAY_MS),
    run: sendToLLM,
  }),
)
