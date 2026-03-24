import {getAppDatabaseService, type JudgmentInsertRow} from '../../services/appDatabaseService.ts'
import {getDuckdbMartRefreshService} from '../../services/getDuckdbMartRefreshService.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {getJudgmentJobSqliteService, type JudgmentJobSqliteOutboxEntry} from './judgmentJobSqliteService.ts'

const judgmentOutboxBatchMaxRows = 100
const judgmentOutboxBatchMaxBytes = 4 * 1024 * 1024

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
    await insertOutboxEntriesIntoDuckdb(rows)
    await queueRefreshesForEntries(rows)
    await sqliteService.completeOutboxClaim({claimId: claim.claimId, jobId: claim.jobId})
    return rows.length
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
