import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getDuckdbMartRefreshService} from '../../services/getDuckdbMartRefreshService.ts'
import {getJudgmentJobSqliteService, type JudgmentJobSqliteOutboxEntry} from './judgmentJobSqliteService.ts'

const judgmentOutboxBatchMaxRows = 100
const judgmentOutboxBatchMaxBytes = 4 * 1024 * 1024

const getInsertValues = (entry: JudgmentJobSqliteOutboxEntry) => {
  return `(
    ${getQuotedStringList([entry.judgmentId, entry.articleId, entry.modelId, entry.promptId]).join(', ')},
    ${getSqlLiteral(entry.projectId)},
    ${getSqlLiteral(entry.isAnswered ?? true)},
    ${getSqlLiteral(entry.answeredOriginal)},
    ${getSqlLiteral(entry.answeredOriginalAsArray)},
    ${getSqlLiteral(entry.confidenceOriginal)},
    ${getSqlLiteral(entry.explanation)},
    ${getSqlLiteral(entry.quotes)},
    ${getSqlLiteral(entry.useTitle)},
    ${getSqlLiteral(entry.useAbstract)},
    ${getSqlLiteral(entry.useFulltext)},
    ${getSqlLiteral(entry.useFulltextNoImages)},
    ${getSqlLiteral(entry.chunkingStrategy)},
    ${getSqlLiteral(entry.snapshotProjectId)},
    ${getSqlLiteral(entry.snapshotProjectModelName)},
    ${getSqlLiteral(entry.createdAt)},
    ${getSqlLiteral(entry.updatedAt)}
  )`
}

const insertOutboxEntriesIntoDuckdb = async (entries: JudgmentJobSqliteOutboxEntry[]) => {
  if (entries.length === 0) {
    return
  }

  await getAppDatabaseService().run(`
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
    ) VALUES ${entries
      .map((entry) => {
        return getInsertValues(entry)
      })
      .join(', ')}
    ON CONFLICT(article_id, prompt_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images, delete_generation) DO NOTHING
  `)
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

const getBatchEntryRefs = (entries: JudgmentJobSqliteOutboxEntry[]) => {
  return entries.map((entry) => {
    return {jobId: entry.jobId, outboxSeq: entry.outboxSeq}
  })
}

export const importJudgmentJobSqliteOutboxBatch = async ({jobId}: {jobId?: string} = {}): Promise<number> => {
  const sqliteService = getJudgmentJobSqliteService()
  const entries = await sqliteService.getPendingOutboxBatch({
    jobId,
    maxBytes: judgmentOutboxBatchMaxBytes,
    maxRows: judgmentOutboxBatchMaxRows,
  })

  if (entries.length === 0) {
    return 0
  }

  try {
    await insertOutboxEntriesIntoDuckdb(entries)
    await queueRefreshesForEntries(entries)
    await sqliteService.markOutboxExported(getBatchEntryRefs(entries))
    return entries.length
  } catch (error) {
    await sqliteService.markOutboxExportFailed(
      getBatchEntryRefs(entries),
      error instanceof Error ? error.message : String(error),
    )
    throw error
  }
}

export const flushJudgmentJobSqliteOutbox = async ({jobId}: {jobId?: string} = {}): Promise<number> => {
  const flush = async (totalImported: number): Promise<number> => {
    const imported = await importJudgmentJobSqliteOutboxBatch({jobId})
    return imported === 0 ? totalImported : flush(totalImported + imported)
  }

  return flush(0)
}
