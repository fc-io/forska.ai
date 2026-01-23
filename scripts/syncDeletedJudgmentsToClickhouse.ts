/**
 * Sync deleted judgments from PostgreSQL to ClickHouse
 * Run with: bun run scripts/syncDeletedJudgmentsToClickhouse.ts
 */
import {isNotNull} from 'drizzle-orm'

import {articles, judgments} from '../src/db/schema.ts'
import {getClickhouseClient} from '../src/services/clickhouse/clickhouseClient.ts'
import {getDatabase} from '../src/server/utils/getDatabase.ts'

const syncDeletedJudgments = async () => {
  const db = getDatabase()
  const chClient = getClickhouseClient()

  console.log('[Sync] Fetching deleted judgments from PostgreSQL...')

  const deletedJudgments = await db
    .select({
      id: judgments.id,
      createdAt: judgments.createdAt,
      deletedAt: judgments.deletedAt,
      articleId: judgments.articleId,
      promptId: judgments.promptId,
      modelId: judgments.modelId,
      useTitle: judgments.useTitle,
      useAbstract: judgments.useAbstract,
      useFulltext: judgments.useFulltext,
      useFulltextNoImages: judgments.useFulltextNoImages,
      answeredOriginal: judgments.answeredOriginal,
      answeredOriginalAsArray: judgments.answeredOriginalAsArray,
    })
    .from(judgments)
    .where(isNotNull(judgments.deletedAt))

  console.log(`[Sync] Found ${deletedJudgments.length} deleted judgments in PostgreSQL`)

  if (deletedJudgments.length === 0) {
    console.log('[Sync] Nothing to sync')
    return
  }

  const articleIds = [...new Set(deletedJudgments.map((j) => j.articleId))]
  console.log(`[Sync] Fetching ${articleIds.length} articles...`)

  const articleRows = await db.select().from(articles).where(isNotNull(articles.id))
  const articlesMap = new Map(articleRows.map((a) => [a.id, a]))

  console.log(`[Sync] Preparing ClickHouse records...`)

  const clickhouseRecords = deletedJudgments.map((judgment) => {
    const article = articlesMap.get(judgment.articleId)
    return {
      id: judgment.id,
      createdAt: judgment.createdAt,
      deletedAt: judgment.deletedAt,
      articleId: judgment.articleId,
      articleTitle: article?.articleTitle ?? null,
      articleCreatedAt: article?.articleCreatedAt ?? null,
      articleUpdatedAt: article?.articleUpdatedAt ?? null,
      articleCreatedYear: article?.articleCreatedAt ? article.articleCreatedAt.getUTCFullYear() : null,
      articleUpdatedYear: article?.articleUpdatedAt ? article.articleUpdatedAt.getUTCFullYear() : null,
      articleImportRoute: article?.importRoute ?? null,
      articleImportedBy: article?.importedBy ?? null,
      promptId: judgment.promptId,
      modelId: judgment.modelId,
      useTitle: judgment.useTitle,
      useAbstract: judgment.useAbstract,
      useFulltext: judgment.useFulltext,
      useFulltextNoImages: judgment.useFulltextNoImages,
      answeredOriginal: judgment.answeredOriginal,
      answeredOriginalAsArray: judgment.answeredOriginalAsArray ?? [],
      explanation: null,
      quotes: null,
    }
  })

  console.log(`[Sync] Inserting ${clickhouseRecords.length} tombstone records to ClickHouse...`)

  await chClient.insert({
    table: 'forska.judgments',
    values: clickhouseRecords,
    format: 'JSONEachRow',
  })

  console.log('[Sync] Done! ClickHouse now has all deleted judgments as tombstones.')
}

syncDeletedJudgments()
  .then(() => {
    console.log('[Sync] Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('[Sync] Failed:', error)
    process.exit(1)
  })
