import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getProjectFullTextStrategyIdSql} from '../../fullText/fullTextStrategy.ts'
import {assertStoredProviderModelRuntimeMatch} from '../../providers/providerRuntimeModelGuard.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {deleteJudgmentJobSafelyTx} from '../../services/judgmentJobDeleteService.ts'
import {assertModelContextWindowResolvable} from '../../services/judgmentJobModelContextWindow.ts'
import type {JudgmentJobSqliteHealthProjectionReader} from '../../services/judgmentJobSqliteHealthProjectionService.ts'
import {HttpError} from '../../utils/httpError.ts'
import {assertProjectFullTextCanJudge} from './assertProjectFullTextCanJudge.ts'
import {assertJudgingRuntimeCanRun} from './judgingRuntime.ts'

const getProjectModelId = async (
  projectId: string,
  db: JudgmentJobSqliteHealthProjectionReader = getAppDatabaseService(),
): Promise<string> => {
  const [project] = await db.queryJson<{modelId: string | null}>(`
    SELECT model_id AS modelId
    FROM app.project
    WHERE id = ${getSqlLiteral(projectId)}
    LIMIT 1
  `)

  if (!project?.modelId) {
    throw new HttpError(400, 'Project model ID not found')
  }

  return project.modelId
}

const assertProjectRuntimeModelMatch = async (projectId: string): Promise<void> => {
  const projectModelId = await getProjectModelId(projectId)

  return assertStoredProviderModelRuntimeMatch({modelId: projectModelId})
}

const assertProjectModelContextWindow = async (projectId: string): Promise<void> => {
  return assertModelContextWindowResolvable(await getProjectModelId(projectId))
}

export const judgmentsJobsRoutesPostJob = async ({body}: {body: {projectId: string; agentConfig?: unknown}}) => {
  console.log('Fetching judgmentsjobs')

  // Check if a job already exists for this project
  const existingJob = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.judgment_job
        WHERE project_id = '${escapeSqlString(body.projectId)}'
        LIMIT 1
      `)

  if (existingJob.length > 0) {
    return {error: 'A job already exists for this project', data: null}
  }

  await assertJudgingRuntimeCanRun()
  await assertProjectRuntimeModelMatch(body.projectId)
  await assertProjectModelContextWindow(body.projectId)
  await assertProjectFullTextCanJudge(body.projectId)

  const [job] = await getAppDatabaseService().queryJson<{
    id: string
    status: string
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
    createdAt: unknown
    projectId: string
  }>(`
        INSERT INTO app.judgment_job (id, project_id, status, full_text_strategy_id)
        SELECT ${getQuotedStringList([crypto.randomUUID(), body.projectId, 'running']).join(', ')}, ${getProjectFullTextStrategyIdSql('p')}
        FROM app.project p
        WHERE p.id = ${getSqlLiteral(body.projectId)}
        RETURNING
          id,
          status,
          storage_state AS storageState,
          quarantined_at AS quarantinedAt,
          quarantine_reason AS quarantineReason,
          last_import_started_at AS lastImportStartedAt,
          last_import_completed_at AS lastImportCompletedAt,
          last_import_error_at AS lastImportErrorAt,
          last_import_error AS lastImportError,
          last_import_exit_code AS lastImportExitCode,
          import_failure_count AS importFailureCount,
          pause_requested_at AS pauseRequestedAt,
          created_at AS createdAt,
          project_id AS projectId
      `)

  if (!job) {
    throw new Error('Failed to create judgments job')
  }

  try {
    await getJudgmentJobSqliteService().initializeJob(job.id)
    await getJudgmentJobSqliteService().runIsolatedPreflight(job.id)
  } catch (error) {
    await getJudgmentJobSqliteService()
      .deleteJob(job.id)
      .catch(() => {
        return undefined
      })
    await getAppDatabaseService().transaction(async (tx) => {
      await deleteJudgmentJobSafelyTx({jobId: job.id, tx})
    })
    throw error
  }

  return {
    data: {
      jobId: job.id,
      status: job.status,
      storageState: job.storageState,
      quarantinedAt: getDateValue(job.quarantinedAt),
      quarantineReason: job.quarantineReason,
      lastImportStartedAt: getDateValue(job.lastImportStartedAt),
      lastImportCompletedAt: getDateValue(job.lastImportCompletedAt),
      lastImportErrorAt: getDateValue(job.lastImportErrorAt),
      lastImportError: job.lastImportError,
      lastImportExitCode: job.lastImportExitCode,
      importFailureCount: Number(job.importFailureCount ?? 0),
      pauseRequestedAt: getDateValue(job.pauseRequestedAt),
      createdAt: job.createdAt,
      projectId: job.projectId,
    },
    error: null,
  }
}
