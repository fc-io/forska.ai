import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import {parseDuckdbMemoryLimitToMiB} from '../utils/duckdbMemoryLimit.ts'
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
import {judgmentsJobsCronState} from './judgmentsJobsCronState.ts'

const serverJobId = getDefaultJudgmentServerJobId()

const LLM_PROCESSING_INTERVAL = '*/1 * * * * *'
const START_DELAY_MS = 1000
const lowMemoryJudgmentsWorkerDuckdbLimitMiB = 6400

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
  if (judgmentsJobsCronState.isImportingJudgments) return

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

export const judgmentsJobsJudgingCron = new Elysia().use(
  cron({
    name: 'judgments-jobs-send-to-llm',
    pattern: LLM_PROCESSING_INTERVAL,
    startAt: new Date(Date.now() + START_DELAY_MS),
    run: sendToLLM,
  }),
)
