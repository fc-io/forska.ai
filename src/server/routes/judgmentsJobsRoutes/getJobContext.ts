import {getSystemPromptVariant, type SystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {getProjectFullTextStrategyIdSql} from '../../fullText/fullTextStrategy.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getJsonValue} from '../../services/appQueryHelpers.ts'
import type {JudgmentJobSqliteHealthProjectionReader} from '../../services/judgmentJobSqliteHealthProjectionService.ts'
import {getJudgmentJobStopFields} from './getJudgmentJobStopFields.ts'

export const getJobContext = async ({
  db = getAppDatabaseService(),
  jobId,
}: {
  db?: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<{
  job: {
    id: string
    createdAt: Date
    updatedAt: Date
    projectId: string
    status: string
    error: string[] | null
    storageState: string
    quarantinedAt: Date | null
    quarantineReason: string | null
    lastImportStartedAt: Date | null
    lastImportCompletedAt: Date | null
    lastImportErrorAt: Date | null
    lastImportError: string | null
    lastImportExitCode: number | null
    importFailureCount: number
    pauseRequestedAt: Date | null
    projectName: string | null
    systemPromptVariant: SystemPromptVariant
    fullTextStrategyId: string
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    useMetadata: boolean
  } & ReturnType<typeof getJudgmentJobStopFields>
  projectFullTextStrategyId: string
  projectModelId: string
  projectDateFrom: Date | null
  projectDateTo: Date | null
  importRouteIds: string[]
}> => {
  const [jobWithProject, projectImportRoutes] = await Promise.all([
    db.queryJson<{
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
      projectModelId: string | null
      projectDateFrom: unknown
      projectDateTo: unknown
      projectSystemPromptVariant: string | null
      jobFullTextStrategyId: string
      projectFullTextStrategyId: string
      projectUseTitle: boolean | null
      projectUseAbstract: boolean | null
      projectUseFulltext: boolean | null
      projectUseFulltextNoImages: boolean | null
      projectUseMetadata: boolean | null
      stopAfterArticles: number | null
      stopAfterTotalTokens: number | string | null
      stopAt: unknown
      stopReason: string | null
      stopReasonAt: unknown
      stopWhenHumanAnsweredDone: boolean | null
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
        p.model_id AS projectModelId,
        p.date_from AS projectDateFrom,
        p.date_to AS projectDateTo,
        p.system_prompt_variant AS projectSystemPromptVariant,
        COALESCE(jj.full_text_strategy_id, ${getProjectFullTextStrategyIdSql('p')}) AS jobFullTextStrategyId,
        ${getProjectFullTextStrategyIdSql('p')} AS projectFullTextStrategyId,
        p.use_title AS projectUseTitle,
        p.use_abstract AS projectUseAbstract,
        p.use_fulltext AS projectUseFulltext,
        p.use_fulltext_no_images AS projectUseFulltextNoImages,
        COALESCE(p.use_metadata, FALSE) AS projectUseMetadata
      FROM app.judgment_job jj
      LEFT JOIN app.project p ON jj.project_id = p.id
      WHERE jj.id = '${escapeSqlString(jobId)}'
      LIMIT 1
    `),
    db.queryJson<{importRouteId: string}>(`
      SELECT pir.import_route_id AS importRouteId
      FROM app.project_import_route pir
      INNER JOIN app.judgment_job jj ON jj.project_id = pir.project_id
      WHERE jj.id = '${escapeSqlString(jobId)}'
    `),
  ]).then(([jobRows, routeRows]) => {
    return [jobRows[0], routeRows] as const
  })

  if (!jobWithProject) {
    throw new Error('Job not found')
  }

  const {
    projectDateFrom,
    projectDateTo,
    projectModelId,
    projectSystemPromptVariant,
    jobFullTextStrategyId,
    projectFullTextStrategyId,
    projectUseTitle,
    projectUseAbstract,
    projectUseFulltext,
    projectUseFulltextNoImages,
    projectUseMetadata,
    stopAfterArticles,
    stopAfterTotalTokens,
    stopAt,
    stopReason,
    stopReasonAt,
    stopWhenHumanAnsweredDone,
    ...rest
  } = jobWithProject

  const job = {
    ...rest,
    ...getJudgmentJobStopFields({
      stopAfterArticles,
      stopAfterTotalTokens,
      stopAt,
      stopReason,
      stopReasonAt,
      stopWhenHumanAnsweredDone,
    }),
    createdAt: getDateValue(rest.createdAt) ?? new Date(0),
    updatedAt: getDateValue(rest.updatedAt) ?? new Date(0),
    error: getJsonValue(rest.error) as string[] | null,
    storageState: rest.storageState,
    quarantinedAt: getDateValue(rest.quarantinedAt),
    quarantineReason: rest.quarantineReason,
    lastImportStartedAt: getDateValue(rest.lastImportStartedAt),
    lastImportCompletedAt: getDateValue(rest.lastImportCompletedAt),
    lastImportErrorAt: getDateValue(rest.lastImportErrorAt),
    lastImportError: rest.lastImportError,
    lastImportExitCode: rest.lastImportExitCode,
    importFailureCount: Number(rest.importFailureCount ?? 0),
    pauseRequestedAt: getDateValue(rest.pauseRequestedAt),
    systemPromptVariant: getSystemPromptVariant(projectSystemPromptVariant),
    fullTextStrategyId: jobFullTextStrategyId,
    useTitle: projectUseTitle ?? true,
    useAbstract: projectUseAbstract ?? true,
    useFulltext: projectUseFulltext ?? false,
    useFulltextNoImages: projectUseFulltextNoImages ?? false,
    useMetadata: projectUseMetadata ?? false,
  }

  if (!projectModelId) {
    throw new Error('Project model ID not found')
  }

  return {
    job,
    projectFullTextStrategyId,
    projectModelId,
    projectDateFrom: getDateValue(projectDateFrom),
    projectDateTo: getDateValue(projectDateTo),
    importRouteIds: projectImportRoutes.map((r) => {
      return r.importRouteId
    }),
  }
}
