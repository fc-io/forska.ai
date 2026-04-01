import {writeFile} from 'node:fs/promises'

import {getJudgmentJobSqlitePath} from '../src/server/cron/judgmentsJobs/judgmentJobPaths.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

type CliOptions = {jobId: string | null}
type JobInfoRow = {
  modelId: string
  useAbstract: number
  useFulltext: number
  useFulltextNoImages: number
  useTitle: number
}
type RecoverySummary = {
  deletedOrphanQueueRows: number
  duplicateRows: number
  exportedJsonPath: string
  fullyRecovered: boolean
  importedRows: number
  jobId: string
  remainingOutboxRows: number
  remainingQueueRows: number
  sqlUpdatePath: string
  totalRows: number
}

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1) ?? null
}

const getCliOptions = (): CliOptions => {
  return {jobId: getArgValue(['--jobId', '--job-id'])}
}

const getTrimmedStdout = (stdout: string) => {
  const trimmed = stdout.trim()
  return trimmed === '' ? '[]' : trimmed
}

const runSqliteJsonQuery = <T>(sqlitePath: string, sql: string, readOnly = true): T[] => {
  const command = readOnly ? ['sqlite3', '-readonly', '-json', sqlitePath, sql] : ['sqlite3', '-json', sqlitePath, sql]
  const result = globalThis.Bun.spawnSync(command, {cwd: process.cwd(), env: {...process.env}})

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || `sqlite3 query failed for ${sqlitePath}`)
  }

  return JSON.parse(getTrimmedStdout(result.stdout.toString())) as T[]
}

const runSqliteScript = (sqlitePath: string, sqlPath: string) => {
  const result = globalThis.Bun.spawnSync(['sqlite3', sqlitePath, `.read ${sqlPath}`], {
    cwd: process.cwd(),
    env: {...process.env},
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || `sqlite3 script failed for ${sqlitePath}`)
  }
}

const getOutboxExportSql = (jobId: string) => {
  return `
    SELECT
      answered_original AS answeredOriginal,
      answered_original_as_array AS answeredOriginalAsArray,
      article_id AS articleId,
      chunking_strategy AS chunkingStrategy,
      confidence_original AS confidenceOriginal,
      created_at AS createdAt,
      explanation AS explanation,
      is_answered AS isAnswered,
      judgment_id AS judgmentId,
      model_id AS modelId,
      outbox_seq AS outboxSeq,
      project_id AS projectId,
      prompt_id AS promptId,
      queue_prompt_id AS queuePromptId,
      quotes_json AS quotesJson,
      snapshot_project_id AS snapshotProjectId,
      snapshot_project_model_name AS snapshotProjectModelName,
      updated_at AS updatedAt,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      use_title AS useTitle
    FROM judgment_outbox
    WHERE job_id = ${getSqlLiteral(jobId)}
      AND exported_at IS NULL
    ORDER BY outbox_seq ASC
  `
}

const getJobInfoSql = (jobId: string) => {
  return `
    SELECT
      model_id AS modelId,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      use_title AS useTitle
    FROM job_info
    WHERE job_id = ${getSqlLiteral(jobId)}
    LIMIT 1
  `
}

const getOrphanQueuePromptSql = () => {
  return `
    SELECT
      article_id AS articleId,
      prompt_id AS promptId,
      id AS queuePromptId
    FROM queue_prompt qp
    WHERE status = 'judged'
      AND NOT EXISTS (
        SELECT 1
        FROM judgment_outbox jo
        WHERE jo.queue_prompt_id = qp.id
      )
    ORDER BY id ASC
  `
}

const getExportStatsSql = (exportPath: string) => {
  return `
    WITH src AS (
      SELECT *
      FROM read_json_auto(${getSqlLiteral(exportPath)})
    ),
    validated AS (
      SELECT
        src.*,
        article.id IS NOT NULL AS hasArticle,
        model.id IS NOT NULL AS hasModel,
        prompt.id IS NOT NULL AS hasPrompt,
        src.projectId IS NULL OR project.id IS NOT NULL AS hasProject
      FROM src
      LEFT JOIN app.article article ON article.id = src.articleId
      LEFT JOIN app.model model ON model.id = src.modelId
      LEFT JOIN app.prompt prompt ON prompt.id = src.promptId
      LEFT JOIN app.project project ON project.id = src.projectId
    ),
    importable AS (
      SELECT *
      FROM validated
      WHERE hasArticle AND hasModel AND hasPrompt AND hasProject
    ),
    existing AS (
      SELECT COUNT(*) AS count
      FROM importable src
      INNER JOIN app.judgment judgment
        ON judgment.article_id = src.articleId
       AND judgment.prompt_id = src.promptId
       AND judgment.model_id = src.modelId
       AND judgment.use_title = CAST(src.useTitle AS BOOLEAN)
       AND judgment.use_abstract = CAST(src.useAbstract AS BOOLEAN)
       AND judgment.use_fulltext = CAST(src.useFulltext AS BOOLEAN)
       AND judgment.use_fulltext_no_images = CAST(src.useFulltextNoImages AS BOOLEAN)
       AND judgment.delete_generation = 0
       AND judgment.deleted_at IS NULL
    )
    SELECT
      (SELECT COUNT(*) FROM src) AS totalRows,
      (SELECT COUNT(*) FROM importable) AS importableRows,
      (SELECT count FROM existing) AS existingRows
  `
}

const getInsertRecoveredRowsSql = (exportPath: string) => {
  return `
    WITH src AS (
      SELECT *
      FROM read_json_auto(${getSqlLiteral(exportPath)})
    ),
    importable AS (
      SELECT src.*
      FROM src
      INNER JOIN app.article article ON article.id = src.articleId
      INNER JOIN app.model model ON model.id = src.modelId
      INNER JOIN app.prompt prompt ON prompt.id = src.promptId
      LEFT JOIN app.project project ON project.id = src.projectId
      WHERE src.projectId IS NULL OR project.id IS NOT NULL
    )
    INSERT INTO app.judgment (
      id,
      article_id,
      model_id,
      prompt_id,
      project_id,
      is_answered,
      answered_original,
      answered_original_as_array,
      confidence_original,
      explanation,
      quotes,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images,
      chunking_strategy,
      snapshot_project_id,
      snapshot_project_model_name,
      created_at,
      updated_at
    )
    SELECT
      judgmentId,
      articleId,
      modelId,
      promptId,
      projectId,
      CAST(isAnswered AS BOOLEAN),
      answeredOriginal,
      from_json(answeredOriginalAsArray, 'VARCHAR[]'),
      CAST(confidenceOriginal AS INTEGER),
      explanation,
      CAST(quotesJson AS JSON),
      CAST(useTitle AS BOOLEAN),
      CAST(useAbstract AS BOOLEAN),
      CAST(useFulltext AS BOOLEAN),
      CAST(useFulltextNoImages AS BOOLEAN),
      chunkingStrategy,
      snapshotProjectId,
      snapshotProjectModelName,
      CAST(createdAt AS TIMESTAMPTZ),
      CAST(updatedAt AS TIMESTAMPTZ)
    FROM importable
    ON CONFLICT(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, delete_generation) DO NOTHING
  `
}

const queueRefreshesForRecoveredRows = async (exportPath: string) => {
  await getAppDatabaseService().run(`
    WITH src AS (
      SELECT DISTINCT articleId
      FROM read_json_auto(${getSqlLiteral(exportPath)})
    )
    INSERT INTO app.mart_refresh_queue (
      id,
      refresh_scope,
      project_id,
      article_id,
      project_key,
      article_key,
      refresh_generation,
      reason,
      created_at,
      updated_at
    )
    SELECT
      random(),
      'judgment_article',
      NULL,
      articleId,
      '',
      articleId,
      0,
      'systemSqliteRecovery',
      NOW(),
      NOW()
    FROM src
    ON CONFLICT(refresh_scope, project_key, article_key) DO UPDATE SET
      completed_at = NULL,
      created_at = CASE
        WHEN app.mart_refresh_queue.completed_at IS NULL THEN app.mart_refresh_queue.created_at
        ELSE NOW()
      END,
      refresh_generation = COALESCE(app.mart_refresh_queue.refresh_generation, 0) + 1,
      reason = excluded.reason,
      updated_at = NOW()
  `)
}

const getOrphanVerificationSql = ({jobInfo, orphanExportPath}: {jobInfo: JobInfoRow; orphanExportPath: string}) => {
  return `
    WITH src AS (
      SELECT *
      FROM read_json_auto(${getSqlLiteral(orphanExportPath)})
    )
    SELECT COUNT(*) AS count
    FROM src
    INNER JOIN app.judgment judgment
      ON judgment.article_id = src.articleId
     AND judgment.prompt_id = src.promptId
     AND judgment.model_id = ${getSqlLiteral(jobInfo.modelId)}
     AND judgment.use_title = ${getSqlLiteral(Boolean(jobInfo.useTitle))}
     AND judgment.use_abstract = ${getSqlLiteral(Boolean(jobInfo.useAbstract))}
     AND judgment.use_fulltext = ${getSqlLiteral(Boolean(jobInfo.useFulltext))}
     AND judgment.use_fulltext_no_images = ${getSqlLiteral(Boolean(jobInfo.useFulltextNoImages))}
     AND judgment.delete_generation = 0
     AND judgment.deleted_at IS NULL
  `
}

const getSqliteUpdateScript = ({
  deleteVerifiedOrphans,
  jobId,
  orphanQueuePromptIds,
}: {
  deleteVerifiedOrphans: boolean
  jobId: string
  orphanQueuePromptIds: string[]
}) => {
  const now = new Date().toISOString()

  return `
    BEGIN IMMEDIATE;
    UPDATE judgment_outbox
    SET exported_at = ${getSqlLiteral(now)},
        export_attempts = export_attempts + 1,
        last_error = NULL
    WHERE exported_at IS NULL;
    UPDATE job_scan_state
    SET last_project_refresh_ack_seq = CASE
          WHEN last_project_refresh_ack_seq IS NULL OR last_project_refresh_ack_seq < (SELECT MAX(outbox_seq) FROM judgment_outbox)
            THEN (SELECT MAX(outbox_seq) FROM judgment_outbox)
          ELSE last_project_refresh_ack_seq
        END,
        updated_at = ${getSqlLiteral(now)}
    WHERE job_id = ${getSqlLiteral(jobId)};
    DELETE FROM queue_prompt
    WHERE status = 'judged'
      AND id IN (
        SELECT queue_prompt_id
        FROM judgment_outbox
        WHERE exported_at IS NOT NULL
          AND outbox_seq <= (SELECT last_project_refresh_ack_seq FROM job_scan_state WHERE job_id = ${getSqlLiteral(jobId)})
      );
    DELETE FROM judgment_outbox
    WHERE exported_at IS NOT NULL
      AND outbox_seq <= (SELECT last_project_refresh_ack_seq FROM job_scan_state WHERE job_id = ${getSqlLiteral(jobId)});
    ${
      deleteVerifiedOrphans
        ? `
          DELETE FROM queue_prompt
          WHERE status = 'judged'
            AND id IN (${getQuotedStringList(orphanQueuePromptIds).join(', ')});
        `
        : ''
    }
    COMMIT;
    PRAGMA wal_checkpoint(TRUNCATE);
  `
}

const getRemainingSqliteCounts = (sqlitePath: string) => {
  const [row = {outboxRows: 0, totalQueueRows: 0}] = runSqliteJsonQuery<{outboxRows: number; totalQueueRows: number}>(
    sqlitePath,
    `
      SELECT
        (SELECT COUNT(*) FROM judgment_outbox) AS outboxRows,
        (SELECT COUNT(*) FROM queue_prompt) AS totalQueueRows
    `,
  )

  return {outboxRows: Number(row.outboxRows ?? 0), totalQueueRows: Number(row.totalQueueRows ?? 0)}
}

const updateRecoveredJobState = async ({
  fullyRecovered,
  jobId,
  remainingOutboxRows,
  remainingQueueRows,
  totalRows,
}: {
  fullyRecovered: boolean
  jobId: string
  remainingOutboxRows: number
  remainingQueueRows: number
  totalRows: number
}) => {
  await getAppDatabaseService().run(`
    UPDATE app.judgment_job
    SET status = CASE
          WHEN ${fullyRecovered ? 'TRUE' : 'FALSE'} AND status = 'failed' THEN 'paused'
          ELSE status
        END,
        storage_state = CASE
          WHEN ${fullyRecovered ? 'TRUE' : 'FALSE'} THEN 'active'
          ELSE 'quarantined'
        END,
        quarantined_at = CASE
          WHEN ${fullyRecovered ? 'TRUE' : 'FALSE'} THEN NULL
          ELSE COALESCE(quarantined_at, current_timestamp)
        END,
        quarantine_reason = CASE
          WHEN ${fullyRecovered ? 'TRUE' : 'FALSE'} THEN NULL
          ELSE ${getSqlLiteral(
            `Recovered ${totalRows} rows via system sqlite3 export; remaining queue rows=${remainingQueueRows}, remaining outbox rows=${remainingOutboxRows}.`,
          )}
        END,
        last_import_completed_at = current_timestamp,
        last_import_error_at = NULL,
        last_import_error = NULL,
        last_import_exit_code = 0,
        import_failure_count = 0,
        updated_at = current_timestamp
    WHERE id = ${getSqlLiteral(jobId)}
  `)
}

const recoverJudgmentJob = async (jobId: string): Promise<RecoverySummary> => {
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const exportPath = `${sqlitePath}.recovery-export.json`
  const orphanExportPath = `${sqlitePath}.recovery-orphans.json`
  const sqlUpdatePath = `${sqlitePath}.recovery-update.sql`
  const exportedRows = runSqliteJsonQuery<Record<string, unknown>>(sqlitePath, getOutboxExportSql(jobId))
  const jobInfo = runSqliteJsonQuery<JobInfoRow>(sqlitePath, getJobInfoSql(jobId))[0]
  const orphanRows = runSqliteJsonQuery<Record<string, unknown>>(sqlitePath, getOrphanQueuePromptSql())

  if (!jobInfo) {
    throw new Error(`Missing job_info for ${jobId}`)
  }

  await writeFile(exportPath, JSON.stringify(exportedRows, null, 2))
  await writeFile(orphanExportPath, JSON.stringify(orphanRows, null, 2))

  const [statsRow = {existingRows: 0, importableRows: 0, totalRows: 0}] = await getAppDatabaseService().queryJson<{
    existingRows: number | string
    importableRows: number | string
    totalRows: number | string
  }>(getExportStatsSql(exportPath))
  const totalRows = Number(statsRow.totalRows ?? 0)
  const importableRows = Number(statsRow.importableRows ?? 0)
  const existingRows = Number(statsRow.existingRows ?? 0)

  if (importableRows !== totalRows) {
    throw new Error(
      `Only ${importableRows} of ${totalRows} exported rows have valid foreign keys; aborting automatic recovery.`,
    )
  }

  if (existingRows < importableRows) {
    await getAppDatabaseService().run(getInsertRecoveredRowsSql(exportPath))
  }

  const [verifiedRow = {existingRows: 0}] = await getAppDatabaseService().queryJson<{
    existingRows: number | string
    importableRows: number | string
    totalRows: number | string
  }>(getExportStatsSql(exportPath))
  const verifiedRows = Number(verifiedRow.existingRows ?? 0)

  if (verifiedRows !== importableRows) {
    throw new Error(
      `Only ${verifiedRows} of ${importableRows} importable rows are present in DuckDB after recovery insert.`,
    )
  }

  await queueRefreshesForRecoveredRows(exportPath)

  const [verifiedOrphansRow = {count: 0}] = await getAppDatabaseService().queryJson<{count: number | string}>(
    getOrphanVerificationSql({jobInfo, orphanExportPath}),
  )
  const verifiedOrphanRows = Number(verifiedOrphansRow.count ?? 0)
  const deleteVerifiedOrphans = verifiedOrphanRows === orphanRows.length
  const orphanQueuePromptIds = orphanRows.flatMap((row) => {
    return typeof row.queuePromptId === 'string' ? [row.queuePromptId] : []
  })
  const sqlUpdateText = getSqliteUpdateScript({deleteVerifiedOrphans, jobId, orphanQueuePromptIds})

  await writeFile(sqlUpdatePath, sqlUpdateText)
  runSqliteScript(sqlitePath, sqlUpdatePath)

  const remainingCounts = getRemainingSqliteCounts(sqlitePath)
  const fullyRecovered = remainingCounts.outboxRows === 0 && remainingCounts.totalQueueRows === 0

  await updateRecoveredJobState({
    fullyRecovered,
    jobId,
    remainingOutboxRows: remainingCounts.outboxRows,
    remainingQueueRows: remainingCounts.totalQueueRows,
    totalRows,
  })

  return {
    deletedOrphanQueueRows: deleteVerifiedOrphans ? orphanRows.length : 0,
    duplicateRows: existingRows,
    exportedJsonPath: exportPath,
    fullyRecovered,
    importedRows: Math.max(importableRows - existingRows, 0),
    jobId,
    remainingOutboxRows: remainingCounts.outboxRows,
    remainingQueueRows: remainingCounts.totalQueueRows,
    sqlUpdatePath,
    totalRows,
  }
}

export const recoverJudgmentJobWithSystemSqliteSqlImport = async () => {
  const options = getCliOptions()

  if (!options.jobId) {
    process.exitCode = 1
    console.log(JSON.stringify({error: 'Expected --jobId=<job-id>', status: 'failed'}))
    return
  }

  try {
    const summary = await withDuckdbMaintenanceAccess('judgment job system sqlite SQL recovery', async () => {
      return recoverJudgmentJob(options.jobId as string)
    })

    process.exitCode = summary.fullyRecovered ? 0 : 1
    console.log(JSON.stringify({status: summary.fullyRecovered ? 'ok' : 'partial', summary}))
  } catch (error) {
    process.exitCode = 1
    console.log(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        jobId: options.jobId,
        status: 'failed',
      }),
    )
  } finally {
    await getAppDatabaseService().close()
  }
}

if (import.meta.main) {
  await recoverJudgmentJobWithSystemSqliteSqlImport()
}
