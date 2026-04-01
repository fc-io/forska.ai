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
type OrphanQueuePromptRow = {articleId: string; promptId: string; queuePromptId: string}
type RecoverySummary = {
  deletedOrphanQueueRows: number
  duplicateRows: number
  fullyRecovered: boolean
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
  const escapedSqlPath = sqlPath.replaceAll('"', '""')
  const result = globalThis.Bun.spawnSync(['sqlite3', sqlitePath, `.read "${escapedSqlPath}"`], {
    cwd: process.cwd(),
    env: {...process.env},
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString() || `sqlite3 script failed for ${sqlitePath}`)
  }
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

const getCountsSql = (jobId: string) => {
  return `
    SELECT
      (SELECT COUNT(*) FROM judgment_outbox WHERE exported_at IS NULL) AS unexportedOutboxRows,
      (SELECT COUNT(*) FROM judgment_outbox) AS totalOutboxRows,
      (SELECT COUNT(*) FROM queue_prompt) AS totalQueueRows,
      (SELECT COUNT(*) FROM queue_prompt WHERE status = 'judged' AND NOT EXISTS (SELECT 1 FROM judgment_outbox jo WHERE jo.queue_prompt_id = queue_prompt.id)) AS orphanQueueRows,
      (SELECT MAX(outbox_seq) FROM judgment_outbox) AS maxOutboxSeq,
      (SELECT last_project_refresh_ack_seq FROM job_scan_state WHERE job_id = ${getSqlLiteral(jobId)}) AS lastAckSeq
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

const getExistingJudgmentPairs = async ({jobInfo, rows}: {jobInfo: JobInfoRow; rows: OrphanQueuePromptRow[]}) => {
  const chunkSize = 500

  return rows.reduce<Promise<Set<string>>>(async (promise, _row, index) => {
    if (index % chunkSize !== 0) {
      return promise
    }

    const current = await promise
    const chunk = rows.slice(index, index + chunkSize)

    if (chunk.length === 0) {
      return current
    }

    const chunkRows = await getAppDatabaseService().queryJson<{articleId: string; promptId: string}>(`
      SELECT article_id AS articleId, prompt_id AS promptId
      FROM app.judgment
      WHERE model_id = ${getSqlLiteral(jobInfo.modelId)}
        AND use_title = ${getSqlLiteral(Boolean(jobInfo.useTitle))}
        AND use_abstract = ${getSqlLiteral(Boolean(jobInfo.useAbstract))}
        AND use_fulltext = ${getSqlLiteral(Boolean(jobInfo.useFulltext))}
        AND use_fulltext_no_images = ${getSqlLiteral(Boolean(jobInfo.useFulltextNoImages))}
        AND delete_generation = 0
        AND deleted_at IS NULL
        AND (${chunk
          .map((row) => {
            return `(article_id = ${getSqlLiteral(row.articleId)} AND prompt_id = ${getSqlLiteral(row.promptId)})`
          })
          .join(' OR ')})
    `)

    return chunkRows.reduce((set, row) => {
      set.add(`${row.articleId}|${row.promptId}`)
      return set
    }, current)
  }, Promise.resolve(new Set<string>()))
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
      deleteVerifiedOrphans && orphanQueuePromptIds.length > 0
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
            `Recovered ${totalRows} retained SQLite outbox rows; remaining queue rows=${remainingQueueRows}, remaining outbox rows=${remainingOutboxRows}.`,
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

const reconcileRecoveredJob = async (jobId: string): Promise<RecoverySummary> => {
  const sqlitePath = getJudgmentJobSqlitePath(jobId)
  const sqlUpdatePath = `${sqlitePath}.recovery-reconcile.sql`
  const [jobInfo] = runSqliteJsonQuery<JobInfoRow>(sqlitePath, getJobInfoSql(jobId))
  const [initialCounts] = runSqliteJsonQuery<{
    lastAckSeq: number | null
    maxOutboxSeq: number | null
    orphanQueueRows: number
    totalOutboxRows: number
    totalQueueRows: number
    unexportedOutboxRows: number
  }>(sqlitePath, getCountsSql(jobId))

  if (!jobInfo || !initialCounts) {
    throw new Error(`Missing SQLite recovery metadata for ${jobId}`)
  }

  if (Number(initialCounts.unexportedOutboxRows ?? 0) === 0 && Number(initialCounts.totalOutboxRows ?? 0) === 0) {
    throw new Error(`No retained outbox rows found for ${jobId}`)
  }

  const orphanRows = runSqliteJsonQuery<OrphanQueuePromptRow>(sqlitePath, getOrphanQueuePromptSql())
  const existingPairs = await getExistingJudgmentPairs({jobInfo, rows: orphanRows})
  const orphanQueuePromptIds = orphanRows
    .filter((row) => {
      return existingPairs.has(`${row.articleId}|${row.promptId}`)
    })
    .map((row) => {
      return row.queuePromptId
    })
  const deleteVerifiedOrphans = orphanQueuePromptIds.length === orphanRows.length
  const sqlUpdateText = getSqliteUpdateScript({deleteVerifiedOrphans, jobId, orphanQueuePromptIds})

  await writeFile(sqlUpdatePath, sqlUpdateText)
  runSqliteScript(sqlitePath, sqlUpdatePath)

  const [remainingCounts] = runSqliteJsonQuery<{
    lastAckSeq: number | null
    maxOutboxSeq: number | null
    orphanQueueRows: number
    totalOutboxRows: number
    totalQueueRows: number
    unexportedOutboxRows: number
  }>(sqlitePath, getCountsSql(jobId))

  const remainingOutboxRows = Number(remainingCounts?.totalOutboxRows ?? 0)
  const remainingQueueRows = Number(remainingCounts?.totalQueueRows ?? 0)
  const fullyRecovered = remainingOutboxRows === 0 && remainingQueueRows === 0
  const totalRows = Number(initialCounts.totalOutboxRows ?? 0)

  await updateRecoveredJobState({fullyRecovered, jobId, remainingOutboxRows, remainingQueueRows, totalRows})

  return {
    deletedOrphanQueueRows: deleteVerifiedOrphans ? orphanQueuePromptIds.length : 0,
    duplicateRows: totalRows,
    fullyRecovered,
    jobId,
    remainingOutboxRows,
    remainingQueueRows,
    sqlUpdatePath,
    totalRows,
  }
}

export const runReconcileRecoveredJudgmentJob = async () => {
  const options = getCliOptions()

  if (!options.jobId) {
    process.exitCode = 1
    console.log(JSON.stringify({error: 'Expected --jobId=<job-id>', status: 'failed'}))
    return
  }

  try {
    const summary = await withDuckdbMaintenanceAccess('reconcile recovered judgment job', async () => {
      return reconcileRecoveredJob(options.jobId as string)
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
  await runReconcileRecoveredJudgmentJob()
}
