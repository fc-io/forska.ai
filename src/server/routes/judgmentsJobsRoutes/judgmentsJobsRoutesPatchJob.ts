import {runAutomaticOrphanedQueueRepairForJob} from '../../cron/judgmentsJobs/judgmentJobRepair.ts'
import {assertJudgmentJobCanRunSqlitePreflight} from '../../cron/judgmentsJobs/judgmentJobSqlitePreflight.ts'
import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {updateJudgmentJobStatus} from '../../cron/judgmentsJobs/judgmentJobStatusMutation.ts'
import {
  getJudgmentJobStopConditionAssignments,
  parseJudgmentJobStopConditionUpdate,
} from '../../cron/judgmentsJobs/judgmentJobStopConditionInput.ts'
import {getFullTextStrategyLabelsById} from '../../fullText/fullTextStrategyRepository.ts'
import {assertStoredProviderModelRuntimeMatch} from '../../providers/providerRuntimeModelGuard.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {assertModelContextWindowResolvable} from '../../services/judgmentJobModelContextWindow.ts'
import {resetJudgmentJobProviderHealthForResume} from '../../services/judgmentJobProviderHealthService.ts'
import {HttpError} from '../../utils/httpError.ts'
import {assertJudgmentJobStopConditionsAllowResume} from './assertJudgmentJobStopConditionsAllowResume.ts'
import {assertProjectFullTextCanJudge} from './assertProjectFullTextCanJudge.ts'
import {getJobContext} from './getJobContext.ts'
import {getJudgmentJobMutationResponse} from './getJudgmentJobMutationResponse.ts'
import {assertJudgingRuntimeCanRun} from './judgingRuntime.ts'
import {judgmentJobServerId} from './judgmentJobServerId.ts'
import {logProviderHealthWriteFailure} from './logProviderHealthWriteFailure.ts'

const resetResumedJobProviderHealth = async (jobId: string): Promise<void> => {
  await resetJudgmentJobProviderHealthForResume({jobId}).catch((error: unknown) => {
    return logProviderHealthWriteFailure(jobId, error)
  })
}

const getFullTextStrategyReference = (labelsById: Map<string, string>, strategyId: string): string => {
  const label = labelsById.get(strategyId) ?? strategyId

  return label === strategyId ? strategyId : `${label} (${strategyId})`
}

const assertJudgmentJobFullTextStrategyCanResume = async ({
  jobId,
  projectFullTextStrategyId,
}: {
  jobId: string
  projectFullTextStrategyId: string
}): Promise<void> => {
  const storedFullTextStrategyId = getJudgmentJobSqliteService().getStoredFullTextStrategyId(jobId)

  if (storedFullTextStrategyId !== null && storedFullTextStrategyId !== projectFullTextStrategyId) {
    const labelsById = await getFullTextStrategyLabelsById(getAppDatabaseService(), [
      storedFullTextStrategyId,
      projectFullTextStrategyId,
    ])

    throw new HttpError(
      409,
      `The project's full-text strategy changed since this job started (${getFullTextStrategyReference(labelsById, storedFullTextStrategyId)} → ${getFullTextStrategyReference(labelsById, projectFullTextStrategyId)}). Start the job clean to judge with the new strategy.`,
    )
  }
}

const setJudgmentJobFullTextStrategyId = async (jobId: string, fullTextStrategyId: string): Promise<void> => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET full_text_strategy_id = ${getSqlLiteral(fullTextStrategyId)}
    WHERE id = ${getSqlLiteral(jobId)}
  `)
}

const getJudgmentJobStopConditionUpdate = (body: Parameters<typeof parseJudgmentJobStopConditionUpdate>[0]) => {
  const parsed = parseJudgmentJobStopConditionUpdate(body, new Date())

  if (!parsed.ok) {
    throw new HttpError(400, parsed.error)
  }

  return parsed.value
}

export const judgmentsJobsRoutesPatchJob = async ({
  params,
  body,
}: {
  params: {id: string}
  body: {
    status?:
      | 'not_started'
      | 'waiting_on_llm_connection'
      | 'waiting_on_db_connection'
      | 'running'
      | 'paused'
      | 'failed'
      | 'completed'
      | 'project_removed'
    error?: string[]
    stopAfterArticles?: boolean | number | string | null
    stopAfterTotalTokens?: boolean | number | string | null
    stopAt?: boolean | number | string | null
    stopWhenHumanAnsweredDone?: boolean | number | string | null
  }
}) => {
  const sqliteService = getJudgmentJobSqliteService()
  const stopConditionUpdate = getJudgmentJobStopConditionUpdate(body)
  let clearTransientQuarantine = false
  let isResume = false

  if (body.status === 'running') {
    await assertJudgmentJobStopConditionsAllowResume({jobId: params.id, update: stopConditionUpdate})
    await assertJudgingRuntimeCanRun()
    const {job, projectFullTextStrategyId, projectModelId} = await getJobContext({jobId: params.id})
    await assertStoredProviderModelRuntimeMatch({modelId: projectModelId})
    await assertModelContextWindowResolvable(projectModelId)
    await assertProjectFullTextCanJudge(job.projectId)

    if (!sqliteService.hasJob(params.id)) {
      await sqliteService.initializeJob(params.id)
    }

    if (job.storageState === 'active') {
      const preflightResult = await assertJudgmentJobCanRunSqlitePreflight({
        jobId: params.id,
        quarantineReason: job.quarantineReason,
        storageState: job.storageState,
      })

      clearTransientQuarantine = preflightResult.clearTransientQuarantine
    }

    if (job.storageState === 'active' || job.storageState === 'draining') {
      await runAutomaticOrphanedQueueRepairForJob({
        claimedBy: judgmentJobServerId,
        failOnIncomplete: true,
        jobId: params.id,
        preflightBeforeRepair: job.storageState === 'draining',
      })
    }

    const {job: repairedJob} = await getJobContext({jobId: params.id})
    const preflightResult = await assertJudgmentJobCanRunSqlitePreflight({
      jobId: params.id,
      quarantineReason: repairedJob.quarantineReason,
      storageState: repairedJob.storageState,
    })

    clearTransientQuarantine = clearTransientQuarantine || preflightResult.clearTransientQuarantine
    isResume = repairedJob.status !== 'running'
    await assertJudgmentJobFullTextStrategyCanResume({jobId: params.id, projectFullTextStrategyId})
    await sqliteService.fillMissingFullTextStrategyId(params.id, projectFullTextStrategyId)
    await setJudgmentJobFullTextStrategyId(params.id, projectFullTextStrategyId)
  }

  const updatedJob = await updateJudgmentJobStatus({
    clearTransientQuarantine,
    error: body.error,
    jobId: params.id,
    status: body.status,
    stopConditionAssignments: getJudgmentJobStopConditionAssignments(stopConditionUpdate),
  })

  if (!updatedJob) {
    throw new Error('Job not found')
  }

  if (isResume && updatedJob.status === 'running') {
    await resetResumedJobProviderHealth(params.id)
  }

  return {data: getJudgmentJobMutationResponse(updatedJob), error: null}
}
