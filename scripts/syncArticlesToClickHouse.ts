/**
 * Incremental sync of articles from PostgreSQL to ClickHouse.
 *
 * Uses ReplacingMergeTree with updated_at as version column:
 * - New rows are inserted
 * - Updated rows overwrite older versions during merge
 *
 * Run manually: bun scripts/syncArticlesToClickHouse.ts
 * Or via cron: Add to Elysia cron for scheduled execution
 */
import {getClickhouseClient} from '../src/services/clickhouse/clickhouseClient.ts'

const BATCH_SIZE = 100000
const PG_CONN = {
  host: process.env['CLICKHOUSE_PG_HOST'] ?? 'db',
  port: process.env['CLICKHOUSE_PG_PORT'] ?? '5432',
  database: 'postgres',
  user: 'ch_replicator',
  password: 'ch_replicator_dev_pass',
}

type SyncResult = {
  syncedRows: number
  lastUpdatedAt: string | null
  durationMs: number
}

const getLastSyncedUpdatedAt = async (): Promise<string | null> => {
  const client = getClickhouseClient()
  const result = await client.query({
    query: 'SELECT max(updated_at) as max_updated_at FROM forska.articles',
    format: 'JSONEachRow',
  })
  const rows = await result.json<{max_updated_at: string | null}[]>()
  return rows[0]?.max_updated_at ?? null
}

const syncArticlesBatch = async (
  sinceUpdatedAt: string | null,
): Promise<number> => {
  const client = getClickhouseClient()
  const pgConnStr = `'${PG_CONN.host}:${PG_CONN.port}', '${PG_CONN.database}', 'articles', '${PG_CONN.user}', '${PG_CONN.password}'`

  const whereClause = sinceUpdatedAt
    ? `WHERE updated_at > '${sinceUpdatedAt}'`
    : ''

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
  `

  await client.command({query})

  const countResult = await client.query({
    query: `SELECT count() as cnt FROM postgresql(${pgConnStr}) ${whereClause}`,
    format: 'JSONEachRow',
  })
  const countRows = await countResult.json<{cnt: string}[]>()
  return parseInt(countRows[0]?.cnt ?? '0', 10)
}

export const syncArticlesToClickHouse = async (): Promise<SyncResult> => {
  const startTime = performance.now()

  console.log('[ArticleSync] Starting incremental sync...')

  const lastUpdatedAt = await getLastSyncedUpdatedAt()
  console.log(`[ArticleSync] Last synced updated_at: ${lastUpdatedAt ?? 'none (full sync)'}`)

  const syncedRows = await syncArticlesBatch(lastUpdatedAt)

  const durationMs = performance.now() - startTime
  const newLastUpdatedAt = await getLastSyncedUpdatedAt()

  console.log(`[ArticleSync] Synced ${syncedRows} rows in ${durationMs.toFixed(0)}ms`)
  console.log(`[ArticleSync] New max updated_at: ${newLastUpdatedAt}`)

  return {
    syncedRows,
    lastUpdatedAt: newLastUpdatedAt,
    durationMs,
  }
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
