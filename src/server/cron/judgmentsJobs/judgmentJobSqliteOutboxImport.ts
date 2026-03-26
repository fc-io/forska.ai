import {getAppDatabaseService, type JudgmentInsertRow} from '../../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getDuckdbMartRefreshService} from '../../services/getDuckdbMartRefreshService.ts'
import {createRateLimitedLogger} from '../../utils/rateLimitedLogger.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {
  getJudgmentJobSqliteService,
  JudgmentJobLeaseError,
  type JudgmentJobSqliteOutboxEntry,
} from './judgmentJobSqliteService.ts'

const judgmentOutboxBatchMaxRows = 100
const judgmentOutboxBatchMaxBytes = 4 * 1024 * 1024
const judgmentOutboxImportLogger = createRateLimitedLogger({windowMs: 30_000})

type JudgmentOutboxDiscardedEntry = {entry: JudgmentJobSqliteOutboxEntry; errorMessage: string}
type ClaimedOutboxBatch = Awaited<ReturnType<ReturnType<typeof getJudgmentJobSqliteService>['claimPendingOutboxBatch']>>

type JudgmentOutboxForeignKeys = {
  articleIds: Set<string>
  modelIds: Set<string>
  projectIds: Set<string>
  promptIds: Set<string>
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

  return uniqueIds.length === 0
    ? new Set()
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

const queueRefreshesForEntries = async (entries: JudgmentJobSqliteOutboxEntry[]) => {
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

  await getDuckdbMartRefreshService().queueJudgmentArticleRefreshes(articleIds, 'sqliteJudgmentOutboxImport')
}

const getLastImportedOutboxSeq = (entries: JudgmentJobSqliteOutboxEntry[]) => {
  return entries.reduce<number | null>((maxOutboxSeq, entry) => {
    return maxOutboxSeq == null ? entry.outboxSeq : Math.max(maxOutboxSeq, entry.outboxSeq)
  }, null)
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

const getImportBatch = async ({claimedBy, jobId}: {claimedBy: string; jobId?: string}) => {
  const sqliteService = getJudgmentJobSqliteService()
  const claimedBatch = jobId
    ? await sqliteService.getClaimedOutboxBatch({jobId, serverJobId: claimedBy})
    : await getClaimedOutboxBatchForJobIds({claimedBy, jobIds: sqliteService.listJobIds().sort()})

  return claimedBatch
    ? claimedBatch
    : jobId
      ? await sqliteService.claimPendingOutboxBatch({
          claimedBy,
          jobId,
          maxBytes: judgmentOutboxBatchMaxBytes,
          maxRows: judgmentOutboxBatchMaxRows,
        })
      : await claimPendingOutboxBatchForJobIds({claimedBy, jobIds: sqliteService.listJobIds().sort()})
}

export const importJudgmentJobSqliteOutboxBatch = async ({
  claimedBy = getDefaultJudgmentServerJobId(),
  jobId,
}: {claimedBy?: string; jobId?: string} = {}): Promise<number> => {
  const sqliteService = getJudgmentJobSqliteService()
  const claimedBatch = await getImportBatch({claimedBy, jobId})

  if (!claimedBatch) {
    return 0
  }

  const {claim, rows} = claimedBatch

  try {
    const {discardedEntries, importableEntries} = await partitionImportableEntries(rows)
    const {missingEntries} = await partitionExistingJudgments(importableEntries)
    const lastImportedOutboxSeq = getLastImportedOutboxSeq(importableEntries)

    await sqliteService.completeClaimedOutboxRows({
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
      await queueRefreshesForEntries(importableEntries)
      await getDuckdbMartRefreshService().flush()
      await sqliteService.setLastProjectRefreshAckSeq(claim.jobId, lastImportedOutboxSeq)
    }

    await sqliteService.completeOutboxClaim({claimId: claim.claimId, jobId: claim.jobId})
    return importableEntries.length
  } catch (error) {
    await sqliteService.releaseOutboxClaim({
      claimId: claim.claimId,
      errorMessage: error instanceof Error ? error.message : String(error),
      jobId: claim.jobId,
    })
    throw error
  }
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
