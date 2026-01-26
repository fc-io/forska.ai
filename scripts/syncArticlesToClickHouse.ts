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
import {ensureClickhouseArticlesTable} from '../src/services/clickhouse/ensureClickhouseArticlesTable.ts'

const BATCH_SIZE = 5000
const MIN_WATERMARK = {updatedAt: '1970-01-01 00:00:00.000000', id: '00000000-0000-0000-0000-000000000000'} as const

const PG_CONN = {
  host: process.env['CLICKHOUSE_PG_HOST'] ?? 'db',
  port: process.env['CLICKHOUSE_PG_PORT'] ?? '5432',
  database: 'postgres',
  user: 'ch_replicator',
  password: 'ch_replicator_dev_pass',
}

type SyncResult = {syncedRows: number; lastUpdatedAt: string | null; durationMs: number}
type MonthKey = {year: number; month: number}
type StatsBackfillInput = {months: MonthKey[]; rebuild: boolean}
type StatsBackfillResult = {months: number; durationMs: number}

const parseClickhouseCount = (value: unknown): bigint => {
  if (typeof value === 'string') return BigInt(value || '0')
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  return typeof value === 'bigint' ? value : 0n
}

const getClickhouseArticlesRowCount = async (): Promise<bigint> => {
  const client = getClickhouseClient()
  const result = await client.query({query: 'SELECT count() as cnt FROM forska.articles', format: 'JSONEachRow'})
  const rows = await result.json<{cnt: string | number}>()
  const firstRow = Array.isArray(rows) ? rows[0] : rows
  return parseClickhouseCount(firstRow?.cnt ?? '0')
}

const getLastSyncedWatermark = async (): Promise<{updatedAt: string; id: string}> => {
  const client = getClickhouseClient()
  const result = await client.query({
    query: `
      SELECT
        toString(tupleElement(maxOrNull(tuple(updated_at, toString(id))), 1)) as updatedAt,
        tupleElement(maxOrNull(tuple(updated_at, toString(id))), 2) as id
      FROM forska.articles
    `,
    format: 'JSONEachRow',
  })
  const rows = await result.json<{updatedAt: string | null; id: string | null}>()
  const firstRow = Array.isArray(rows) ? rows[0] : rows
  const updatedAt = firstRow?.updatedAt ?? null
  const id = firstRow?.id ?? null
  return updatedAt && id ? {updatedAt, id} : {...MIN_WATERMARK}
}

const getBatchBoundaries = async (watermark: {
  updatedAt: string
  id: string
}): Promise<{batchCount: number; lastUpdatedAt: string | null; lastId: string | null}> => {
  const client = getClickhouseClient()
  const pgConnStr = `'${PG_CONN.host}:${PG_CONN.port}', '${PG_CONN.database}', 'articles', '${PG_CONN.user}', '${PG_CONN.password}'`

  const query = `
    WITH batch AS (
      SELECT
        updated_at,
        toString(id) as id
      FROM postgresql(${pgConnStr})
      WHERE (updated_at, toString(id)) > ({watermarkUpdatedAt:DateTime64(6, 'UTC')}, {watermarkId:String})
      ORDER BY updated_at ASC, id ASC
      LIMIT {batchSize:UInt32}
    )
    SELECT
      count() as batchCount,
      toString(tupleElement(maxOrNull(tuple(updated_at, id)), 1)) as lastUpdatedAt,
      tupleElement(maxOrNull(tuple(updated_at, id)), 2) as lastId
    FROM batch
  `

  const result = await client.query({
    query,
    format: 'JSONEachRow',
    query_params: {watermarkUpdatedAt: watermark.updatedAt, watermarkId: watermark.id, batchSize: BATCH_SIZE},
  })

  const rows = await result.json<{batchCount: string | number; lastUpdatedAt: string | null; lastId: string | null}>()
  const firstRow = Array.isArray(rows) ? rows[0] : rows
  const batchCount = parseInt(String(firstRow?.batchCount ?? '0'), 10)
  return {batchCount, lastUpdatedAt: firstRow?.lastUpdatedAt ?? null, lastId: firstRow?.lastId ?? null}
}

const syncArticlesBatch = async (
  watermark: {updatedAt: string; id: string},
  last: {updatedAt: string; id: string},
): Promise<void> => {
  const client = getClickhouseClient()
  const pgConnStr = `'${PG_CONN.host}:${PG_CONN.port}', '${PG_CONN.database}', 'articles', '${PG_CONN.user}', '${PG_CONN.password}'`

  const query = `
    INSERT INTO forska.articles
    SELECT
      toString(id) as id, created_at, updated_at, article_title,
      article_created_at, article_updated_at, article_id, article_summary,
      article_version, arxiv_id, doi, pubmed_id, url, content_hash,
      import_route, imported_by, publication_status, full_text,
      full_text_source, full_text_original_format, full_text_pdf,
      full_text_fetched_at, openalex_id, biorxiv_id, medrxiv_id,
      full_text_conversion_status, full_text_conversion_error,
      full_text_conversion_attempts, full_text_char_count,
      full_text_html, full_text_pdf_uploaded_by
    FROM postgresql(${pgConnStr})
    WHERE (updated_at, toString(id)) > ({watermarkUpdatedAt:DateTime64(6, 'UTC')}, {watermarkId:String})
      AND (updated_at, toString(id)) <= ({lastUpdatedAt:DateTime64(6, 'UTC')}, {lastId:String})
    ORDER BY updated_at ASC, id ASC
  `

  await client.command({
    query,
    query_params: {
      watermarkUpdatedAt: watermark.updatedAt,
      watermarkId: watermark.id,
      lastUpdatedAt: last.updatedAt,
      lastId: last.id,
    },
  })
}

export const syncArticlesToClickHouse = async (): Promise<SyncResult> => {
  const startTime = performance.now()

  console.log('[ArticleSync] Starting incremental sync...')

  await ensureClickhouseArticlesTable()

  const startRowCount = await getClickhouseArticlesRowCount()
  const startWatermark = await getLastSyncedWatermark()
  console.log(`[ArticleSync] Starting watermark: ${startWatermark.updatedAt}, ${startWatermark.id}`)

  const syncRecursive = async (watermark: {updatedAt: string; id: string}, batchNumber: number): Promise<void> => {
    const batch = await getBatchBoundaries(watermark)

    if (batch.batchCount === 0 || !batch.lastUpdatedAt || !batch.lastId) {
      return
    }

    await syncArticlesBatch(watermark, {updatedAt: batch.lastUpdatedAt, id: batch.lastId})
    console.log(
      `[ArticleSync] Batch ${batchNumber}: inserted ~${batch.batchCount.toLocaleString()} (up to ${batch.lastUpdatedAt}, ${batch.lastId})`,
    )

    return syncRecursive({updatedAt: batch.lastUpdatedAt, id: batch.lastId}, batchNumber + 1)
  }

  await syncRecursive(startWatermark, 1)

  const durationMs = performance.now() - startTime
  const endRowCount = await getClickhouseArticlesRowCount()
  const endWatermark = await getLastSyncedWatermark()
  const inserted = endRowCount > startRowCount ? endRowCount - startRowCount : 0n

  console.log(`[ArticleSync] Completed! Inserted ${inserted.toString()} rows in ${(durationMs / 1000).toFixed(1)}s`)
  console.log(`[ArticleSync] New watermark: ${endWatermark.updatedAt}, ${endWatermark.id}`)

  return {syncedRows: Number(inserted), lastUpdatedAt: endWatermark.updatedAt, durationMs}
}

const getArgValue = (args: string[], prefix: string): string | null => {
  const match = args.find((arg) => {
    return arg.startsWith(prefix)
  })
  return match ? match.slice(prefix.length) : null
}

const parseMonthKey = (value: string | null): MonthKey | null => {
  const match = value ? value.match(/^(\d{4})-(\d{2})$/) : null
  const year = match ? Number(match[1]) : NaN
  const month = match ? Number(match[2]) : NaN
  const isValid = Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12
  return isValid ? {year, month} : null
}

const formatMonthKey = (month: MonthKey): string => {
  const monthLabel = String(month.month).padStart(2, '0')
  return `${month.year}-${monthLabel}`
}

const monthKeyToPartition = (month: MonthKey): number => {
  return month.year * 100 + month.month
}

const addMonth = (month: MonthKey): MonthKey => {
  const base = new Date(Date.UTC(month.year, month.month - 1, 1))
  const next = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1))
  return {year: next.getUTCFullYear(), month: next.getUTCMonth() + 1}
}

const isAfterMonth = (left: MonthKey, right: MonthKey): boolean => {
  return left.year > right.year || (left.year === right.year && left.month > right.month)
}

const buildMonthRange = (start: MonthKey, end: MonthKey): MonthKey[] => {
  const done = isAfterMonth(start, end)
  const next = addMonth(start)
  const rest = done ? [] : buildMonthRange(next, end)
  return done ? [] : [start, ...rest]
}

const parseMonthList = (value: string | null): MonthKey[] | null => {
  const raw = value ? value.split(',') : []
  const trimmed = raw
    .map((entry) => {
      return entry.trim()
    })
    .filter((entry) => {
      return entry.length > 0
    })
  const parsed = trimmed.map((entry) => {
    return parseMonthKey(entry)
  })
  const valid = parsed.filter((entry): entry is MonthKey => {
    return Boolean(entry)
  })
  const isValid = trimmed.length > 0 && valid.length === trimmed.length
  return isValid ? valid : null
}

const parseStatsBackfillInput = (args: string[]): StatsBackfillInput | null => {
  const monthsArg = getArgValue(args, '--months=')
  const fromArg = getArgValue(args, '--from=')
  const toArg = getArgValue(args, '--to=')
  const rebuild = args.includes('--rebuild')
  const monthsFromList = monthsArg ? parseMonthList(monthsArg) : null
  const fromMonth = monthsArg ? null : parseMonthKey(fromArg)
  const toMonth = monthsArg ? null : parseMonthKey(toArg)
  const range = fromMonth && toMonth && !isAfterMonth(fromMonth, toMonth) ? buildMonthRange(fromMonth, toMonth) : null
  const months = monthsFromList ?? range
  const monthList = months ?? []
  const isValid = monthList.length > 0
  return isValid ? {months: monthList, rebuild} : null
}

const formatMonthStart = (month: MonthKey): string => {
  return `${formatMonthKey(month)}-01 00:00:00.000000`
}

const dropArticlesStatsPartition = async (month: MonthKey): Promise<void> => {
  const client = getClickhouseClient()
  await client.command({
    query: 'ALTER TABLE forska.articles_stats DROP PARTITION IF EXISTS {month:UInt32}',
    query_params: {month: monthKeyToPartition(month)},
  })
}

const insertArticlesStatsForMonth = async (month: MonthKey): Promise<void> => {
  const client = getClickhouseClient()
  const start = formatMonthStart(month)
  const next = formatMonthStart(addMonth(month))
  await client.command({
    query: `
      INSERT INTO forska.articles_stats
      SELECT
        {month:UInt32} as month,
        uniqCombined64State(cityHash64(id)) as uniqueCount,
        maxState(updated_at) as maxUpdatedAt
      FROM forska.articles
      WHERE created_at >= {start:DateTime64(6, 'UTC')}
        AND created_at < {end:DateTime64(6, 'UTC')}
    `,
    query_params: {month: monthKeyToPartition(month), start, end: next},
  })
}

const backfillArticlesStatsMonth = async (month: MonthKey, rebuild: boolean): Promise<void> => {
  const drop = rebuild ? dropArticlesStatsPartition(month) : Promise.resolve()
  await drop
  await insertArticlesStatsForMonth(month)
  console.log(`[ArticleStats] Backfilled ${formatMonthKey(month)}${rebuild ? ' (rebuild)' : ''}`)
}

const backfillArticlesStatsRecursive = async (input: {
  months: MonthKey[]
  index: number
  rebuild: boolean
}): Promise<void> => {
  const current = input.months[input.index]
  const hasCurrent = Boolean(current)
  if (current) {
    await backfillArticlesStatsMonth(current, input.rebuild)
  }
  const nextInput = {months: input.months, index: input.index + 1, rebuild: input.rebuild}
  const nextResult = hasCurrent ? await backfillArticlesStatsRecursive(nextInput) : undefined
  return nextResult
}

const backfillArticlesStats = async (input: StatsBackfillInput): Promise<StatsBackfillResult> => {
  const startTime = performance.now()
  await ensureClickhouseArticlesTable()
  await backfillArticlesStatsRecursive({months: input.months, index: 0, rebuild: input.rebuild})
  const durationMs = performance.now() - startTime
  return {months: input.months.length, durationMs}
}

const logBackfillUsage = (): void => {
  console.log('Usage: bun scripts/syncArticlesToClickHouse.ts --backfill-stats --from=YYYY-MM --to=YYYY-MM [--rebuild]')
  console.log('   or: bun scripts/syncArticlesToClickHouse.ts --backfill-stats --months=YYYY-MM,YYYY-MM [--rebuild]')
}

const logBackfillStart = (input: StatsBackfillInput): void => {
  console.log('=== ClickHouse Articles Stats Backfill ===')
  console.log(`Months: ${input.months.map(formatMonthKey).join(', ')}`)
  console.log(`Rebuild: ${input.rebuild ? 'yes' : 'no'}`)
}

const logBackfillSummary = (result: StatsBackfillResult): void => {
  console.log('')
  console.log('=== Summary ===')
  console.log(`Months processed: ${result.months}`)
  console.log(`Duration: ${result.durationMs.toFixed(0)}ms`)
}

const runSync = async (): Promise<boolean> => {
  console.log('=== ClickHouse Articles Sync ===')
  console.log('')
  const result = await syncArticlesToClickHouse()
  console.log('')
  console.log('=== Summary ===')
  console.log(`Rows synced: ${result.syncedRows}`)
  console.log(`Duration: ${result.durationMs.toFixed(0)}ms`)
  console.log(`Last updated_at: ${result.lastUpdatedAt}`)
  return true
}

const runStatsBackfill = async (args: string[]): Promise<boolean> => {
  const input = parseStatsBackfillInput(args)
  if (input) {
    logBackfillStart(input)
  }
  const result = input ? await backfillArticlesStats(input) : null
  if (result) {
    logBackfillSummary(result)
  }
  if (!input) {
    logBackfillUsage()
  }
  return Boolean(result)
}

const main = async () => {
  const args = process.argv.slice(2)
  const isBackfill = args.includes('--backfill-stats')
  const success = isBackfill ? await runStatsBackfill(args) : await runSync()
  process.exit(success ? 0 : 1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Sync failed:', err)
    process.exit(1)
  })
}
