import {getSystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {getProjectFullTextStrategyIdSql} from '../../fullText/fullTextStrategy.ts'
import {getDateValue} from '../../services/appQueryHelpers.ts'
import {getJudgmentImportConsumerAvailability} from './getJudgmentImportConsumerAvailability.ts'
import {getJudgmentImportWorkLeasesByJobId} from './getJudgmentImportWorkLeasesByJobId.ts'
import {getJudgmentJobControlPlaneDiagnostics} from './getJudgmentJobControlPlaneDiagnostics.ts'
import {getJudgmentJobEndpointHealth} from './getJudgmentJobEndpointHealth.ts'
import {getJudgmentJobHealthProgress} from './getJudgmentJobHealthProgress.ts'
import {getJudgmentJobsReadDatabase} from './getJudgmentJobsReadDatabase.ts'
import {getJudgmentJobWorkIdentity} from './getJudgmentJobWorkIdentity.ts'
import {getMaintenanceUnavailableError} from './getMaintenanceUnavailableError.ts'
import {getProviderHealthApi} from './getProviderHealthApi.ts'
import {getRecommendedHealthAction} from './getRecommendedHealthAction.ts'
import type {JudgmentJobHealthAction} from './judgmentJobHealthTypes.ts'
import {hasOrphanedJudgedQueue, hasRetainedOutbox, isStaleImportJob} from './judgmentJobStorageHealth.ts'
import {getProgressStateCounts} from './judgmentsJobsRoutesGetJobsHealth/getProgressStateCounts.ts'
import {getProviderHealthMapForReadableRoute} from './providerHealthForReadableRoute.ts'
import {runJudgmentJobsRead} from './runJudgmentJobsRead.ts'
import {getSqliteHealthMapForReadableRoute} from './sqliteHealthForReadableRoute.ts'

const isHealthyJob = ({action, job}: {action: JudgmentJobHealthAction; job: {storageState: string}}) => {
  return job.storageState === 'active' && action === 'none'
}

export const judgmentsJobsRoutesGetJobsHealth = async ({request}: {request: Request}) => {
  return runJudgmentJobsRead({
    operation: async () => {
      const db = getJudgmentJobsReadDatabase()
      const currentNow = new Date()
      const jobs = await db.queryJson<{
        id: string
        status: string
        projectId: string
        projectModelId: string
        systemPromptVariant: string | null
        fullTextStrategyId: string
        useTitle: boolean | null
        useAbstract: boolean | null
        useFulltext: boolean | null
        useFulltextNoImages: boolean | null
        useMetadata: boolean | null
        storageState: string
        quarantinedAt: unknown
        quarantineReason: string | null
        lastImportStartedAt: unknown
        lastImportCompletedAt: unknown
        lastImportErrorAt: unknown
        lastImportError: string | null
        lastImportExitCode: number | null
        importFailureCount: number | null
        pauseRequestedAt: unknown
      }>(`
        SELECT
          jj.id AS id,
          jj.status AS status,
          jj.project_id AS projectId,
          COALESCE(p.model_id, '') AS projectModelId,
          p.system_prompt_variant AS systemPromptVariant,
          COALESCE(jj.full_text_strategy_id, ${getProjectFullTextStrategyIdSql('p')}) AS fullTextStrategyId,
          p.use_title AS useTitle,
          p.use_abstract AS useAbstract,
          p.use_fulltext AS useFulltext,
          p.use_fulltext_no_images AS useFulltextNoImages,
          COALESCE(p.use_metadata, FALSE) AS useMetadata,
          jj.storage_state AS storageState,
          jj.quarantined_at AS quarantinedAt,
          jj.quarantine_reason AS quarantineReason,
          jj.last_import_started_at AS lastImportStartedAt,
          jj.last_import_completed_at AS lastImportCompletedAt,
          jj.last_import_error_at AS lastImportErrorAt,
          jj.last_import_error AS lastImportError,
          jj.last_import_exit_code AS lastImportExitCode,
          jj.import_failure_count AS importFailureCount,
          jj.pause_requested_at AS pauseRequestedAt
        FROM app.judgment_job jj
        INNER JOIN app.project p ON jj.project_id = p.id
        ORDER BY jj.created_at ASC
      `)
      const jobIds = jobs.map((job) => {
        return job.id
      })
      const sqliteHealthByJobId = await getSqliteHealthMapForReadableRoute({db, jobs})
      const [importConsumer, importWorkLeasesByJobId, providerHealthByJobId] = await Promise.all([
        getJudgmentImportConsumerAvailability(),
        getJudgmentImportWorkLeasesByJobId({db, jobIds, now: currentNow}),
        getProviderHealthMapForReadableRoute({db, jobIds}),
      ])
      const jobsWithHealth = await Promise.all(
        jobs.map(async (job) => {
          const normalizedJob = {
            ...job,
            importFailureCount: Number(job.importFailureCount ?? 0),
            lastImportCompletedAt: getDateValue(job.lastImportCompletedAt),
            lastImportErrorAt: getDateValue(job.lastImportErrorAt),
            lastImportStartedAt: getDateValue(job.lastImportStartedAt),
            pauseRequestedAt: getDateValue(job.pauseRequestedAt),
            quarantinedAt: getDateValue(job.quarantinedAt),
            systemPromptVariant: getSystemPromptVariant(job.systemPromptVariant),
            useAbstract: job.useAbstract ?? true,
            useFulltext: job.useFulltext ?? false,
            useFulltextNoImages: job.useFulltextNoImages ?? false,
            useMetadata: job.useMetadata ?? false,
            useTitle: job.useTitle ?? true,
          }
          const sqliteHealth = sqliteHealthByJobId.get(job.id)
          const workIdentity = getJudgmentJobWorkIdentity({job: normalizedJob, modelId: job.projectModelId})
          const endpointHealth = await getJudgmentJobEndpointHealth({db, modelId: job.projectModelId})

          if (!sqliteHealth) {
            throw getMaintenanceUnavailableError(
              `fresh SQLite health projection is unavailable for judgment job ${job.id}`,
            )
          }

          const action = getRecommendedHealthAction({job: normalizedJob, sqliteHealth})
          const progress = getJudgmentJobHealthProgress({
            endpointHealth,
            importConsumer,
            importWorkLeases: importWorkLeasesByJobId.get(job.id) ?? [],
            job: normalizedJob,
            now: currentNow,
            recommendedNextAction: action,
            sqliteHealth,
            workIdentity,
          })

          return {
            ...progress,
            action,
            endpointAvailability: endpointHealth.diagnostics,
            job: normalizedJob,
            providerDiagnostics: endpointHealth.providerDiagnostics,
            sqliteHealth,
          }
        }),
      )
      const progressStates = getProgressStateCounts(jobsWithHealth)
      const controlPlane = getJudgmentJobControlPlaneDiagnostics()
      const jobsSummary = jobsWithHealth.map(
        ({action, endpointAvailability, job, providerDiagnostics, sqliteHealth, ...progress}) => {
          const normalizedJob = {
            id: job.id,
            projectId: job.projectId,
            status: job.status,
            storageState: job.storageState,
          }

          return {
            ...progress,
            action,
            endpointAvailability,
            job: normalizedJob,
            jobId: job.id,
            providerDiagnostics,
            providerHealth: getProviderHealthApi({
              jobStatus: job.status,
              providerHealth: providerHealthByJobId.get(job.id),
            }),
            sqliteHealth,
          }
        },
      )

      return {
        data: {
          activeImport: progressStates.activeImport,
          blockedImport: progressStates.blockedImport,
          completionAckBacklog: progressStates.waitingForOwnerAck,
          cooldown: progressStates.cooldown,
          healthy: jobsWithHealth.filter(({action, job}) => {
            return isHealthyJob({action, job})
          }).length,
          draining: jobsWithHealth.filter(({job}) => {
            return job.storageState === 'draining'
          }).length,
          offlineRepairRequired: jobsWithHealth.filter(({action}) => {
            return action === 'repair_offline_required'
          }).length,
          quarantined: jobsWithHealth.filter(({job}) => {
            return job.storageState === 'quarantined'
          }).length,
          orphanedLocalQueue: jobsWithHealth.filter(({sqliteHealth}) => {
            return hasOrphanedJudgedQueue(sqliteHealth)
          }).length,
          retainedOutbox: jobsWithHealth.filter(({sqliteHealth}) => {
            return hasRetainedOutbox(sqliteHealth)
          }).length,
          staleImport: jobsWithHealth.filter(({job}) => {
            return isStaleImportJob(job)
          }).length,
          importConsumer,
          controlPlane,
          jobs: jobsSummary,
          progressStates,
          repairRequired: progressStates.repairRequired,
        },
        error: null,
      }
    },
    request,
  })
}
