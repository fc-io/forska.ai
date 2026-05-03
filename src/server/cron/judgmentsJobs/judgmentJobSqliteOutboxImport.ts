import {getAppDatabaseService, type JudgmentInsertRow} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getMaintenanceWorkLeaseService} from '../../services/maintenanceWorkLeaseService.ts'
import {getProjectMartRefreshStateService} from '../../services/projectMartRefreshStateService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getImportableJudgmentJobWhereSql} from './judgmentJobImportScope.ts'
import {getJudgmentJobSqliteJobIds} from './judgmentJobPaths.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {
  getJudgmentJobSqliteService,
  JudgmentJobLeaseError,
  type JudgmentJobSqliteClaimedOutboxBatch,
  type JudgmentJobSqliteOutboxClaim,
  type JudgmentJobSqliteOutboxEntry,
} from './judgmentJobSqliteService.ts'
import {recordJudgmentJobStorageTransfer} from './judgmentJobStorageTransferRuntime.ts'

const judgmentOutboxBatchMaxRows = 100
const judgmentOutboxBatchMaxBytes = 4 * 1024 * 1024
const judgmentOutboxImportLeaseMs = 30_000
const judgmentOutboxImportLogger = createRateLimitedLogger({windowMs: 30_000})

type JudgmentOutboxDiscardedEntry = {entry: JudgmentJobSqliteOutboxEntry; errorMessage: string}
type ClaimedOutboxBatch = Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['claimPendingOutboxBatch']>>
export type JudgmentJobSqliteOutboxImportCycleResult = {
  claimedBy: string
  discardedCount: number
  duplicateCount: number
  importedCount: number
  jobId: string | null
  outboxClaimId: string | null
  outboxRowCount: number
  status: 'idle' | 'imported'
}
export type JudgmentJobRecoveredDiscardedOutboxRow = {errorMessage: string; jobId: string; outboxSeq: number}
export type JudgmentJobRecoveredOutboxRow = {jobId: string; outboxSeq: number}
export type JudgmentJobRecoveredOutboxImportResult = {
  discardedRows: JudgmentJobRecoveredDiscardedOutboxRow[]
  duplicateRows: JudgmentJobRecoveredOutboxRow[]
  importedRows: JudgmentJobRecoveredOutboxRow[]
  importableRows: JudgmentJobRecoveredOutboxRow[]
  lastImportableOutboxSeqByJob: Record<string, number | null>
}

type JudgmentOutboxForeignKeys = {
  articleIds: Set<string>
  modelIds: Set<string>
  projectIds: Set<string>
  promptIds: Set<string>
}

type JudgmentOutboxStringDiagnostics = {
  hasBackslash: boolean
  hasDoubleQuote: boolean
  hasNewline: boolean
  hasSemicolon: boolean
  hasSingleQuote: boolean
  length: number
}

type JudgmentOutboxFailureSample = {
  answeredOriginal: JudgmentOutboxStringDiagnostics | null
  articleId: string
  explanation: JudgmentOutboxStringDiagnostics | null
  judgmentId: string
  outboxSeq: number
  promptId: string
  queuePromptId: string
  quoteCount: number | null
  rawResponseJsonBytes: number | null
}

type JudgmentNaturalKeyRow = {
  articleId: string
  modelId: string
  promptId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

const getJudgmentInsertRows = (entries: JudgmentJobSqliteOutboxEntry[]): JudgmentInsertRow[] => {
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
      isAnswered: entry.isAnswered ?? true,
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

const getUniqueValues = (values: string[]) => {
  return Array.from(new Set(values))
}

const getJudgmentNaturalKey = ({
  articleId,
  modelId,
  promptId,
  useAbstract,
  useFulltext,
  useFulltextNoImages,
  useTitle,
}: JudgmentNaturalKeyRow) => {
  return [
    articleId,
    promptId,
    modelId,
    String(useTitle),
    String(useAbstract),
    String(useFulltext),
    String(useFulltextNoImages),
  ].join('|')
}

const getJudgmentNaturalKeyPredicate = (entry: JudgmentJobSqliteOutboxEntry) => {
  return `(
    article_id = ${getSqlLiteral(entry.articleId)}
    AND prompt_id = ${getSqlLiteral(entry.promptId)}
    AND model_id = ${getSqlLiteral(entry.modelId)}
    AND use_title = ${getSqlLiteral(entry.useTitle)}
    AND use_abstract = ${getSqlLiteral(entry.useAbstract)}
    AND use_fulltext = ${getSqlLiteral(entry.useFulltext)}
    AND use_fulltext_no_images = ${getSqlLiteral(entry.useFulltextNoImages)}
    AND delete_generation = 0
    AND deleted_at IS NULL
  )`
}

const getExistingJudgmentNaturalKeys = async (entries: JudgmentJobSqliteOutboxEntry[]) => {
  if (entries.length === 0) {
    return new Set<string>()
  }

  const rows = await getAppDatabaseService().queryJson<JudgmentNaturalKeyRow>(`
    SELECT
      article_id AS articleId,
      model_id AS modelId,
      prompt_id AS promptId,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      use_title AS useTitle
    FROM app.judgment
    WHERE ${entries
      .map((entry) => {
        return getJudgmentNaturalKeyPredicate(entry)
      })
      .join(' OR ')}
  `)

  return new Set(
    rows.map((row) => {
      return getJudgmentNaturalKey(row)
    }),
  )
}

const partitionExistingJudgments = async (entries: JudgmentJobSqliteOutboxEntry[]) => {
  const existingNaturalKeys = await getExistingJudgmentNaturalKeys(entries)

  return entries.reduce(
    (state, entry) => {
      return existingNaturalKeys.has(getJudgmentNaturalKey(entry))
        ? {...state, existingEntries: [...state.existingEntries, entry]}
        : {...state, missingEntries: [...state.missingEntries, entry]}
    },
    {existingEntries: [] as JudgmentJobSqliteOutboxEntry[], missingEntries: [] as JudgmentJobSqliteOutboxEntry[]},
  )
}

const getExistingIds = async (
  tableName: 'app.article' | 'app.model' | 'app.project' | 'app.prompt',
  ids: string[],
): Promise<Set<string>> => {
  const uniqueIds = getUniqueValues(ids)

  if (uniqueIds.length === 0) {
    return new Set()
  }

  const rows = await Promise.all(
    uniqueIds.map(async (id) => {
      const [row] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM ${tableName}
        WHERE id = ${getSqlLiteral(id)}
        LIMIT 1
      `)

      return row?.id ?? null
    }),
  )

  return new Set(
    rows.filter((id): id is string => {
      return id !== null
    }),
  )
}

const getExistingForeignKeys = async (entries: JudgmentJobSqliteOutboxEntry[]): Promise<JudgmentOutboxForeignKeys> => {
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

  return {articleIds, modelIds, projectIds, promptIds}
}

const getMissingForeignKeys = (entry: JudgmentJobSqliteOutboxEntry, foreignKeys: JudgmentOutboxForeignKeys) => {
  return [
    foreignKeys.articleIds.has(entry.articleId) ? null : `missing article ${entry.articleId}`,
    foreignKeys.modelIds.has(entry.modelId) ? null : `missing model ${entry.modelId}`,
    entry.projectId === null || foreignKeys.projectIds.has(entry.projectId)
      ? null
      : `missing project ${entry.projectId}`,
    foreignKeys.promptIds.has(entry.promptId) ? null : `missing prompt ${entry.promptId}`,
  ].filter((value): value is string => {
    return value !== null
  })
}

const partitionImportableEntries = async (entries: JudgmentJobSqliteOutboxEntry[]) => {
  const foreignKeys = await getExistingForeignKeys(entries)

  return entries.reduce(
    (state, entry) => {
      const missingForeignKeys = getMissingForeignKeys(entry, foreignKeys)

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
    {discardedEntries: [] as JudgmentOutboxDiscardedEntry[], importableEntries: [] as JudgmentJobSqliteOutboxEntry[]},
  )
}

const insertOutboxEntriesIntoDuckdb = async (entries: JudgmentJobSqliteOutboxEntry[]) => {
  if (entries.length === 0) {
    return
  }

  await getAppDatabaseService().appendJudgments(getJudgmentInsertRows(entries))
}

const markRefreshStateDirtyForEntries = async (entries: JudgmentJobSqliteOutboxEntry[], requestedBy?: string) => {
  const articleIds = Array.from(
    new Set(
      entries.map((entry) => {
        return entry.articleId
      }),
    ),
  )

  if (articleIds.length === 0) {
    return
  }

  await getProjectMartRefreshStateService().markArticleProjectsDirtyAtomically({
    articleIds,
    reason: 'sqliteJudgmentOutboxImport',
    requestedBy: requestedBy ?? null,
  })
}

const getRecoveredOutboxRows = (entries: JudgmentJobSqliteOutboxEntry[]): JudgmentJobRecoveredOutboxRow[] => {
  return entries.map((entry) => {
    return {jobId: entry.jobId, outboxSeq: entry.outboxSeq}
  })
}

const getLastImportableOutboxSeqByJob = (entries: JudgmentJobSqliteOutboxEntry[]) => {
  return entries.reduce<Record<string, number | null>>((acc, entry) => {
    const currentMax = acc[entry.jobId]

    return {...acc, [entry.jobId]: currentMax == null ? entry.outboxSeq : Math.max(currentMax, entry.outboxSeq)}
  }, {})
}

const repairLegacyCompletionEvidenceForJobIds = async ({
  claimedBy,
  jobIds,
}: {
  claimedBy: string
  jobIds: string[]
}): Promise<void> => {
  const [currentJobId = ''] = jobIds

  if (!currentJobId) {
    return
  }

  try {
    await getJudgmentJobSqliteService().repairLegacyCompletionEvidence({jobId: currentJobId, serverJobId: claimedBy})
  } catch (error) {
    if (!(error instanceof JudgmentJobLeaseError)) {
      throw error
    }
  }

  return repairLegacyCompletionEvidenceForJobIds({claimedBy, jobIds: jobIds.slice(1)})
}

const getImportCandidateJobIds = async (jobId?: string) => {
  if (jobId) {
    return [jobId]
  }

  const trackedJobIds = getJudgmentJobSqliteJobIds().sort()

  if (trackedJobIds.length === 0) {
    const rows = await getAppDatabaseService().queryJson<{id: string}>(`
      SELECT id
      FROM app.judgment_job
      WHERE (${getImportableJudgmentJobWhereSql()})
      ORDER BY id ASC
    `)

    return rows.map((row) => {
      return row.id
    })
  }

  const rows = await Promise.all(
    trackedJobIds.map(async (trackedJobId) => {
      const [row] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.judgment_job
        WHERE id = ${getSqlLiteral(trackedJobId)}
          AND (${getImportableJudgmentJobWhereSql()})
        LIMIT 1
      `)

      return row?.id ?? null
    }),
  )

  return rows.filter((trackedJobId): trackedJobId is string => {
    return trackedJobId !== null
  })
}

const getStringDiagnostics = (value: string | null): JudgmentOutboxStringDiagnostics | null => {
  if (value === null) {
    return null
  }

  return {
    hasBackslash: value.includes('\\'),
    hasDoubleQuote: value.includes('"'),
    hasNewline: value.includes('\n'),
    hasSemicolon: value.includes(';'),
    hasSingleQuote: value.includes("'"),
    length: value.length,
  }
}

const getSerializedBytes = (value: unknown) => {
  if (value === null || value === undefined) {
    return null
  }

  return new TextEncoder().encode(JSON.stringify(value)).length
}

const getFailureSample = (entry: JudgmentJobSqliteOutboxEntry): JudgmentOutboxFailureSample => {
  return {
    answeredOriginal: getStringDiagnostics(entry.answeredOriginal),
    articleId: entry.articleId,
    explanation: getStringDiagnostics(entry.explanation),
    judgmentId: entry.judgmentId,
    outboxSeq: entry.outboxSeq,
    promptId: entry.promptId,
    queuePromptId: entry.queuePromptId,
    quoteCount: Array.isArray(entry.quotes) ? entry.quotes.length : null,
    rawResponseJsonBytes: getSerializedBytes(entry.rawResponseJson),
  }
}

const getFailureDiagnostics = ({
  claim,
  rows,
}: {
  claim: JudgmentJobSqliteOutboxClaim
  rows: JudgmentJobSqliteOutboxEntry[]
}) => {
  const firstOutboxSeq = rows[0]?.outboxSeq ?? null
  const lastOutboxSeq = rows[rows.length - 1]?.outboxSeq ?? null

  return {
    claimId: claim.claimId,
    firstOutboxSeq,
    lastOutboxSeq,
    rowCount: claim.rowCount,
    sampleRows: rows.slice(0, 3).map(getFailureSample),
  }
}

const getJudgmentJobProjectId = async (jobId: string) => {
  const [row] = await getAppDatabaseService().queryJson<{projectId: string}>(`
    SELECT project_id AS projectId
    FROM app.judgment_job
    WHERE id = ${getSqlLiteral(jobId)}
    LIMIT 1
  `)

  return row?.projectId ?? null
}

const claimJudgmentImportMaintenanceWork = async ({
  claim,
  claimedBy,
}: {
  claim: JudgmentJobSqliteOutboxClaim
  claimedBy: string
}) => {
  const projectId = await getJudgmentJobProjectId(claim.jobId)

  await getMaintenanceWorkLeaseService().claimMaintenanceWorkLease({
    consumerId: claimedBy,
    judgmentJobId: claim.jobId,
    leaseMs: judgmentOutboxImportLeaseMs,
    projectId,
    recoveryContext: {claimId: claim.claimId, rowCount: claim.rowCount},
    requiredConsumerRole: 'judge-worker',
    scopeKind: 'job',
    workKind: 'judgment_sqlite_outbox_import',
  })

  return projectId
}

const completeJudgmentImportMaintenanceWork = async ({
  claimedBy,
  jobId,
  projectId,
}: {
  claimedBy: string
  jobId: string
  projectId: string | null
}) => {
  await getMaintenanceWorkLeaseService().completeMaintenanceWorkLease({
    consumerId: claimedBy,
    judgmentJobId: jobId,
    projectId,
    scopeKind: 'job',
    workKind: 'judgment_sqlite_outbox_import',
  })
}

const failJudgmentImportMaintenanceWork = async ({
  claim,
  claimedBy,
  errorMessage,
  projectId,
}: {
  claim: JudgmentJobSqliteOutboxClaim
  claimedBy: string
  errorMessage: string
  projectId: string | null
}) => {
  await getMaintenanceWorkLeaseService().failMaintenanceWorkLease({
    consumerId: claimedBy,
    judgmentJobId: claim.jobId,
    leaseMs: judgmentOutboxImportLeaseMs,
    projectId,
    recoveryContext: {claimId: claim.claimId, error: errorMessage, rowCount: claim.rowCount},
    requiredConsumerRole: 'judge-worker',
    scopeKind: 'job',
    workKind: 'judgment_sqlite_outbox_import',
  })
}

const claimPendingOutboxBatchForJobIds = async ({
  claimedBy,
  jobIds,
}: {
  claimedBy: string
  jobIds: string[]
}): Promise<ClaimedOutboxBatch> => {
  const sqliteService = getJudgmentJobSqliteService()
  const [currentJobId = ''] = jobIds

  if (!currentJobId) {
    return null
  }

  try {
    const claimedBatch = await sqliteService.claimPendingOutboxBatch({
      claimedBy,
      jobId: currentJobId,
      maxBytes: judgmentOutboxBatchMaxBytes,
      maxRows: judgmentOutboxBatchMaxRows,
    })

    return claimedBatch ?? claimPendingOutboxBatchForJobIds({claimedBy, jobIds: jobIds.slice(1)})
  } catch (error) {
    if (error instanceof JudgmentJobLeaseError) {
      judgmentOutboxImportLogger.log(
        `importJudgments:lease:${currentJobId}`,
        '[importJudgments] skipped SQLite job because this process does not own the job lease',
        {jobId: currentJobId},
      )

      return claimPendingOutboxBatchForJobIds({claimedBy, jobIds: jobIds.slice(1)})
    }

    throw error
  }
}

const getClaimedOutboxBatchForJobIds = async ({
  claimedBy,
  jobIds,
}: {
  claimedBy: string
  jobIds: string[]
}): Promise<ClaimedOutboxBatch> => {
  const sqliteService = getJudgmentJobSqliteService()
  const [currentJobId = ''] = jobIds

  if (!currentJobId) {
    return null
  }

  try {
    const claimedBatch = await sqliteService.getClaimedOutboxBatch({jobId: currentJobId, serverJobId: claimedBy})

    return claimedBatch ?? getClaimedOutboxBatchForJobIds({claimedBy, jobIds: jobIds.slice(1)})
  } catch (error) {
    if (error instanceof JudgmentJobLeaseError) {
      judgmentOutboxImportLogger.log(
        `recoverJudgments:lease:${currentJobId}`,
        '[recoverJudgments] skipped SQLite job because this process does not own the job lease',
        {jobId: currentJobId},
      )

      return getClaimedOutboxBatchForJobIds({claimedBy, jobIds: jobIds.slice(1)})
    }

    throw error
  }
}

const getIdleCycleResult = ({
  claimedBy,
  jobId,
}: {
  claimedBy: string
  jobId?: string
}): JudgmentJobSqliteOutboxImportCycleResult => {
  return {
    claimedBy,
    discardedCount: 0,
    duplicateCount: 0,
    importedCount: 0,
    jobId: jobId ?? null,
    outboxClaimId: null,
    outboxRowCount: 0,
    status: 'idle',
  }
}

const getImportBatch = async ({claimedBy, jobId}: {claimedBy: string; jobId?: string}) => {
  const sqliteService = getJudgmentJobSqliteService()
  const jobIds = await getImportCandidateJobIds(jobId)

  await repairLegacyCompletionEvidenceForJobIds({claimedBy, jobIds})

  const claimedBatch = jobId
    ? await sqliteService.getClaimedOutboxBatch({jobId, serverJobId: claimedBy})
    : await getClaimedOutboxBatchForJobIds({claimedBy, jobIds})

  return claimedBatch
    ? claimedBatch
    : jobId
      ? await sqliteService.claimPendingOutboxBatch({
          claimedBy,
          jobId,
          maxBytes: judgmentOutboxBatchMaxBytes,
          maxRows: judgmentOutboxBatchMaxRows,
        })
      : await claimPendingOutboxBatchForJobIds({claimedBy, jobIds})
}

export const claimJudgmentJobSqliteImportBatch = async ({
  claimedBy = getDefaultJudgmentServerJobId(),
  jobId,
}: {claimedBy?: string; jobId?: string} = {}): Promise<JudgmentJobSqliteClaimedOutboxBatch | null> => {
  return getImportBatch({claimedBy, jobId})
}

export const importRecoveredJudgmentJobSqliteOutboxEntries = async (
  entries: JudgmentJobSqliteOutboxEntry[],
): Promise<JudgmentJobRecoveredOutboxImportResult> => {
  const {discardedEntries, importableEntries} = await partitionImportableEntries(entries)
  const {existingEntries, missingEntries} = await partitionExistingJudgments(importableEntries)

  await insertOutboxEntriesIntoDuckdb(missingEntries)

  const {missingEntries: remainingEntries} = await partitionExistingJudgments(importableEntries)

  if (remainingEntries.length > 0) {
    throw new Error(
      `Failed to replay recovered SQLite judgment outbox rows for ${remainingEntries[0]?.jobId ?? 'unknown-job'}`,
    )
  }

  if (importableEntries.length > 0) {
    await markRefreshStateDirtyForEntries(importableEntries)
  }

  return {
    discardedRows: discardedEntries.map(({entry, errorMessage}) => {
      return {errorMessage, jobId: entry.jobId, outboxSeq: entry.outboxSeq}
    }),
    duplicateRows: getRecoveredOutboxRows(existingEntries),
    importedRows: getRecoveredOutboxRows(missingEntries),
    importableRows: getRecoveredOutboxRows(importableEntries),
    lastImportableOutboxSeqByJob: getLastImportableOutboxSeqByJob(importableEntries),
  }
}

export const runJudgmentJobSqliteOutboxImportCycleForClaimedBatch = async ({
  claimedBatch,
  claimedBy,
  requestedJobId,
}: {
  claimedBatch: JudgmentJobSqliteClaimedOutboxBatch | null
  claimedBy: string
  requestedJobId?: string
}): Promise<JudgmentJobSqliteOutboxImportCycleResult> => {
  const sqliteService = getJudgmentJobSqliteService()

  if (!claimedBatch) {
    return getIdleCycleResult({claimedBy, jobId: requestedJobId})
  }

  const {claim, rows} = claimedBatch
  const projectId = await claimJudgmentImportMaintenanceWork({claim, claimedBy})

  try {
    const {discardedEntries, importableEntries} = await partitionImportableEntries(rows)
    const {missingEntries} = await partitionExistingJudgments(importableEntries)
    const duplicateCount = importableEntries.length - missingEntries.length

    const discardedClearedCount = await sqliteService.completeClaimedOutboxRows({
      claimId: claim.claimId,
      jobId: claim.jobId,
      rows: discardedEntries.map(({entry, errorMessage}) => {
        return {errorMessage, outboxSeq: entry.outboxSeq}
      }),
    })
    await insertOutboxEntriesIntoDuckdb(missingEntries)
    const {missingEntries: remainingEntries} = await partitionExistingJudgments(importableEntries)

    if (remainingEntries.length > 0) {
      throw new Error(`Failed to replay SQLite judgment outbox claim ${claim.claimId}`)
    }

    if (importableEntries.length > 0) {
      await markRefreshStateDirtyForEntries(importableEntries, claimedBy)
    }

    const importedClearedCount = await sqliteService.completeOutboxClaim({claimId: claim.claimId, jobId: claim.jobId})

    recordJudgmentJobStorageTransfer({
      clearedRows: discardedClearedCount + importedClearedCount,
      insertedRows: missingEntries.length,
      jobId: claim.jobId,
    })
    await completeJudgmentImportMaintenanceWork({claimedBy, jobId: claim.jobId, projectId})

    return {
      claimedBy,
      discardedCount: discardedEntries.length,
      duplicateCount,
      importedCount: importableEntries.length,
      jobId: claim.jobId,
      outboxClaimId: claim.claimId,
      outboxRowCount: claim.rowCount,
      status: 'imported',
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    judgmentOutboxImportLogger.warn(
      `importJudgments:failed:${claim.jobId}:${claim.claimId}`,
      '[importJudgments] failed to import SQLite outbox claim',
      {claimedBy, errorMessage, jobId: claim.jobId, ...getFailureDiagnostics({claim, rows})},
    )

    await sqliteService.releaseOutboxClaim({claimId: claim.claimId, errorMessage, jobId: claim.jobId})
    await failJudgmentImportMaintenanceWork({claim, claimedBy, errorMessage, projectId})
    throw error
  }
}

export const runJudgmentJobSqliteOutboxImportCycle = async ({
  claimedBy = getDefaultJudgmentServerJobId(),
  jobId,
}: {claimedBy?: string; jobId?: string} = {}): Promise<JudgmentJobSqliteOutboxImportCycleResult> => {
  const claimedBatch = await getImportBatch({claimedBy, jobId})

  return runJudgmentJobSqliteOutboxImportCycleForClaimedBatch({claimedBatch, claimedBy, requestedJobId: jobId})
}

export const importJudgmentJobSqliteOutboxBatch = async ({
  claimedBy = getDefaultJudgmentServerJobId(),
  jobId,
}: {claimedBy?: string; jobId?: string} = {}): Promise<number> => {
  return (await runJudgmentJobSqliteOutboxImportCycle({claimedBy, jobId})).importedCount
}

export const flushJudgmentJobSqliteOutbox = async ({
  claimedBy = getDefaultJudgmentServerJobId(),
  jobId,
}: {claimedBy?: string; jobId?: string} = {}): Promise<number> => {
  const flush = async (totalImported: number): Promise<number> => {
    const imported = await importJudgmentJobSqliteOutboxBatch({claimedBy, jobId})
    return imported === 0 ? totalImported : flush(totalImported + imported)
  }

  return flush(0)
}
