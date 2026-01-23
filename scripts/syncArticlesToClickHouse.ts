/**
 * Incremental sync of articles from PostgreSQL to ClickHouse.
 *
 * Uses ReplacingMergeTree with updated_at as version column:
 * - New rows are inserted
 * - Updated rows overwrite older versions during merge
 *
 * Syncs in batches to avoid ClickHouse memory limits (full_text is large).
 *
 * Run manually: bun scripts/syncArticlesToClickHouse.ts
 * Or via cron: Add to Elysia cron for scheduled execution
 */
import {getClickhouseClient} from '../src/services/clickhouse/clickhouseClient.ts'

const BATCH_SIZE = 5000
const PG_CONN = {
  host: process.env['CLICKHOUSE_PG_HOST'] ?? 'db',
  port: process.env['CLICKHOUSE_PG_PORT'] ?? '5432',
  database: 'postgres',
  user: 'ch_replicator',
  password: 'ch_replicator_dev_pass',
}

type SyncResult = {syncedRows: number; lastUpdatedAt: string | null; durationMs: number}

const getLastSyncedUpdatedAt = async (): Promise<string | null> => {
  const client = getClickhouseClient()
  const result = await client.query({
    query: 'SELECT max(updated_at) as max_updated_at FROM forska.articles',
    format: 'JSONEachRow',
  })
  const rows = await result.json<{max_updated_at: string | null}>()
  const firstRow = Array.isArray(rows) ? rows[0] : rows
  return firstRow?.max_updated_at ?? null
}

const countPendingArticles = async (sinceUpdatedAt: string | null): Promise<number> => {
  const client = getClickhouseClient()
  const pgConnStr = `'${PG_CONN.host}:${PG_CONN.port}', '${PG_CONN.database}', 'articles', '${PG_CONN.user}', '${PG_CONN.password}'`

  const whereClause = sinceUpdatedAt ? `WHERE updated_at > '${sinceUpdatedAt}'` : ''

  const countResult = await client.query({
    query: `SELECT count() as cnt FROM postgresql(${pgConnStr}) ${whereClause}`,
    format: 'JSONEachRow',
  })
  const countRows = await countResult.json<{cnt: string}>()
  const firstRow = Array.isArray(countRows) ? countRows[0] : countRows
  return parseInt(firstRow?.cnt ?? '0', 10)
}

const syncArticlesBatch = async (sinceUpdatedAt: string | null, offset: number): Promise<number> => {
  const client = getClickhouseClient()
  const pgConnStr = `'${PG_CONN.host}:${PG_CONN.port}', '${PG_CONN.database}', 'articles', '${PG_CONN.user}', '${PG_CONN.password}'`

  const whereClause = sinceUpdatedAt ? `WHERE updated_at > '${sinceUpdatedAt}'` : ''

  const query = `
    INSERT INTO forska.articles
    SELECT
      id, created_at, updated_at, article_title,
      article_created_at, article_updated_at, article_id, article_summary,
      article_version, arxiv_id, doi, pubmed_id, url, content_hash,
      import_route, imported_by, publication_status, full_text,
      full_text_source, full_text_original_format, full_text_pdf,
      full_text_fetched_at, openalex_id, biorxiv_id, medrxiv_id,
      full_text_conversion_status, full_text_conversion_error,
      full_text_conversion_attempts, full_text_char_count,
      full_text_html, full_text_pdf_uploaded_by
    FROM postgresql(${pgConnStr})
    ${whereClause}
    ORDER BY updated_at
    LIMIT ${BATCH_SIZE}
    OFFSET ${offset}
  `

  await client.command({query})

  return BATCH_SIZE
}

export const syncArticlesToClickHouse = async (): Promise<SyncResult> => {
  const startTime = performance.now()

  console.log('[ArticleSync] Starting incremental sync...')

  const lastUpdatedAt = await getLastSyncedUpdatedAt()
  console.log(`[ArticleSync] Last synced updated_at: ${lastUpdatedAt ?? 'none (full sync)'}`)

  const totalPending = await countPendingArticles(lastUpdatedAt)
  console.log(`[ArticleSync] Found ${totalPending} articles to sync`)

  if (totalPending === 0) {
    return {syncedRows: 0, lastUpdatedAt, durationMs: performance.now() - startTime}
  }

  let totalSynced = 0
  let offset = 0

  while (offset < totalPending) {
    await syncArticlesBatch(lastUpdatedAt, offset)
    const batchSynced = Math.min(BATCH_SIZE, totalPending - offset)
    totalSynced += batchSynced
    offset += BATCH_SIZE
    console.log(`[ArticleSync] Synced ${totalSynced.toLocaleString()} / ${totalPending.toLocaleString()}`)
  }

  const durationMs = performance.now() - startTime
  const newLastUpdatedAt = await getLastSyncedUpdatedAt()

  console.log(`[ArticleSync] Completed! Synced ${totalSynced} rows in ${(durationMs / 1000).toFixed(1)}s`)
  console.log(`[ArticleSync] New max updated_at: ${newLastUpdatedAt}`)

  return {syncedRows: totalSynced, lastUpdatedAt: newLastUpdatedAt, durationMs}
}

const main = async () => {
  console.log('=== ClickHouse Articles Sync ===')
  console.log('')

  const result = await syncArticlesToClickHouse()

  console.log('')
  console.log('=== Summary ===')
  console.log(`Rows synced: ${result.syncedRows}`)
  console.log(`Duration: ${result.durationMs.toFixed(0)}ms`)
  console.log(`Last updated_at: ${result.lastUpdatedAt}`)

  process.exit(0)
}

main().catch((err) => {
  console.error('Sync failed:', err)
  process.exit(1)
})
