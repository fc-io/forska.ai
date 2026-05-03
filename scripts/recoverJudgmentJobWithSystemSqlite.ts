import {writeFile} from 'node:fs/promises'

import {getJudgmentJobSqlitePath} from '../src/server/cron/judgmentsJobs/judgmentJobPaths.ts'
import {getAppDatabaseService, type JudgmentInsertRow} from '../src/server/services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../src/server/services/appQueryHelpers.ts'
import {getProjectMartDirtyRefreshStateService} from '../src/server/services/projectMartDirtyRefreshStateService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

type CliOptions = {jobId: string | null}
type ExportedOutboxRow = {
  answeredOriginal: string | null
  answeredOriginalAsArray: string | null
  articleId: string
  chunkingStrategy: string | null
  confidenceOriginal: number
  createdAt: string
  explanation: string | null
  isAnswered: number
  jobId: string
  judgmentId: string
  modelId: string
  outboxSeq: number
  projectId: string | null
  promptId: string
  queuePromptId: string
  quotesJson: string | null
  rawResponseJson: string | null
  snapshotProjectId: string | null
  snapshotProjectModelName: string | null
  updatedAt: string
  useAbstract: number
  useFulltext: number
  useFulltextNoImages: number
  useTitle: number
}
type JobInfoRow = {
  modelId: string
  useAbstract: number
  useFulltext: number
  useFulltextNoImages: number
  useTitle: number
}
type OrphanQueuePromptRow = {articleId: string; promptId: string; queuePromptId: string}
type JudgmentJobRecoveredDiscardedOutboxRow = {errorMessage: string; jobId: string; outboxSeq: number}
type JudgmentJobRecoveredOutboxRow = {jobId: string; outboxSeq: number}
type RecoverySummary = {
  deletedOrphanQueueRows: number
  discardedRows: number
  duplicateRows: number
  exportedJsonPath: string
  fullyRecovered: boolean
  importedRows: number
  jobId: string
  remainingOutboxRows: number
  remainingQueueRows: number
  sqlUpdatePath: string
}
type JudgmentJobRecoveredImportResult = {
  discardedRows: JudgmentJobRecoveredDiscardedOutboxRow[]
  duplicateRows: JudgmentJobRecoveredOutboxRow[]
  importedRows: JudgmentJobRecoveredOutboxRow[]
  importableRows: JudgmentJobRecoveredOutboxRow[]
  lastImportableOutboxSeq: number | null
}
type JudgmentJobOutboxEntry = {
  answeredOriginal: string | null
  answeredOriginalAsArray: string[]
  articleId: string
  chunkingStrategy: string | null
  confidenceOriginal: number
  createdAt: Date
  explanation: string | null
  isAnswered: boolean
  jobId: string
  judgmentId: string
  modelId: string
  outboxSeq: number
  projectId: string | null
  promptId: string
  queuePromptId: string
  quotes: unknown
  rawResponseJson: unknown
  snapshotProjectId: string | null
  snapshotProjectModelName: string | null
  updatedAt: Date
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
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

const parseJsonText = (value: string | null) => {
  if (value == null || value === '') {
    return null
  }

  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

const parseStringArrayText = (value: string | null) => {
  const parsed = parseJsonText(value)

  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : []
}

const toBoolean = (value: number | boolean | null | undefined) => {
  return value === true || value === 1
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
      job_id AS jobId,
      judgment_id AS judgmentId,
      model_id AS modelId,
      outbox_seq AS outboxSeq,
      project_id AS projectId,
      prompt_id AS promptId,
      queue_prompt_id AS queuePromptId,
      quotes_json AS quotesJson,
      raw_response_json AS rawResponseJson,
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

const mapExportedOutboxRow = (row: ExportedOutboxRow): JudgmentJobOutboxEntry => {
  return {
    answeredOriginal: row.answeredOriginal,
    answeredOriginalAsArray: parseStringArrayText(row.answeredOriginalAsArray),
    articleId: row.articleId,
    chunkingStrategy: row.chunkingStrategy,
    confidenceOriginal: Number(row.confidenceOriginal ?? 0),
    createdAt: new Date(row.createdAt),
    explanation: row.explanation,
    isAnswered: toBoolean(row.isAnswered),
    jobId: row.jobId,
    judgmentId: row.judgmentId,
    modelId: row.modelId,
    outboxSeq: Number(row.outboxSeq),
    projectId: row.projectId,
    promptId: row.promptId,
    queuePromptId: row.queuePromptId,
    quotes: parseJsonText(row.quotesJson),
    rawResponseJson: parseJsonText(row.rawResponseJson),
    snapshotProjectId: row.snapshotProjectId,
    snapshotProjectModelName: row.snapshotProjectModelName,
    updatedAt: new Date(row.updatedAt),
    useAbstract: toBoolean(row.useAbstract),
    useFulltext: toBoolean(row.useFulltext),
    useFulltextNoImages: toBoolean(row.useFulltextNoImages),
    useTitle: toBoolean(row.useTitle),
  }
}

const getJudgmentInsertRows = (entries: JudgmentJobOutboxEntry[]): JudgmentInsertRow[] => {
  return entries.map((entry) => {
    return {
      answeredOriginal: entry.answeredOriginal,
      answeredOriginalAsArray: entry.answeredOriginalAsArray,
      articleId: entry.articleId,
      chunkingStrategy: entry.chunkingStrategy,
      confidenceOriginal: entry.confidenceOriginal,
      createdAt: entry.createdAt,
      explanation: entry.explanation,
      id: entry.judgmentId,
      isAnswered: entry.isAnswered,
      modelId: entry.modelId,
      projectId: entry.projectId,
      promptId: entry.promptId,
      quotes: entry.quotes,
      snapshotProjectId: entry.snapshotProjectId,
      snapshotProjectModelName: entry.snapshotProjectModelName,
      updatedAt: entry.updatedAt,
      useAbstract: entry.useAbstract,
      useFulltext: entry.useFulltext,
      useFulltextNoImages: entry.useFulltextNoImages,
      useTitle: entry.useTitle,
    }
  })
}

const getExistingIds = async (
  tableName: 'app.article' | 'app.model' | 'app.project' | 'app.prompt',
  ids: string[],
): Promise<Set<string>> => {
  const uniqueIds = Array.from(new Set(ids))

  return uniqueIds.length === 0
    ? new Set<string>()
    : new Set(
        (
          await getAppDatabaseService().queryJson<{id: string}>(`
            SELECT id
            FROM ${tableName}
            WHERE id IN (${getQuotedStringList(uniqueIds).join(', ')})
          `)
        ).map((row) => {
          return row.id
        }),
      )
}

const partitionImportableEntries = async (entries: JudgmentJobOutboxEntry[]) => {
  const [articleIds, modelIds, projectIds, promptIds] = await Promise.all([
    getExistingIds(
      'app.article',
      entries.map((entry) => {
        return entry.articleId
      }),
    ),
    getExistingIds(
      'app.model',
      entries.map((entry) => {
        return entry.modelId
      }),
    ),
    getExistingIds(
      'app.project',
      entries.flatMap((entry) => {
        return entry.projectId ? [entry.projectId] : []
      }),
    ),
    getExistingIds(
      'app.prompt',
      entries.map((entry) => {
        return entry.promptId
      }),
    ),
  ])

  return entries.reduce(
    (state, entry) => {
      const missingForeignKeys = [
        articleIds.has(entry.articleId) ? null : `missing article ${entry.articleId}`,
        modelIds.has(entry.modelId) ? null : `missing model ${entry.modelId}`,
        entry.projectId === null || projectIds.has(entry.projectId) ? null : `missing project ${entry.projectId}`,
        promptIds.has(entry.promptId) ? null : `missing prompt ${entry.promptId}`,
      ].filter((value): value is string => {
        return value !== null
      })

      return missingForeignKeys.length === 0
        ? {...state, importableEntries: [...state.importableEntries, entry]}
        : {
            ...state,
            discardedEntries: [
              ...state.discardedEntries,
              {entry, errorMessage: `Dropped SQLite judgment outbox row because ${missingForeignKeys.join(', ')}`},
            ],
          }
    },
    {
      discardedEntries: [] as Array<{entry: JudgmentJobOutboxEntry; errorMessage: string}>,
      importableEntries: [] as JudgmentJobOutboxEntry[],
    },
  )
}

const importRecoveredOutboxEntries = async (
  entries: JudgmentJobOutboxEntry[],
  batchSize = 100,
): Promise<JudgmentJobRecoveredImportResult> => {
  const {discardedEntries, importableEntries} = await partitionImportableEntries(entries)
  const queueArticleRefreshes = async (articleIds: string[]) => {
    if (articleIds.length === 0) {
      return
    }

    await getProjectMartDirtyRefreshStateService().markArticleProjectsDirtyAtomically({
      articleIds,
      reason: 'systemSqliteRecovery',
      requestedBy: 'recoverJudgmentJobWithSystemSqlite',
    })
  }

  const importBatch = async (batch: JudgmentJobOutboxEntry[]): Promise<JudgmentJobRecoveredImportResult> => {
    if (batch.length === 0) {
      return {discardedRows: [], duplicateRows: [], importedRows: [], importableRows: [], lastImportableOutboxSeq: null}
    }

    try {
      const result = await getAppDatabaseService().appendJudgments(getJudgmentInsertRows(batch))

      return {
        discardedRows: [],
        duplicateRows: batch.slice(result.inserted).map((entry) => {
          return {jobId: entry.jobId, outboxSeq: entry.outboxSeq}
        }),
        importedRows: batch.slice(0, result.inserted).map((entry) => {
          return {jobId: entry.jobId, outboxSeq: entry.outboxSeq}
        }),
        importableRows: batch.map((entry) => {
          return {jobId: entry.jobId, outboxSeq: entry.outboxSeq}
        }),
        lastImportableOutboxSeq: batch.reduce((maxOutboxSeq, entry) => {
          return Math.max(maxOutboxSeq, entry.outboxSeq)
        }, batch[0]?.outboxSeq ?? 0),
      }
    } catch (error) {
      if (batch.length === 1) {
        const [entry] = batch

        return {
          discardedRows: [
            {
              errorMessage: error instanceof Error ? error.message : String(error),
              jobId: entry?.jobId ?? 'unknown-job',
              outboxSeq: entry?.outboxSeq ?? -1,
            },
          ],
          duplicateRows: [],
          importedRows: [],
          importableRows: [],
          lastImportableOutboxSeq: null,
        }
      }

      const midpoint = Math.ceil(batch.length / 2)
      const [leftResult, rightResult] = await Promise.all([
        importBatch(batch.slice(0, midpoint)),
        importBatch(batch.slice(midpoint)),
      ])

      return {
        discardedRows: [...leftResult.discardedRows, ...rightResult.discardedRows],
        duplicateRows: [...leftResult.duplicateRows, ...rightResult.duplicateRows],
        importedRows: [...leftResult.importedRows, ...rightResult.importedRows],
        importableRows: [...leftResult.importableRows, ...rightResult.importableRows],
        lastImportableOutboxSeq:
          leftResult.lastImportableOutboxSeq == null
            ? rightResult.lastImportableOutboxSeq
            : rightResult.lastImportableOutboxSeq == null
              ? leftResult.lastImportableOutboxSeq
              : Math.max(leftResult.lastImportableOutboxSeq, rightResult.lastImportableOutboxSeq),
      }
    }
  }

  const initialResult: JudgmentJobRecoveredImportResult = {
    discardedRows: discardedEntries.map(({entry, errorMessage}) => {
      return {errorMessage, jobId: entry.jobId, outboxSeq: entry.outboxSeq}
    }),
    duplicateRows: [],
    importedRows: [],
    importableRows: [],
    lastImportableOutboxSeq: null,
  }

  const importedResult = await importableEntries.reduce<Promise<JudgmentJobRecoveredImportResult>>(
    async (promise, _entry, index) => {
      if (index % batchSize !== 0) {
        return promise
      }

      const current = await promise
      const batch = importableEntries.slice(index, index + batchSize)
      const batchResult = await importBatch(batch)

      return {
        discardedRows: [...current.discardedRows, ...batchResult.discardedRows],
        duplicateRows: [...current.duplicateRows, ...batchResult.duplicateRows],
        importedRows: [...current.importedRows, ...batchResult.importedRows],
        importableRows: [...current.importableRows, ...batchResult.importableRows],
        lastImportableOutboxSeq:
          current.lastImportableOutboxSeq == null
            ? batchResult.lastImportableOutboxSeq
            : batchResult.lastImportableOutboxSeq == null
              ? current.lastImportableOutboxSeq
              : Math.max(current.lastImportableOutboxSeq, batchResult.lastImportableOutboxSeq),
      }
    },
    Promise.resolve(initialResult),
  )

  const articleIds = Array.from(
    new Set(
      importableEntries.map((entry) => {
        return entry.articleId
      }),
    ),
  )

  await queueArticleRefreshes(articleIds)

  return importedResult
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
        AND use_title = ${getSqlLiteral(toBoolean(jobInfo.useTitle))}
        AND use_abstract = ${getSqlLiteral(toBoolean(jobInfo.useAbstract))}
        AND use_fulltext = ${getSqlLiteral(toBoolean(jobInfo.useFulltext))}
        AND use_fulltext_no_images = ${getSqlLiteral(toBoolean(jobInfo.useFulltextNoImages))}
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

const getVerifiedOrphanQueuePromptIds = async ({jobInfo, sqlitePath}: {jobInfo: JobInfoRow; sqlitePath: string}) => {
  const orphanRows = runSqliteJsonQuery<OrphanQueuePromptRow>(sqlitePath, getOrphanQueuePromptSql())
  const existingPairs = await getExistingJudgmentPairs({jobInfo, rows: orphanRows})

  return orphanRows
    .filter((row) => {
      return existingPairs.has(`${row.articleId}|${row.promptId}`)
    })
    .map((row) => {
      return row.queuePromptId
    })
}

const getSqliteUpdateScript = ({
  discardedRows,
  importResult,
  jobId,
  orphanQueuePromptIds,
}: {
  discardedRows: JudgmentJobRecoveredDiscardedOutboxRow[]
  importResult: JudgmentJobRecoveredImportResult
  jobId: string
  orphanQueuePromptIds: string[]
}) => {
  const now = new Date().toISOString()
  const importableSeqsSql = importResult.importableRows
    .map((row) => {
      return String(row.outboxSeq)
    })
    .join(', ')
  const discardedSql = discardedRows
    .map((row) => {
      return `
        UPDATE judgment_outbox
        SET exported_at = ${getSqlLiteral(now)},
            export_attempts = export_attempts + 1,
            last_error = ${getSqlLiteral(row.errorMessage)}
        WHERE outbox_seq = ${row.outboxSeq};
      `
    })
    .join('\n')
  const ackSeq = importResult.lastImportableOutboxSeq
  const orphanDeleteSql =
    orphanQueuePromptIds.length === 0
      ? ''
      : `
        DELETE FROM queue_prompt
        WHERE status = 'judged'
          AND id IN (${getQuotedStringList(orphanQueuePromptIds).join(', ')});
      `

  return `
    BEGIN IMMEDIATE;
    ${
      importableSeqsSql === ''
        ? ''
        : `
          UPDATE judgment_outbox
          SET exported_at = ${getSqlLiteral(now)},
              export_attempts = export_attempts + 1,
              last_error = NULL
          WHERE outbox_seq IN (${importableSeqsSql});
        `
    }
    ${discardedSql}
    ${
      ackSeq == null
        ? ''
        : `
          UPDATE job_scan_state
          SET last_project_refresh_ack_token = CASE
                WHEN last_project_refresh_ack_token IS NULL OR last_project_refresh_ack_token < ${ackSeq}
                  THEN ${ackSeq}
                ELSE last_project_refresh_ack_token
              END,
              updated_at = ${getSqlLiteral(now)}
          WHERE job_id = ${getSqlLiteral(jobId)};
          DELETE FROM queue_prompt
          WHERE status = 'judged'
            AND id IN (
              SELECT queue_prompt_id
              FROM judgment_outbox
              WHERE exported_at IS NOT NULL
                AND outbox_seq <= ${ackSeq}
            );
          DELETE FROM judgment_outbox
          WHERE exported_at IS NOT NULL
            AND outbox_seq <= ${ackSeq};
        `
    }
    ${orphanDeleteSql}
    COMMIT;
    PRAGMA wal_checkpoint(TRUNCATE);
  `
}

const getRemainingSqliteCounts = (sqlitePath: string) => {
  const [row = {claimedOutboxCount: 0, outboxRows: 0, totalQueueRows: 0}] = runSqliteJsonQuery<{
    claimedOutboxCount: number
    outboxRows: number
    totalQueueRows: number
  }>(
    sqlitePath,
    `
      SELECT
        (SELECT COUNT(*) FROM judgment_outbox WHERE exported_at IS NULL AND export_claim_id IS NOT NULL) AS claimedOutboxCount,
        (SELECT COUNT(*) FROM judgment_outbox) AS outboxRows,
        (SELECT COUNT(*) FROM queue_prompt) AS totalQueueRows
    `,
  )

  return {
    claimedOutboxCount: Number(row.claimedOutboxCount ?? 0),
    outboxRows: Number(row.outboxRows ?? 0),
    totalQueueRows: Number(row.totalQueueRows ?? 0),
  }
}

const updateRecoveredJobState = async ({
  fullyRecovered,
  importedRows,
  jobId,
  remainingOutboxRows,
  remainingQueueRows,
}: {
  fullyRecovered: boolean
  importedRows: number
  jobId: string
  remainingOutboxRows: number
  remainingQueueRows: number
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
            `Recovered ${importedRows} rows via system sqlite3 export; remaining queue rows=${remainingQueueRows}, remaining outbox rows=${remainingOutboxRows}.`,
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
  const sqlUpdatePath = `${sqlitePath}.recovery-update.sql`
  const exportedRows = runSqliteJsonQuery<ExportedOutboxRow>(sqlitePath, getOutboxExportSql(jobId))
  const jobInfo = runSqliteJsonQuery<JobInfoRow>(sqlitePath, getJobInfoSql(jobId))[0]

  if (!jobInfo) {
    throw new Error(`Missing job_info for ${jobId}`)
  }

  await writeFile(exportPath, JSON.stringify(exportedRows, null, 2))

  const importResult = await importRecoveredOutboxEntries(exportedRows.map(mapExportedOutboxRow))
  const orphanQueuePromptIds = await getVerifiedOrphanQueuePromptIds({jobInfo, sqlitePath})
  const sqlUpdateText = getSqliteUpdateScript({
    discardedRows: importResult.discardedRows,
    importResult,
    jobId,
    orphanQueuePromptIds,
  })

  await writeFile(sqlUpdatePath, sqlUpdateText)
  runSqliteScript(sqlitePath, sqlUpdatePath)

  const remainingCounts = getRemainingSqliteCounts(sqlitePath)
  const fullyRecovered = remainingCounts.outboxRows === 0 && remainingCounts.totalQueueRows === 0

  await updateRecoveredJobState({
    fullyRecovered,
    importedRows: importResult.importedRows.length,
    jobId,
    remainingOutboxRows: remainingCounts.outboxRows,
    remainingQueueRows: remainingCounts.totalQueueRows,
  })

  return {
    deletedOrphanQueueRows: orphanQueuePromptIds.length,
    discardedRows: importResult.discardedRows.length,
    duplicateRows: importResult.duplicateRows.length,
    exportedJsonPath: exportPath,
    fullyRecovered,
    importedRows: importResult.importedRows.length,
    jobId,
    remainingOutboxRows: remainingCounts.outboxRows,
    remainingQueueRows: remainingCounts.totalQueueRows,
    sqlUpdatePath,
  }
}

export const recoverJudgmentJobWithSystemSqlite = async () => {
  const options = getCliOptions()

  if (!options.jobId) {
    process.exitCode = 1
    console.log(JSON.stringify({error: 'Expected --jobId=<job-id>', status: 'failed'}))
    return
  }

  try {
    const summary = await withDuckdbMaintenanceAccess('judgment job system sqlite recovery', async () => {
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
  await recoverJudgmentJobWithSystemSqlite()
}
