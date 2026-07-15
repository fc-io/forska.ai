import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {
  getCanonicalArticleIdResolutionKey,
  getCanonicalArticleIdResolutionMap,
} from '../../services/articleIdCompatibilityAdapter.ts'
import {getMaintenanceWorkLeaseService} from '../../services/maintenanceWorkLeaseService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import type {DuckdbWorkloadContext} from '../../utils/duckdbService.ts'
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
import {commitJudgmentSqliteOutboxImportDirtyWork} from './judgmentsJobsMarkDirtyWork.ts'

const judgmentOutboxBatchMaxRows = 100
const judgmentOutboxBatchMaxBytes = 4 * 1024 * 1024
const judgmentOutboxImportLeaseMs = 30_000
const judgmentOutboxImportLogger = createRateLimitedLogger({windowMs: 30_000})
const maxImportCandidateJobsPerScan = 100
const judgmentOutboxImportLookupWorkloadContext: DuckdbWorkloadContext = {
  fallbackIntent: 'reject',
  routeOrJobKey: 'judgmentJob.sqliteOutboxImport.lookup',
  workloadClass: 'background.judgmentJob.sqliteImport',
}

const queryOutboxImportBackground = async <T>(statement: string, workloadContext: DuckdbWorkloadContext) => {
  const database = getAppDatabaseService()
  const queryJsonBackground = database.queryJsonBackground ?? database.queryJson

  return queryJsonBackground<T>(statement, workloadContext)
}

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

const canonicalizeOutboxEntryArticleIds = async (
  entries: JudgmentJobSqliteOutboxEntry[],
): Promise<JudgmentJobSqliteOutboxEntry[]> => {
  const articleIdMap = await getCanonicalArticleIdResolutionMap(
    getAppDatabaseService(),
    entries.map((entry) => {
      return {articleId: entry.articleId, projectId: entry.projectId}
    }),
  )

  return entries.map((entry) => {
    const canonicalArticleId = articleIdMap.get(
      getCanonicalArticleIdResolutionKey({articleId: entry.articleId, projectId: entry.projectId}),
    )
    return canonicalArticleId ? {...entry, articleId: canonicalArticleId} : entry
  })
}

const getUniqueValues = (values: string[]) => {
  return Array.from(new Set(values))
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
      const [row] = await queryOutboxImportBackground<{id: string}>(
        `
        SELECT id
        FROM ${tableName}
        WHERE id = ${getSqlLiteral(id)}
        LIMIT 1
      `,
        {...judgmentOutboxImportLookupWorkloadContext, maxResultRows: 1},
      )

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
    const rows = await queryOutboxImportBackground<{id: string}>(
      `
      SELECT id
      FROM app.judgment_job
      WHERE (${getImportableJudgmentJobWhereSql()})
      ORDER BY id ASC
      LIMIT ${maxImportCandidateJobsPerScan}
    `,
      {...judgmentOutboxImportLookupWorkloadContext, maxResultRows: maxImportCandidateJobsPerScan},
    )

    return rows.map((row) => {
      return row.id
    })
  }

  const rows = await Promise.all(
    trackedJobIds.map(async (trackedJobId) => {
      const [row] = await queryOutboxImportBackground<{id: string}>(
        `
        SELECT id
        FROM app.judgment_job
        WHERE id = ${getSqlLiteral(trackedJobId)}
          AND (${getImportableJudgmentJobWhereSql()})
        LIMIT 1
      `,
        {...judgmentOutboxImportLookupWorkloadContext, maxResultRows: 1},
      )

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
  const [row] = await queryOutboxImportBackground<{projectId: string}>(
    `
    SELECT project_id AS projectId
    FROM app.judgment_job
    WHERE id = ${getSqlLiteral(jobId)}
    LIMIT 1
  `,
    {...judgmentOutboxImportLookupWorkloadContext, maxResultRows: 1},
  )

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
  claimedBy?: string
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
  const canonicalEntries = await canonicalizeOutboxEntryArticleIds(entries)
  const {discardedEntries, importableEntries} = await partitionImportableEntries(canonicalEntries)
  const dirtyWorkResult = await commitJudgmentSqliteOutboxImportDirtyWork({discardedEntries, importableEntries})

  return {
    discardedRows: dirtyWorkResult.discardedRows,
    duplicateRows: dirtyWorkResult.duplicateRows,
    importedRows: dirtyWorkResult.importedRows,
    importableRows: dirtyWorkResult.importableRows,
    lastImportableOutboxSeqByJob: getLastImportableOutboxSeqByJob(importableEntries),
  }
}

const completeDrainedJudgmentImportMaintenanceWorkForJob = async ({jobId}: {jobId: string}) => {
  const sqliteService = getJudgmentJobSqliteService()
  const unexportedOutboxCount = await sqliteService.getUnexportedOutboxCount(jobId)

  if (unexportedOutboxCount === 0) {
    await completeJudgmentImportMaintenanceWork({jobId, projectId: await getJudgmentJobProjectId(jobId)})
  }
}

const completeDrainedJudgmentImportMaintenanceWork = async ({jobIds}: {jobIds: string[]}) => {
  await jobIds.reduce<Promise<void>>(async (promise, jobId) => {
    await promise
    await completeDrainedJudgmentImportMaintenanceWorkForJob({jobId})
  }, Promise.resolve())
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
    await completeDrainedJudgmentImportMaintenanceWork({jobIds: await getImportCandidateJobIds(requestedJobId)})
    return getIdleCycleResult({claimedBy, jobId: requestedJobId})
  }

  const {claim, rows} = claimedBatch
  const projectId = await claimJudgmentImportMaintenanceWork({claim, claimedBy})

  try {
    const canonicalRows = await canonicalizeOutboxEntryArticleIds(rows)
    const {discardedEntries, importableEntries} = await partitionImportableEntries(canonicalRows)
    const dirtyWorkResult = await commitJudgmentSqliteOutboxImportDirtyWork({
      discardedEntries,
      importableEntries,
      requestedBy: claimedBy,
    })
    const duplicateCount = dirtyWorkResult.duplicateRows.length
    const discardedClearedCount = await sqliteService.completeClaimedOutboxRows({
      claimId: claim.claimId,
      jobId: claim.jobId,
      rows: dirtyWorkResult.discardedRows.map((row) => {
        return {errorMessage: row.errorMessage, outboxSeq: row.outboxSeq}
      }),
    })
    const importedClearedCount = await sqliteService.completeOutboxClaim({claimId: claim.claimId, jobId: claim.jobId})

    recordJudgmentJobStorageTransfer({
      clearedRows: discardedClearedCount + importedClearedCount,
      insertedRows: dirtyWorkResult.importedRows.length,
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
