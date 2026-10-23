import {getProjectFullTextStrategyIdSql} from '../../fullText/fullTextStrategy.ts'
import {getFullTextStrategyLabelsById} from '../../fullText/fullTextStrategyRepository.ts'
import {getDateValue, getJsonValue} from '../../services/appQueryHelpers.ts'
import {getProjectFullTextGatesByProjectId, type ProjectFullTextGate} from '../../services/judgmentJobFullTextGate.ts'
import {getModelContextWindowErrorForRow} from '../../services/judgmentJobModelContextWindow.ts'
import {getJobFullTextStrategyLabel} from './getJobFullTextStrategyLabel.ts'
import {getJudgmentJobsReadDatabase} from './getJudgmentJobsReadDatabase.ts'
import {getJudgmentJobStopFields} from './getJudgmentJobStopFields.ts'
import {getMaintenanceUnavailableError} from './getMaintenanceUnavailableError.ts'
import {getProjectFullTextGateApi} from './getProjectFullTextGateApi.ts'
import {getProviderHealthApi} from './getProviderHealthApi.ts'
import {getJobHealthBadges} from './judgmentsJobsRoutesGetJobs/getJobHealthBadges.ts'
import {getStopProgressForJobs} from './judgmentsJobsRoutesGetJobs/getStopProgressForJobs.ts'
import {getProviderHealthMapForReadableRoute} from './providerHealthForReadableRoute.ts'
import {runJudgmentJobsRead} from './runJudgmentJobsRead.ts'
import {getSqliteHealthMapForReadableRoute} from './sqliteHealthForReadableRoute.ts'

const getJudgmentJobModelContextWindowApi = (row: Parameters<typeof getModelContextWindowErrorForRow>[0]) => {
  const error = row.remoteModelId === null && row.displayName === null ? null : getModelContextWindowErrorForRow(row)

  return error
    ? {
        linkPath: error.linkPath,
        linkText: error.linkText,
        message: error.message,
        modelName: error.modelName,
        providerKind: error.providerKind,
      }
    : null
}

const emptyProjectFullTextGateApi: ProjectFullTextGate = {errors: [], warnings: []}

export const judgmentsJobsRoutesGetJobs = async ({request}: {request: Request}) => {
  return runJudgmentJobsRead({
    operation: async () => {
      const db = getJudgmentJobsReadDatabase()
      const jobs = await db.queryJson<{
        id: string
        createdAt: unknown
        updatedAt: unknown
        projectId: string
        status: string
        error: unknown
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
        projectName: string | null
        fullTextStrategyId: string
        modelDisplayName: string | null
        modelMetadataJson: unknown
        modelProviderConnectionId: string | null
        modelProviderKind: string | null
        modelRemoteModelId: string | null
        stopAfterArticles: number | null
        stopAfterTotalTokens: number | string | null
        stopAt: unknown
        stopReason: string | null
        stopReasonAt: unknown
        stopWhenHumanAnsweredDone: boolean | null
        useFulltextNoImages: boolean | null
      }>(`
        SELECT
          jj.id AS id,
          jj.created_at AS createdAt,
          jj.updated_at AS updatedAt,
          jj.project_id AS projectId,
          jj.status AS status,
          TO_JSON(jj.error) AS error,
          jj.storage_state AS storageState,
          jj.quarantined_at AS quarantinedAt,
          jj.quarantine_reason AS quarantineReason,
          jj.last_import_started_at AS lastImportStartedAt,
          jj.last_import_completed_at AS lastImportCompletedAt,
          jj.last_import_error_at AS lastImportErrorAt,
          jj.last_import_error AS lastImportError,
          jj.last_import_exit_code AS lastImportExitCode,
          jj.import_failure_count AS importFailureCount,
          jj.pause_requested_at AS pauseRequestedAt,
          jj.stop_after_articles AS stopAfterArticles,
          jj.stop_after_total_tokens AS stopAfterTotalTokens,
          jj.stop_at AS stopAt,
          COALESCE(jj.stop_when_human_answered_done, FALSE) AS stopWhenHumanAnsweredDone,
          jj.stop_reason AS stopReason,
          jj.stop_reason_at AS stopReasonAt,
          p.name AS projectName,
          COALESCE(jj.full_text_strategy_id, ${getProjectFullTextStrategyIdSql('p')}) AS fullTextStrategyId,
          p.use_fulltext_no_images AS useFulltextNoImages,
          COALESCE(m.display_name, m.name) AS modelDisplayName,
          TO_JSON(m.metadata_json) AS modelMetadataJson,
          m.provider_connection_id AS modelProviderConnectionId,
          pc.provider_kind AS modelProviderKind,
          m.remote_model_id AS modelRemoteModelId
        FROM app.judgment_job jj
        INNER JOIN app.project p ON jj.project_id = p.id
        LEFT JOIN app.model m ON m.id = p.model_id
        LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
        WHERE p.archived = FALSE
        ORDER BY jj.created_at ASC
      `)
      const fullTextGatesByProjectId = await getProjectFullTextGatesByProjectId(
        jobs.map((job) => {
          return job.projectId
        }),
        db,
      )
      const jobsWithStopFields = jobs.map(
        ({
          modelDisplayName,
          modelMetadataJson,
          modelProviderConnectionId,
          modelProviderKind,
          modelRemoteModelId,
          ...job
        }) => {
          return {
            ...job,
            ...getJudgmentJobStopFields(job),
            fullTextGate: getProjectFullTextGateApi(
              fullTextGatesByProjectId.get(job.projectId) ?? emptyProjectFullTextGateApi,
            ),
            modelContextWindow: getJudgmentJobModelContextWindowApi({
              displayName: modelDisplayName,
              metadataJson: modelMetadataJson,
              providerConnectionId: modelProviderConnectionId,
              providerKind: modelProviderKind,
              remoteModelId: modelRemoteModelId,
            }),
          }
        },
      )
      const [sqliteHealthByJobId, providerHealthByJobId, stopProgressByJobId, fullTextStrategyLabelsById] =
        await Promise.all([
          getSqliteHealthMapForReadableRoute({db, jobs}),
          getProviderHealthMapForReadableRoute({
            db,
            jobIds: jobs.map((job) => {
              return job.id
            }),
          }),
          getStopProgressForJobs({db, jobs: jobsWithStopFields}),
          getFullTextStrategyLabelsById(
            db,
            jobs.map((job) => {
              return job.fullTextStrategyId
            }),
          ),
        ])
      const jobsWithHealth = jobsWithStopFields.map((job) => {
        const normalizedJob = {
          ...job,
          ...(stopProgressByJobId.get(job.id) ?? {admittedArticleCount: null, totalTokens: null}),
          fullTextStrategyLabel: getJobFullTextStrategyLabel(job, fullTextStrategyLabelsById),
          createdAt: getDateValue(job.createdAt),
          updatedAt: getDateValue(job.updatedAt),
          error: getJsonValue(job.error) as string[] | null,
          quarantinedAt: getDateValue(job.quarantinedAt),
          lastImportStartedAt: getDateValue(job.lastImportStartedAt),
          lastImportCompletedAt: getDateValue(job.lastImportCompletedAt),
          lastImportErrorAt: getDateValue(job.lastImportErrorAt),
          importFailureCount: Number(job.importFailureCount ?? 0),
          pauseRequestedAt: getDateValue(job.pauseRequestedAt),
        }
        const sqliteHealth = sqliteHealthByJobId.get(job.id)

        if (!sqliteHealth) {
          throw getMaintenanceUnavailableError(
            `fresh SQLite health projection is unavailable for judgment job ${job.id}`,
          )
        }

        const providerHealth = providerHealthByJobId.get(job.id) ?? null
        const badges = getJobHealthBadges({job: normalizedJob, providerHealth, sqliteHealth})

        return {
          ...normalizedJob,
          health: {badges, isHealthy: badges.length === 1 && badges[0] === 'Healthy'},
          providerHealth: getProviderHealthApi({jobStatus: normalizedJob.status, providerHealth}),
        }
      })

      return {data: jobsWithHealth, error: null}
    },
    request,
  })
}
