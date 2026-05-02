import {flushJudgmentJobSqliteOutbox} from '../src/server/cron/judgmentsJobs/judgmentJobSqliteOutboxImport.ts'
import {getJudgmentJobSqliteService} from '../src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getProjectMartRefreshStateService} from '../src/server/services/projectMartRefreshStateService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

type RepairOptions = {apply: boolean; deleteEmptyJobs: boolean; flush: boolean; projectId: string | null}

type CandidateRow = {
  projectPromptId: string
  projectId: string
  projectName: string
  promptId: string
  originalText: string
  transformedText: string | null
  promptHeading: string | null
  type: string | null
  promptArchived: boolean
}

type SummaryRow = {blockedLinks: number; blockedProjects: number; safeLinks: number; safeProjects: number}
type TransactionRunner = {queryJson: <T>(statement: string) => Promise<T[]>; run: (statement: string) => Promise<void>}
type EmptyJobCandidateRow = {jobId: string; jobStatus: string; projectId: string; projectName: string}
type EmptyJobInspection = {
  hasSqliteJob: boolean
  inFlightCount: number
  jobId: string
  jobStatus: string
  outboxCount: number
  promptQueueCount: number
  projectId: string
  projectName: string
  readyCount: number
  unexportedOutboxCount: number
}

const quoteSqlString = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const getRepairOptions = (): RepairOptions => {
  const projectIdArgument = process.argv.slice(2).find((argument) => {
    return argument.startsWith('--project-id=')
  })

  return {
    apply: process.argv.slice(2).includes('--apply'),
    deleteEmptyJobs: process.argv.slice(2).includes('--delete-empty-jobs'),
    flush: process.argv.slice(2).includes('--flush'),
    projectId: projectIdArgument?.split('=')[1] ?? null,
  }
}

const getProjectFilterClause = (projectId: string | null) => {
  return projectId ? `AND pp.project_id = ${quoteSqlString(projectId)}` : ''
}

const getSafeCandidateRows = async (options: RepairOptions) => {
  return getAppDatabaseService().queryJson<CandidateRow>(`
    SELECT
      pp.id AS projectPromptId,
      pp.project_id AS projectId,
      project.name AS projectName,
      pp.prompt_id AS promptId,
      prompt.original_text AS originalText,
      prompt.transformed_text AS transformedText,
      prompt.prompt_heading AS promptHeading,
      prompt.type AS type,
      prompt.archived AS promptArchived
    FROM app.project_prompt pp
    INNER JOIN app.project project ON project.id = pp.project_id
    INNER JOIN app.prompt prompt ON prompt.id = pp.prompt_id
    LEFT JOIN app.judgment_job job ON job.project_id = pp.project_id
    LEFT JOIN app.judgment judgment
      ON judgment.project_id = pp.project_id
      AND judgment.prompt_id = pp.prompt_id
      AND judgment.deleted_at IS NULL
    LEFT JOIN app.judgment_human judgment_human
      ON judgment_human.project_id = pp.project_id
      AND judgment_human.prompt_id = pp.prompt_id
    WHERE pp.origin_project_id = pp.project_id
      ${getProjectFilterClause(options.projectId)}
      AND EXISTS (
        SELECT 1
        FROM app.project_prompt other_pp
        WHERE other_pp.prompt_id = pp.prompt_id
          AND other_pp.project_id != pp.project_id
      )
      AND job.id IS NULL
    GROUP BY 1,2,3,4,5,6,7,8,9
    HAVING COUNT(judgment.id) = 0 AND COUNT(judgment_human.id) = 0
    ORDER BY projectName ASC, projectId ASC, promptHeading ASC NULLS LAST, promptId ASC
  `)
}

const getRepairSummary = async (options: RepairOptions) => {
  const [row] = await getAppDatabaseService().queryJson<SummaryRow>(`
    WITH candidate_rows AS (
      SELECT pp.project_id AS projectId, pp.prompt_id AS promptId
      FROM app.project_prompt pp
      WHERE pp.origin_project_id = pp.project_id
        ${getProjectFilterClause(options.projectId)}
        AND EXISTS (
          SELECT 1
          FROM app.project_prompt other_pp
          WHERE other_pp.prompt_id = pp.prompt_id
            AND other_pp.project_id != pp.project_id
        )
    ),
    safe_rows AS (
      SELECT candidate.projectId, candidate.promptId
      FROM candidate_rows candidate
      LEFT JOIN app.judgment_job job ON job.project_id = candidate.projectId
      LEFT JOIN app.judgment judgment
        ON judgment.project_id = candidate.projectId
        AND judgment.prompt_id = candidate.promptId
        AND judgment.deleted_at IS NULL
      LEFT JOIN app.judgment_human judgment_human
        ON judgment_human.project_id = candidate.projectId
        AND judgment_human.prompt_id = candidate.promptId
      GROUP BY 1,2
      HAVING COUNT(job.id) = 0 AND COUNT(judgment.id) = 0 AND COUNT(judgment_human.id) = 0
    )
    SELECT
      (SELECT COUNT(*) FROM safe_rows) AS safeLinks,
      (SELECT COUNT(DISTINCT projectId) FROM safe_rows) AS safeProjects,
      (SELECT COUNT(*) FROM candidate_rows) - (SELECT COUNT(*) FROM safe_rows) AS blockedLinks,
      (SELECT COUNT(DISTINCT projectId) FROM candidate_rows)
        - (SELECT COUNT(DISTINCT projectId) FROM safe_rows) AS blockedProjects
  `)

  return {
    blockedLinks: Number(row?.blockedLinks ?? 0),
    blockedProjects: Number(row?.blockedProjects ?? 0),
    safeLinks: Number(row?.safeLinks ?? 0),
    safeProjects: Number(row?.safeProjects ?? 0),
  }
}

const getEmptyJobCandidates = async (options: RepairOptions) => {
  return getAppDatabaseService().queryJson<EmptyJobCandidateRow>(`
    SELECT DISTINCT
      job.id AS jobId,
      job.status AS jobStatus,
      project.id AS projectId,
      project.name AS projectName
    FROM app.project_prompt pp
    INNER JOIN app.project project ON project.id = pp.project_id
    INNER JOIN app.judgment_job job ON job.project_id = pp.project_id
    LEFT JOIN app.judgment judgment
      ON judgment.project_id = pp.project_id
      AND judgment.prompt_id = pp.prompt_id
      AND judgment.deleted_at IS NULL
    LEFT JOIN app.judgment_human judgment_human
      ON judgment_human.project_id = pp.project_id
      AND judgment_human.prompt_id = pp.prompt_id
    WHERE pp.origin_project_id = pp.project_id
      ${getProjectFilterClause(options.projectId)}
      AND EXISTS (
        SELECT 1
        FROM app.project_prompt other_pp
        WHERE other_pp.prompt_id = pp.prompt_id
          AND other_pp.project_id != pp.project_id
      )
      AND job.status IN ('running', 'paused', 'paused_by_admin', 'paused_by_user', 'not_started', 'waiting_on_llm_connection', 'waiting_on_db_connection')
    GROUP BY 1,2,3,4
    HAVING COUNT(judgment.id) = 0 AND COUNT(judgment_human.id) = 0
    ORDER BY projectName ASC, projectId ASC
  `)
}

const inspectEmptyJobCandidate = async (row: EmptyJobCandidateRow): Promise<EmptyJobInspection> => {
  const sqliteService = getJudgmentJobSqliteService()
  const hasSqliteJob = sqliteService.hasJob(row.jobId)
  const [promptStatusCounts, readyCount, inFlightCount, outboxCount, unexportedOutboxCount] = hasSqliteJob
    ? await Promise.all([
        sqliteService.getPromptStatusCounts(row.jobId),
        sqliteService.getReadyCount(row.jobId),
        sqliteService.getInFlightCount(row.jobId),
        sqliteService.getOutboxCount(row.jobId),
        sqliteService.getUnexportedOutboxCount(row.jobId),
      ])
    : [[], 0, 0, 0, 0]
  const promptQueueCount = promptStatusCounts.reduce((total, countRow) => {
    return total + Number(countRow.count ?? 0)
  }, 0)

  return {
    hasSqliteJob,
    inFlightCount,
    jobId: row.jobId,
    jobStatus: row.jobStatus,
    outboxCount,
    promptQueueCount,
    projectId: row.projectId,
    projectName: row.projectName,
    readyCount,
    unexportedOutboxCount,
  }
}

const inspectEmptyJobCandidates = async (rows: EmptyJobCandidateRow[], index = 0): Promise<EmptyJobInspection[]> => {
  const currentRow = rows[index]

  if (!currentRow) {
    return []
  }

  const currentInspection = await inspectEmptyJobCandidate(currentRow)
  const rest = await inspectEmptyJobCandidates(rows, index + 1)
  return [currentInspection, ...rest]
}

const getDeletableJobs = (rows: EmptyJobInspection[]) => {
  return rows.filter((row) => {
    return row.promptQueueCount === 0 && row.readyCount === 0 && row.inFlightCount === 0 && row.outboxCount === 0
  })
}

const deleteEmptyJob = async (row: EmptyJobInspection) => {
  const sqliteService = getJudgmentJobSqliteService()

  await flushJudgmentJobSqliteOutbox({jobId: row.jobId})

  if (row.hasSqliteJob) {
    await sqliteService.deleteJob(row.jobId)
  }

  const {deleteJudgmentJobSafelyTx} = await import('../src/server/services/judgmentJobDeleteService.ts')
  await getAppDatabaseService().transaction(async (tx) => {
    await deleteJudgmentJobSafelyTx({jobId: row.jobId, tx})
  })
}

const deleteEmptyJobs = async (rows: EmptyJobInspection[], index = 0): Promise<string[]> => {
  const currentRow = rows[index]

  if (!currentRow) {
    return []
  }

  await deleteEmptyJob(currentRow)
  const rest = await deleteEmptyJobs(rows, index + 1)
  return [currentRow.projectId, ...rest]
}

const repairCandidateRows = async (tx: TransactionRunner, rows: CandidateRow[], index = 0): Promise<string[]> => {
  const currentRow = rows[index]

  if (!currentRow) {
    return []
  }

  const nextPromptId = crypto.randomUUID()

  await tx.run(`
    INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived)
    VALUES (
      ${quoteSqlString(nextPromptId)},
      ${quoteSqlString(currentRow.originalText)},
      ${currentRow.transformedText === null ? 'NULL' : quoteSqlString(currentRow.transformedText)},
      ${currentRow.promptHeading === null ? 'NULL' : quoteSqlString(currentRow.promptHeading)},
      ${currentRow.type === null ? 'NULL' : quoteSqlString(currentRow.type)},
      NULL,
      ${currentRow.promptArchived ? 'TRUE' : 'FALSE'}
    )
  `)
  await tx.run(`
    UPDATE app.project_prompt
    SET prompt_id = ${quoteSqlString(nextPromptId)}, updated_at = current_timestamp
    WHERE id = ${quoteSqlString(currentRow.projectPromptId)}
  `)
  await tx.run(`
    UPDATE app.judgment
    SET prompt_id = ${quoteSqlString(nextPromptId)}, updated_at = current_timestamp
    WHERE prompt_id = ${quoteSqlString(currentRow.promptId)}
      AND COALESCE(project_id, snapshot_project_id) = ${quoteSqlString(currentRow.projectId)}
  `)
  await tx.run(`
    UPDATE app.judgment_human
    SET prompt_id = ${quoteSqlString(nextPromptId)}, updated_at = current_timestamp
    WHERE prompt_id = ${quoteSqlString(currentRow.promptId)}
      AND project_id = ${quoteSqlString(currentRow.projectId)}
  `)

  const rest = await repairCandidateRows(tx, rows, index + 1)
  return [currentRow.projectId, ...rest]
}

const getUniqueProjectIds = (projectIds: string[]) => {
  return Array.from(new Set(projectIds))
}

const markProjectRefreshesDirty = async (tx: TransactionRunner, projectIds: string[]) => {
  const refreshStateService = getProjectMartRefreshStateService()
  const uniqueProjectIds = getUniqueProjectIds(projectIds)
  const dirtyProjects = await refreshStateService.getDirtyProjectsForProjectIds(tx, uniqueProjectIds)

  return refreshStateService.markProjectsDirtyAtomically({
    projects: dirtyProjects,
    reason: 'repairOwnedProjectPrompts',
    runner: tx,
  })
}

const logPreview = (rows: CandidateRow[]) => {
  return rows.slice(0, 10).map((row) => {
    console.log(
      `- ${row.projectName} | ${row.projectId} | ${row.promptHeading ?? 'no-heading'} | ${row.promptId.slice(0, 8)}`,
    )
    return row
  })
}

const logEmptyJobPreview = (rows: EmptyJobInspection[]) => {
  return rows.slice(0, 10).map((row) => {
    console.log(
      `- ${row.projectName} | ${row.projectId} | ${row.jobStatus} | queue=${row.promptQueueCount} ready=${row.readyCount} inFlight=${row.inFlightCount} outbox=${row.outboxCount}`,
    )
    return row
  })
}

const main = async () => {
  const options = getRepairOptions()

  await withDuckdbMaintenanceAccess('repair owned project prompts', async () => {
    const [initialSummary, initialSafeRows, emptyJobCandidates] = await Promise.all([
      getRepairSummary(options),
      getSafeCandidateRows(options),
      getEmptyJobCandidates(options),
    ])

    console.log(`[repairOwnedProjectPrompts] safe projects: ${initialSummary.safeProjects}`)
    console.log(`[repairOwnedProjectPrompts] safe prompt links: ${initialSummary.safeLinks}`)
    console.log(`[repairOwnedProjectPrompts] blocked projects: ${initialSummary.blockedProjects}`)
    console.log(`[repairOwnedProjectPrompts] blocked prompt links: ${initialSummary.blockedLinks}`)

    const emptyJobInspections = options.deleteEmptyJobs ? await inspectEmptyJobCandidates(emptyJobCandidates) : []
    const deletableJobs = getDeletableJobs(emptyJobInspections)

    if (options.deleteEmptyJobs) {
      console.log(`[repairOwnedProjectPrompts] empty job candidates: ${emptyJobInspections.length}`)
      console.log(`[repairOwnedProjectPrompts] deletable empty jobs: ${deletableJobs.length}`)
      logEmptyJobPreview(deletableJobs)
    }

    if (options.deleteEmptyJobs && options.apply && deletableJobs.length > 0) {
      const deletedProjectIds = getUniqueProjectIds(await deleteEmptyJobs(deletableJobs))
      console.log(`[repairOwnedProjectPrompts] deleted empty jobs: ${deletableJobs.length}`)
      console.log(`[repairOwnedProjectPrompts] deleted empty-job projects: ${deletedProjectIds.length}`)
    }

    const [_summary, safeRows] =
      options.deleteEmptyJobs && options.apply
        ? await Promise.all([getRepairSummary(options), getSafeCandidateRows(options)])
        : [initialSummary, initialSafeRows]

    if (safeRows.length === 0) {
      console.log('[repairOwnedProjectPrompts] no safe repairs available')
      return
    }

    console.log('[repairOwnedProjectPrompts] preview')
    logPreview(safeRows)

    if (!options.apply) {
      console.log('[repairOwnedProjectPrompts] dry run only; rerun with --apply to make changes')
      return
    }

    const repairedProjectIds = (await getAppDatabaseService().transaction(async (tx) => {
      const projectIds = getUniqueProjectIds(await repairCandidateRows(tx, safeRows))
      await markProjectRefreshesDirty(tx, projectIds)
      return projectIds
    })) as string[]

    console.log(`[repairOwnedProjectPrompts] repaired projects: ${repairedProjectIds.length}`)
    console.log(`[repairOwnedProjectPrompts] repaired prompt links: ${safeRows.length}`)
    console.log(`[repairOwnedProjectPrompts] marked project refresh dirty: ${repairedProjectIds.length}`)

    if (options.flush) {
      console.log('[repairOwnedProjectPrompts] --flush skipped; project dirty state is drained by project mart workers')
    }

    await getAppDatabaseService().maintenance('checkpoint')
  })
}

await main()
