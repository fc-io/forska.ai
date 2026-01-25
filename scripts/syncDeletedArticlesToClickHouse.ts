import {getClickhouseClient} from '../src/services/clickhouse/clickhouseClient.ts'
import {ensureClickhouseArticlesTable} from '../src/services/clickhouse/ensureClickhouseArticlesTable.ts'

const SCAN_BATCH_SIZE = 10_000
const MIN_LAST_ID = '' as const

const PG_CONN = {
  host: process.env['CLICKHOUSE_PG_HOST'] ?? 'db',
  port: process.env['CLICKHOUSE_PG_PORT'] ?? '5432',
  database: 'postgres',
  user: 'ch_replicator',
  password: 'ch_replicator_dev_pass',
}

type SyncDeletedArticlesResult = {
  scannedIds: number
  scannedBatches: number
  orphanIdsFound: number
  deleteCommandsIssued: number
  durationMs: number
  lastScannedId: string | null
}

type SyncDeletedArticlesConfig = {
  batchSize: number
  maxBatches: number
}

const asRowsArray = <T>(rows: T | T[]): T[] => {
  return Array.isArray(rows) ? rows : [rows]
}

const getPgConnStr = () => {
  return `'${PG_CONN.host}:${PG_CONN.port}', '${PG_CONN.database}', 'articles', '${PG_CONN.user}', '${PG_CONN.password}'`
}

const getClickhouseArticleIdsBatch = async (lastId: string, batchSize: number): Promise<string[]> => {
  const client = getClickhouseClient()
  const result = await client.query({
    query: `
      SELECT id
      FROM forska.articles
      WHERE id > {lastId:String}
      ORDER BY id ASC
      LIMIT {batchSize:UInt32}
    `,
    format: 'JSONEachRow',
    query_params: {lastId, batchSize},
  })
  const rows = await result.json<{id: string}>()
  return asRowsArray(rows)
    .map((row) => row.id)
    .filter((id): id is string => Boolean(id))
}

const getPostgresIdsForBatch = async (ids: string[]): Promise<Set<string>> => {
  const client = getClickhouseClient()
  const pgConnStr = getPgConnStr()
  const result = await client.query({
    query: `
      SELECT toString(id) as id
      FROM postgresql(${pgConnStr})
      WHERE toString(id) IN ({ids:Array(String)})
    `,
    format: 'JSONEachRow',
    query_params: {ids},
  })
  const rows = await result.json<{id: string}>()
  return new Set(asRowsArray(rows).map((row) => row.id))
}

const getOrphanIds = (ids: string[], pgIdSet: Set<string>): string[] => {
  return ids.filter((id) => {
    return !pgIdSet.has(id)
  })
}

const deleteOrphanIds = async (ids: string[]): Promise<void> => {
  const client = getClickhouseClient()
  await client.command({
    query: 'ALTER TABLE forska.articles DELETE WHERE id IN ({ids:Array(String)})',
    query_params: {ids},
  })
}

const deleteOrphanIdsIfAny = async (ids: string[]): Promise<{deleted: number; issued: number}> => {
  const deleted = ids.length
  const issued = deleted > 0 ? 1 : 0

  await (deleted > 0 ? deleteOrphanIds(ids) : Promise.resolve())

  return {deleted, issued}
}

const getLastIdFromBatch = (ids: string[], fallback: string): string => {
  return ids.length > 0 ? ids[ids.length - 1]! : fallback
}

const nextStats = (
  stats: Omit<SyncDeletedArticlesResult, 'durationMs'>,
  input: {scannedIds: number; orphanIds: number; deleteCommandsIssued: number; lastScannedId: string},
) => {
  return {
    scannedIds: stats.scannedIds + input.scannedIds,
    scannedBatches: stats.scannedBatches + 1,
    orphanIdsFound: stats.orphanIdsFound + input.orphanIds,
    deleteCommandsIssued: stats.deleteCommandsIssued + input.deleteCommandsIssued,
    lastScannedId: input.lastScannedId,
  }
}

const scanNonEmptyBatch = async (
  config: SyncDeletedArticlesConfig,
  batchIds: string[],
  lastId: string,
  batchNumber: number,
  stats: Omit<SyncDeletedArticlesResult, 'durationMs'>,
): Promise<Omit<SyncDeletedArticlesResult, 'durationMs'>> => {
  const uniqueIds = Array.from(new Set(batchIds))
  const pgIds = await getPostgresIdsForBatch(uniqueIds)
  const orphanIds = getOrphanIds(uniqueIds, pgIds)
  const deleted = await deleteOrphanIdsIfAny(orphanIds)
  const nextLastId = getLastIdFromBatch(batchIds, lastId)

  console.log(
    `[CH Article Deletes] Batch ${batchNumber}: scanned ${uniqueIds.length.toLocaleString()}, orphans ${orphanIds.length.toLocaleString()}, lastId ${nextLastId}`,
  )

  return scanRecursive(
    config,
    nextLastId,
    batchNumber + 1,
    nextStats(stats, {
      scannedIds: uniqueIds.length,
      orphanIds: orphanIds.length,
      deleteCommandsIssued: deleted.issued,
      lastScannedId: nextLastId,
    }),
  )
}

const scanRecursive = async (
  config: SyncDeletedArticlesConfig,
  lastId: string,
  batchNumber: number,
  stats: Omit<SyncDeletedArticlesResult, 'durationMs'>,
): Promise<Omit<SyncDeletedArticlesResult, 'durationMs'>> => {
  const hitLimit = batchNumber > config.maxBatches
  const batchIds = hitLimit ? [] : await getClickhouseArticleIdsBatch(lastId, config.batchSize)
  return batchIds.length === 0 ? stats : scanNonEmptyBatch(config, batchIds, lastId, batchNumber, stats)
}

export const syncDeletedArticlesToClickHouse = async (options?: {
  batchSize?: number
  maxBatches?: number
}): Promise<SyncDeletedArticlesResult> => {
  const startTime = performance.now()
  const batchSize = options?.batchSize ?? SCAN_BATCH_SIZE
  const maxBatches = options?.maxBatches ?? Number.POSITIVE_INFINITY

  await ensureClickhouseArticlesTable()

  const scanned = await scanRecursive({batchSize, maxBatches}, MIN_LAST_ID, 1, {
    scannedIds: 0,
    scannedBatches: 0,
    orphanIdsFound: 0,
    deleteCommandsIssued: 0,
    lastScannedId: null,
  })

  return {...scanned, durationMs: performance.now() - startTime}
}

const main = async () => {
  const result = await syncDeletedArticlesToClickHouse()
  console.log(
    `[CH Article Deletes] Done: scanned=${result.scannedIds.toLocaleString()} orphans=${result.orphanIdsFound.toLocaleString()} deletes=${result.deleteCommandsIssued.toLocaleString()} duration=${(result.durationMs / 1000).toFixed(1)}s`,
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[CH Article Deletes] Failed:', error)
    process.exit(1)
  })
}
