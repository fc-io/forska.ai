import {getAppDatabaseService, type JudgmentInsertRow} from '../../services/appDatabaseService.ts'
import {getQuotedStringList} from '../../services/appQueryHelpers.ts'
import {getDuckdbMartRefreshService} from '../../services/getDuckdbMartRefreshService.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {getJudgmentJobSqliteService, type JudgmentJobSqliteOutboxEntry} from './judgmentJobSqliteService.ts'

const judgmentOutboxBatchMaxRows = 100
const judgmentOutboxBatchMaxBytes = 4 * 1024 * 1024

type JudgmentOutboxDiscardedEntry = {entry: JudgmentJobSqliteOutboxEntry; errorMessage: string}

type JudgmentOutboxForeignKeys = {
  articleIds: Set<string>
  modelIds: Set<string>
  projectIds: Set<string>
  promptIds: Set<string>
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

export const importJudgmentJobSqliteOutboxBatch = async ({
  claimedBy = getDefaultJudgmentServerJobId(),
  jobId,
}: {claimedBy?: string; jobId?: string} = {}): Promise<number> => {
  const sqliteService = getJudgmentJobSqliteService()
  const claimedBatch = await sqliteService.claimPendingOutboxBatch({
    claimedBy,
    jobId,
    maxBytes: judgmentOutboxBatchMaxBytes,
    maxRows: judgmentOutboxBatchMaxRows,
  })

  if (!claimedBatch) {
    return 0
  }

  const {claim, rows} = claimedBatch

  try {
    const {discardedEntries, importableEntries} = await partitionImportableEntries(rows)

    await sqliteService.completeClaimedOutboxRows({
      claimId: claim.claimId,
      jobId: claim.jobId,
      rows: discardedEntries.map(({entry, errorMessage}) => {
        return {errorMessage, outboxSeq: entry.outboxSeq}
      }),
    })
    await insertOutboxEntriesIntoDuckdb(importableEntries)
    await queueRefreshesForEntries(importableEntries)
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
