import {and, count, gt, isNull, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'
import {Client} from 'pg'

import {articles, judgments} from '../../db/schema.ts'
import {getClickhouseClient, pingClickhouse} from '../../services/clickhouse/clickhouseClient.ts'
import {ensureClickhouseSchema} from '../../services/clickhouse/ensureClickhouseSchema.ts'
import {rebuildClickhouseJudgmentsDerivedTable} from '../../services/clickhouse/rebuildClickhouseJudgmentsDerivedTable.ts'
import {requireUserAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return parseInt(value, 10) || 0
  return typeof value === 'bigint' ? Number(value) : 0
}

const toMsOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return value instanceof Date ? value.getTime() : null
}

const STATS_STATEMENT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_REASONABLE_FUTURE_MS = 1000 * 60 * 60 * 24 * 365 * 20

const normalizeEpochMsWithin = (value: number, maxReasonableMs: number): number => {
  return value > maxReasonableMs ? normalizeEpochMsWithin(Math.trunc(value / 1000), maxReasonableMs) : value
}

const normalizeEpochMs = (value: number | null): number | null => {
  const maxReasonableMs = Date.now() + MAX_REASONABLE_FUTURE_MS
  return value === null ? null : normalizeEpochMsWithin(value, maxReasonableMs)
}

type CountType = 'exact' | 'estimated'

const getPeerdbMirrorName = (): string => {
  const raw = String(process.env['PEERDB_MIRROR_NAME'] ?? '').trim()
  return raw ? raw : 'forska_pg_to_ch_cdc'
}

const getPeerdbConnectionConfig = () => {
  const catalogHostRaw = String(process.env['PEERDB_CATALOG_HOST'] ?? '').trim()
  const catalogHost = catalogHostRaw && catalogHostRaw !== 'peerdb-catalog' ? catalogHostRaw : ''
  const hostRaw = String(process.env['PEERDB_HOST'] ?? '').trim()
  const host = catalogHost || hostRaw || 'localhost'
  const isLocalhost = host === 'localhost' || host === '127.0.0.1'
  const portFromEnv = toNumber(process.env['PEERDB_PORT'] ?? '')
  const portFromCatalog = toNumber(process.env['PEERDB_CATALOG_PORT'] ?? '')
  const port = portFromEnv || (isLocalhost ? 9901 : portFromCatalog || 5432)
  const user =
    String(process.env['PEERDB_CATALOG_USER'] ?? process.env['PEERDB_USER'] ?? 'postgres').trim() || 'postgres'
  const password = String(process.env['PEERDB_CATALOG_PASSWORD'] ?? process.env['PEERDB_PASSWORD'] ?? 'postgres')
  const database =
    String(process.env['PEERDB_CATALOG_DATABASE'] ?? process.env['PEERDB_DATABASE'] ?? user).trim() || user
  return {host, port, user, password, database}
}

const getPeerdbErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
  return message
}

const getPeerdbErrorCode = (error: unknown): string | null => {
  const codeValue =
    typeof error === 'object' && error !== null && 'code' in error ? (error as {code?: unknown}).code : null
  const code =
    typeof codeValue === 'string' || typeof codeValue === 'number' || typeof codeValue === 'bigint'
      ? String(codeValue)
      : ''
  return code || null
}

const logPeerdbError = (label: string, error: unknown): void => {
  const message = getPeerdbErrorMessage(error)
  const code = getPeerdbErrorCode(error)
  const suffix = code ? ` (code: ${code})` : ''
  console.error(`[PeerDB] ${label}: ${message}${suffix}`)
}

const handlePeerdbClientError = (error: unknown): void => {
  logPeerdbError('Client error', error)
}

const attachPeerdbClientErrorHandler = (client: Client): void => {
  client.on('error', handlePeerdbClientError)
}

const getPeerdbMirrorHealth = async (): Promise<{
  mirrorName: string
  reachable: boolean
  exists: boolean
  status: 'running' | 'missing' | 'unreachable'
}> => {
  const mirrorName = getPeerdbMirrorName()
  const cfg = getPeerdbConnectionConfig()
  const client = new Client({...cfg, connectionTimeoutMillis: 2000})
  attachPeerdbClientErrorHandler(client)

  try {
    await client.connect()
    const existsResult = await client.query<{exists: true}>(
      'SELECT true AS exists FROM flows WHERE name = $1 LIMIT 1',
      [mirrorName],
    )
    const exists = Boolean(existsResult.rowCount)
    await client.end()
    return {mirrorName, reachable: true, exists, status: exists ? 'running' : 'missing'}
  } catch (error) {
    logPeerdbError('Health check failed', error)
    await client.end().catch(() => {})
    return {mirrorName, reachable: false, exists: false, status: 'unreachable'}
  }
}

const getPeerdbSlotName = (): string => {
  const raw = String(process.env['PEERDB_SLOT'] ?? '').trim()
  return raw ? raw : `peerflow_slot_${getPeerdbMirrorName().replaceAll(/[^a-zA-Z0-9_]/g, '_')}`
}

type PostgresSlotRow = {slot_name: string; active: boolean; retained_bytes: string | null}

const getPostgresSlotHealth = async (): Promise<{
  slotName: string
  exists: boolean
  active: boolean | null
  retainedBytes: string | null
}> => {
  const slotName = getPeerdbSlotName()
  const db = getDatabase()

  try {
    const result = await db.execute<PostgresSlotRow>(sql`
      SELECT
        slot_name,
        active,
        pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::text as retained_bytes
      FROM pg_replication_slots
      WHERE slot_type = 'logical' AND slot_name = ${slotName}
      LIMIT 1
    `)

    const row = result.rows[0]
    return row
      ? {slotName: row.slot_name, exists: true, active: row.active, retainedBytes: row.retained_bytes}
      : {slotName, exists: false, active: null, retainedBytes: null}
  } catch (error) {
    console.error('[PG] Slot health query failed:', error)
    return {slotName, exists: false, active: null, retainedBytes: null}
  }
}

const getPgTableStats = async (
  table: 'articles' | 'judgments',
): Promise<{count: number; maxUpdatedAtMs: number | null}> => {
  const db = getDatabase()

  const where = table === 'judgments' ? sql`WHERE deleted_at IS NULL` : sql``
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATS_STATEMENT_TIMEOUT_MS}`))
    return tx.execute<{count: string | number; max_updated_at_ms: string | number | null}>(sql`
      SELECT
        COUNT(*)::text AS count,
        (EXTRACT(EPOCH FROM MAX(updated_at)) * 1000)::bigint::text AS max_updated_at_ms
      FROM ${sql.identifier(table)} ${where}
    `)
  })

  const row = result.rows[0]
  return row
    ? {count: toNumber(row.count), maxUpdatedAtMs: toMsOrNull(row.max_updated_at_ms)}
    : {count: 0, maxUpdatedAtMs: null}
}

const getPgArticlesFastStats = async (): Promise<{
  count: number
  countType: CountType
  maxUpdatedAtMs: number | null
}> => {
  const db = getDatabase()

  const {countRow, maxRow} = await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATS_STATEMENT_TIMEOUT_MS}`))

    const [countResult, maxResult] = await Promise.all([
      tx.execute<{count: string | number}>(sql`
        SELECT reltuples::bigint::text AS count
        FROM pg_class
        WHERE oid = 'public.articles'::regclass
      `),
      tx.execute<{max_updated_at_ms: string | number | null}>(sql`
        SELECT (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint::text AS max_updated_at_ms
        FROM articles
        ORDER BY updated_at DESC
        LIMIT 1
      `),
    ])

    return {countRow: countResult.rows[0], maxRow: maxResult.rows[0]}
  })

  const count = toNumber(countRow?.count)
  const maxUpdatedAtMs = toMsOrNull(maxRow?.max_updated_at_ms ?? null)

  return {count, countType: 'estimated', maxUpdatedAtMs}
}

type ClickhouseTableStats = {
  totalCount: number
  maxUpdatedAtMs: number | null
  liveCount: number
  liveMaxUpdatedAtMs: number | null
  dedupDrift: number
}

type ClickhouseIngestionStats = {maxPeerdbSyncedAtMs: number | null; maxUpdatedAtMs: number | null}

const getClickhouseEngineForTable = async (name: string): Promise<string | null> => {
  const client = getClickhouseClient()
  const result = await client.query({
    query: `
      SELECT engine
      FROM system.tables
      WHERE database = 'forska' AND name = {name:String}
      LIMIT 1
    `,
    query_params: {name},
    format: 'JSONEachRow',
  })
  const rows = await result.json<{engine?: string}>()
  const row = Array.isArray(rows) ? rows[0] : rows
  const engine = row?.engine
  return typeof engine === 'string' ? engine : null
}

const buildMaxUpdatedAtMsExprForColumn = (column: string): string => {
  return `max(if(toYear(${column}) = 2299, intDiv(toUnixTimestamp64Milli(${column}), 1000), toUnixTimestamp64Milli(${column})))`
}

const toDriftStatus = (diff: number): 'synced' | 'raw_ahead' | 'derived_ahead' => {
  return diff === 0 ? 'synced' : diff > 0 ? 'derived_ahead' : 'raw_ahead'
}

const getClickhouseJudgmentsDerivedHealth = async () => {
  const client = getClickhouseClient()
  const windowHours = 24
  const windowStartExpr = `now64(3) - INTERVAL ${windowHours} HOUR`
  const rawMaxUpdatedAtMsExpr = buildMaxUpdatedAtMsExprForColumn('updated_at')
  const derivedMaxUpdatedAtMsExpr = buildMaxUpdatedAtMsExprForColumn('updatedAt')

  const [rawStatsResult, derivedStatsResult, titleStatsResult, importRouteStatsResult, missingDerivedRecentResult] =
    await Promise.all([
      client.query({
        query: `
        SELECT
          count() as liveCount,
          if(count() = 0, NULL, ${rawMaxUpdatedAtMsExpr}) as maxUpdatedAtMs,
          countIf(updated_at >= ${windowStartExpr}) as recentLiveCount,
          if(countIf(updated_at >= ${windowStartExpr}) = 0, NULL,
            maxIf(
              if(toYear(updated_at) = 2299, intDiv(toUnixTimestamp64Milli(updated_at), 1000), toUnixTimestamp64Milli(updated_at)),
              updated_at >= ${windowStartExpr}
            )
          ) as recentMaxUpdatedAtMs
        FROM forska.judgments_raw FINAL
        WHERE _peerdb_is_deleted = 0 AND deleted_at IS NULL
      `,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `
        SELECT
          count() as liveCount,
          if(count() = 0, NULL, ${derivedMaxUpdatedAtMsExpr}) as maxUpdatedAtMs,
          countIf(updatedAt >= ${windowStartExpr}) as recentLiveCount,
          if(countIf(updatedAt >= ${windowStartExpr}) = 0, NULL,
            maxIf(
              if(toYear(updatedAt) = 2299, intDiv(toUnixTimestamp64Milli(updatedAt), 1000), toUnixTimestamp64Milli(updatedAt)),
              updatedAt >= ${windowStartExpr}
            )
          ) as recentMaxUpdatedAtMs,
          countIf(articleTitle = '') as missingTitle,
          countIf(articleTitle = '' AND updatedAt >= ${windowStartExpr}) as recentMissingTitle,
          countIf(isNull(articleImportRoute)) as missingImportRoute,
          countIf(isNull(articleImportRoute) AND updatedAt >= ${windowStartExpr}) as recentMissingImportRoute
        FROM forska.judgments FINAL
        WHERE _peerdb_is_deleted = 0
      `,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `
        SELECT
          ${windowHours} as windowHours,
          count() as missingTitle,
          countIf(a.id IS NULL) as missingArticleInClickhouse,
          countIf(a.id IS NOT NULL AND a.article_title != '') as staleMissingTitle,
          countIf(a.id IS NOT NULL AND a.article_title = '') as emptyTitleInArticles,
          countIf(j.updatedAt >= ${windowStartExpr}) as recentMissingTitle,
          countIf(j.updatedAt >= ${windowStartExpr} AND a.id IS NULL) as recentMissingArticleInClickhouse,
          countIf(j.updatedAt >= ${windowStartExpr} AND a.id IS NOT NULL AND a.article_title != '') as recentStaleMissingTitle,
          countIf(j.updatedAt >= ${windowStartExpr} AND a.id IS NOT NULL AND a.article_title = '') as recentEmptyTitleInArticles
        FROM (
          SELECT articleId, updatedAt
          FROM forska.judgments FINAL
          WHERE _peerdb_is_deleted = 0 AND articleTitle = ''
        ) j
        LEFT JOIN (
          SELECT id, article_title
          FROM forska.articles FINAL
          WHERE _peerdb_is_deleted = 0
        ) a ON j.articleId = a.id
      `,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `
        SELECT
          ${windowHours} as windowHours,
          count() as missingImportRoute,
          countIf(a.id IS NULL) as missingArticleInClickhouse,
          countIf(a.id IS NOT NULL AND isNotNull(a.import_route)) as staleMissingImportRoute,
          countIf(a.id IS NOT NULL AND isNull(a.import_route)) as bothNullImportRoute,
          countIf(j.updatedAt >= ${windowStartExpr}) as recentMissingImportRoute,
          countIf(j.updatedAt >= ${windowStartExpr} AND a.id IS NULL) as recentMissingArticleInClickhouse,
          countIf(j.updatedAt >= ${windowStartExpr} AND a.id IS NOT NULL AND isNotNull(a.import_route)) as recentStaleMissingImportRoute,
          countIf(j.updatedAt >= ${windowStartExpr} AND a.id IS NOT NULL AND isNull(a.import_route)) as recentBothNullImportRoute
        FROM (
          SELECT articleId, updatedAt
          FROM forska.judgments FINAL
          WHERE _peerdb_is_deleted = 0 AND isNull(articleImportRoute)
        ) j
        LEFT JOIN (
          SELECT id, import_route
          FROM forska.articles FINAL
          WHERE _peerdb_is_deleted = 0
        ) a ON j.articleId = a.id
      `,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `
        SELECT count() as missingDerived
        FROM (
          SELECT id
          FROM forska.judgments_raw FINAL
          WHERE _peerdb_is_deleted = 0
            AND deleted_at IS NULL
            AND updated_at >= ${windowStartExpr}
        ) r
        LEFT ANTI JOIN (
          SELECT id
          FROM forska.judgments FINAL
          WHERE _peerdb_is_deleted = 0
        ) d USING (id)
      `,
        format: 'JSONEachRow',
      }),
    ])

  const rawStatsRows = await rawStatsResult.json<{
    liveCount: string | number
    maxUpdatedAtMs: string | number | null
    recentLiveCount: string | number
    recentMaxUpdatedAtMs: string | number | null
  }>()
  const derivedStatsRows = await derivedStatsResult.json<{
    liveCount: string | number
    maxUpdatedAtMs: string | number | null
    recentLiveCount: string | number
    recentMaxUpdatedAtMs: string | number | null
    missingTitle: string | number
    recentMissingTitle: string | number
    missingImportRoute: string | number
    recentMissingImportRoute: string | number
  }>()
  const titleStatsRows = await titleStatsResult.json<{
    windowHours: string | number
    missingTitle: string | number
    missingArticleInClickhouse: string | number
    staleMissingTitle: string | number
    emptyTitleInArticles: string | number
    recentMissingTitle: string | number
    recentMissingArticleInClickhouse: string | number
    recentStaleMissingTitle: string | number
    recentEmptyTitleInArticles: string | number
  }>()
  const importRouteStatsRows = await importRouteStatsResult.json<{
    windowHours: string | number
    missingImportRoute: string | number
    missingArticleInClickhouse: string | number
    staleMissingImportRoute: string | number
    bothNullImportRoute: string | number
    recentMissingImportRoute: string | number
    recentMissingArticleInClickhouse: string | number
    recentStaleMissingImportRoute: string | number
    recentBothNullImportRoute: string | number
  }>()
  const missingDerivedRows = await missingDerivedRecentResult.json<{missingDerived: string | number}>()

  const rawStats = Array.isArray(rawStatsRows) ? rawStatsRows[0] : rawStatsRows
  const derivedStats = Array.isArray(derivedStatsRows) ? derivedStatsRows[0] : derivedStatsRows
  const titleStats = Array.isArray(titleStatsRows) ? titleStatsRows[0] : titleStatsRows
  const importRouteStats = Array.isArray(importRouteStatsRows) ? importRouteStatsRows[0] : importRouteStatsRows
  const missingDerived = Array.isArray(missingDerivedRows) ? missingDerivedRows[0] : missingDerivedRows

  const derivedLiveCount = toNumber(derivedStats?.liveCount)
  const rawLiveCount = toNumber(rawStats?.liveCount)
  const liveCountDiff = derivedLiveCount - rawLiveCount

  const derivedRecentLiveCount = toNumber(derivedStats?.recentLiveCount)
  const rawRecentLiveCount = toNumber(rawStats?.recentLiveCount)
  const recentLiveCountDiff = derivedRecentLiveCount - rawRecentLiveCount

  const mvEngine = await getClickhouseEngineForTable('judgments_mv')

  return {
    mv: {engine: mvEngine, exists: mvEngine !== null},
    windowHours,
    raw: {
      liveCount: rawLiveCount,
      maxUpdatedAtMs: normalizeEpochMs(toMsOrNull(rawStats?.maxUpdatedAtMs ?? null)),
      recentLiveCount: rawRecentLiveCount,
      recentMaxUpdatedAtMs: normalizeEpochMs(toMsOrNull(rawStats?.recentMaxUpdatedAtMs ?? null)),
    },
    derived: {
      liveCount: derivedLiveCount,
      maxUpdatedAtMs: normalizeEpochMs(toMsOrNull(derivedStats?.maxUpdatedAtMs ?? null)),
      recentLiveCount: derivedRecentLiveCount,
      recentMaxUpdatedAtMs: normalizeEpochMs(toMsOrNull(derivedStats?.recentMaxUpdatedAtMs ?? null)),
    },
    drift: {
      liveCountDiff,
      status: toDriftStatus(liveCountDiff),
      recentLiveCountDiff,
      recentStatus: toDriftStatus(recentLiveCountDiff),
      missingDerivedRecent: toNumber(missingDerived?.missingDerived),
    },
    enrichment: {
      missingTitle: toNumber(derivedStats?.missingTitle),
      recentMissingTitle: toNumber(derivedStats?.recentMissingTitle),
      missingImportRoute: toNumber(derivedStats?.missingImportRoute),
      recentMissingImportRoute: toNumber(derivedStats?.recentMissingImportRoute),
    },
    missingTitleBreakdown: {
      missingTitle: toNumber(titleStats?.missingTitle),
      missingArticleInClickhouse: toNumber(titleStats?.missingArticleInClickhouse),
      staleMissingTitle: toNumber(titleStats?.staleMissingTitle),
      emptyTitleInArticles: toNumber(titleStats?.emptyTitleInArticles),
      recentMissingTitle: toNumber(titleStats?.recentMissingTitle),
      recentMissingArticleInClickhouse: toNumber(titleStats?.recentMissingArticleInClickhouse),
      recentStaleMissingTitle: toNumber(titleStats?.recentStaleMissingTitle),
      recentEmptyTitleInArticles: toNumber(titleStats?.recentEmptyTitleInArticles),
    },
    importRouteBreakdown: {
      missingImportRoute: toNumber(importRouteStats?.missingImportRoute),
      missingArticleInClickhouse: toNumber(importRouteStats?.missingArticleInClickhouse),
      staleMissingImportRoute: toNumber(importRouteStats?.staleMissingImportRoute),
      bothNullImportRoute: toNumber(importRouteStats?.bothNullImportRoute),
      recentMissingImportRoute: toNumber(importRouteStats?.recentMissingImportRoute),
      recentMissingArticleInClickhouse: toNumber(importRouteStats?.recentMissingArticleInClickhouse),
      recentStaleMissingImportRoute: toNumber(importRouteStats?.recentStaleMissingImportRoute),
      recentBothNullImportRoute: toNumber(importRouteStats?.recentBothNullImportRoute),
    },
  }
}

const getClickhouseTableStats = async (table: 'articles' | 'judgments'): Promise<ClickhouseTableStats> => {
  const client = getClickhouseClient()
  const targetTable = table === 'articles' ? 'articles' : 'judgments_raw'
  const liveWhere =
    table === 'articles' ? 'WHERE _peerdb_is_deleted = 0' : 'WHERE deleted_at IS NULL AND _peerdb_is_deleted = 0'

  const maxUpdatedAtMsExpr =
    'max(if(toYear(updated_at) = 2299, intDiv(toUnixTimestamp64Milli(updated_at), 1000), toUnixTimestamp64Milli(updated_at)))'

  const [rawResult, liveResult] = await Promise.all([
    client.query({
      query: `
        SELECT
          count() as totalCount,
          if(count() = 0, NULL, ${maxUpdatedAtMsExpr}) as maxUpdatedAtMs
        FROM forska.${targetTable}
      `,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT
          count() as liveCount,
          if(count() = 0, NULL, ${maxUpdatedAtMsExpr}) as liveMaxUpdatedAtMs
        FROM forska.${targetTable} FINAL
        ${liveWhere}
      `,
      format: 'JSONEachRow',
    }),
  ])

  const rawRow = await rawResult.json<{totalCount: string | number; maxUpdatedAtMs: string | number | null}>()
  const liveRow = await liveResult.json<{liveCount: string | number; liveMaxUpdatedAtMs: string | number | null}>()

  const totalCount = toNumber((Array.isArray(rawRow) ? rawRow[0] : rawRow)?.totalCount)
  const maxUpdatedAtMs = normalizeEpochMs(toMsOrNull((Array.isArray(rawRow) ? rawRow[0] : rawRow)?.maxUpdatedAtMs))
  const liveCount = toNumber((Array.isArray(liveRow) ? liveRow[0] : liveRow)?.liveCount)
  const liveMaxUpdatedAtMs = normalizeEpochMs(
    toMsOrNull((Array.isArray(liveRow) ? liveRow[0] : liveRow)?.liveMaxUpdatedAtMs),
  )
  const dedupDrift = Math.max(0, totalCount - liveCount)

  return {totalCount, maxUpdatedAtMs, liveCount, liveMaxUpdatedAtMs, dedupDrift}
}

const getClickhouseIngestionStats = async (table: 'articles' | 'judgments'): Promise<ClickhouseIngestionStats> => {
  const client = getClickhouseClient()
  const targetTable = table === 'articles' ? 'articles' : 'judgments_raw'

  const maxUpdatedAtMsExpr =
    'max(if(toYear(updated_at) = 2299, intDiv(toUnixTimestamp64Milli(updated_at), 1000), toUnixTimestamp64Milli(updated_at)))'

  const result = await client.query({
    query: `
      SELECT
        if(count() = 0, NULL, toUnixTimestamp64Milli(max(_peerdb_synced_at))) as maxPeerdbSyncedAtMs,
        if(count() = 0, NULL, ${maxUpdatedAtMsExpr}) as maxUpdatedAtMs
      FROM forska.${targetTable}
    `,
    format: 'JSONEachRow',
  })

  const row = await result.json<{maxPeerdbSyncedAtMs: string | number | null; maxUpdatedAtMs: string | number | null}>()
  const firstRow = Array.isArray(row) ? row[0] : row

  const maxPeerdbSyncedAtMs = normalizeEpochMs(toMsOrNull(firstRow?.maxPeerdbSyncedAtMs ?? null))
  const maxUpdatedAtMs = normalizeEpochMs(toMsOrNull(firstRow?.maxUpdatedAtMs ?? null))

  return {maxPeerdbSyncedAtMs, maxUpdatedAtMs}
}

const getPgArticlesUpdatedAfter = async (afterMs: number): Promise<number> => {
  const db = getDatabase()
  const afterDate = new Date(afterMs)
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATS_STATEMENT_TIMEOUT_MS}`))
    return tx.select({count: count()}).from(articles).where(gt(articles.updatedAt, afterDate))
  })

  return result[0]?.count ?? 0
}

const getPgJudgmentsUpdatedAfter = async (afterMs: number): Promise<number> => {
  const db = getDatabase()
  const afterDate = new Date(afterMs)
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATS_STATEMENT_TIMEOUT_MS}`))
    return tx
      .select({count: count()})
      .from(judgments)
      .where(and(isNull(judgments.deletedAt), gt(judgments.updatedAt, afterDate)))
  })

  return result[0]?.count ?? 0
}

const computeDiff = (pgCount: number, chCount: number | null) => {
  if (chCount === null) return {absolute: null, percentage: null, direction: 'unknown' as const}
  const absolute = pgCount - chCount
  const percentage = pgCount > 0 ? absolute / pgCount : null
  const direction = absolute === 0 ? 'synced' : absolute > 0 ? 'pg_ahead' : 'ch_ahead'
  return {absolute, percentage, direction}
}

const computeLagSeconds = (pgMs: number | null, chMs: number | null) => {
  if (pgMs === null || chMs === null) return null
  return Math.trunc((pgMs - chMs) / 1000)
}

const buildSyncStatsData = async () => {
  const clickhouseReachable = await pingClickhouse(2000)
  await (clickhouseReachable ? ensureClickhouseSchema() : Promise.resolve())

  const [peerdb, postgresSlot, clickhouseMergeParts, pgArticles, pgJudgments, chArticles, chJudgments] =
    await Promise.all([
      getPeerdbMirrorHealth(),
      getPostgresSlotHealth(),
      getClickhouseMergePartsSummary(),
      getPgTableStats('articles'),
      getPgTableStats('judgments'),
      clickhouseReachable ? getClickhouseTableStats('articles') : null,
      clickhouseReachable ? getClickhouseTableStats('judgments') : null,
    ])

  const articles = {
    pg: pgArticles,
    ch: chArticles,
    diff: computeDiff(pgArticles.count, chArticles?.liveCount ?? null),
    lagSeconds: computeLagSeconds(pgArticles.maxUpdatedAtMs, chArticles?.liveMaxUpdatedAtMs ?? null),
  }

  const judgments = {
    pg: pgJudgments,
    ch: chJudgments,
    diff: computeDiff(pgJudgments.count, chJudgments?.liveCount ?? null),
    lagSeconds: computeLagSeconds(pgJudgments.maxUpdatedAtMs, chJudgments?.liveMaxUpdatedAtMs ?? null),
  }

  return {
    queriedAt: new Date().toISOString(),
    replication: {peerdb, postgres: {slot: postgresSlot}, clickhouse: clickhouseMergeParts},
    stats: {articles, judgments},
  }
}

const getClickhouseMergePartsSummary = async (): Promise<{
  reachable: boolean
  tables: Record<'articles' | 'judgments', {partsActive: number; mergesInProgress: number}>
}> => {
  const reachable = await pingClickhouse(2000)
  if (!reachable) {
    return {
      reachable: false,
      tables: {articles: {partsActive: 0, mergesInProgress: 0}, judgments: {partsActive: 0, mergesInProgress: 0}},
    }
  }

  const client = getClickhouseClient()
  const tableList = "'articles', 'judgments_raw'"

  const [partsResult, mergesResult] = await Promise.all([
    client.query({
      query: `
        SELECT table, count() as partsActive
        FROM system.parts
        WHERE active AND database = 'forska' AND table IN (${tableList})
        GROUP BY table
      `,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT table, count() as mergesInProgress
        FROM system.merges
        WHERE database = 'forska' AND table IN (${tableList})
        GROUP BY table
      `,
      format: 'JSONEachRow',
    }),
  ])

  const partsRows = await partsResult.json<{table: string; partsActive: string | number}>()
  const mergesRows = await mergesResult.json<{table: string; mergesInProgress: string | number}>()

  const partsByTable = partsRows.reduce(
    (acc, row) => {
      const key = row.table === 'judgments_raw' ? 'judgments' : row.table === 'articles' ? 'articles' : null
      return key ? {...acc, [key]: toNumber(row.partsActive)} : acc
    },
    {} as Partial<Record<'articles' | 'judgments', number>>,
  )

  const mergesByTable = mergesRows.reduce(
    (acc, row) => {
      const key = row.table === 'judgments_raw' ? 'judgments' : row.table === 'articles' ? 'articles' : null
      return key ? {...acc, [key]: toNumber(row.mergesInProgress)} : acc
    },
    {} as Partial<Record<'articles' | 'judgments', number>>,
  )

  return {
    reachable: true,
    tables: {
      articles: {partsActive: partsByTable.articles ?? 0, mergesInProgress: mergesByTable.articles ?? 0},
      judgments: {partsActive: partsByTable.judgments ?? 0, mergesInProgress: mergesByTable.judgments ?? 0},
    },
  }
}

const getSampleIdsQuery = (input: {
  table: 'articles' | 'judgments'
  sampleType: 'recent' | 'random' | 'deleted'
  sampleSize: number
}) => {
  const tableRef = input.table === 'articles' ? articles : judgments
  const tableSample = input.sampleType === 'random' ? sql`TABLESAMPLE SYSTEM (1)` : sql``
  const whereClause =
    input.table === 'judgments' && input.sampleType === 'deleted'
      ? sql`WHERE deleted_at IS NOT NULL`
      : input.table === 'judgments'
        ? sql`WHERE deleted_at IS NULL`
        : sql``
  const orderClause =
    input.sampleType === 'deleted' && input.table === 'judgments'
      ? sql`ORDER BY deleted_at DESC, id DESC`
      : input.sampleType === 'random'
        ? sql``
        : sql`ORDER BY updated_at DESC, id DESC`

  return sql`SELECT id::text AS id FROM ${tableRef} ${tableSample} ${whereClause} ${orderClause} LIMIT ${input.sampleSize}`
}

const getFieldMismatches = (
  table: 'articles' | 'judgments',
  id: string,
  pg: Record<string, unknown>,
  ch: Record<string, unknown>,
): Array<{id: string; field: string; pg: unknown; ch: unknown}> => {
  if (table === 'articles') {
    const pgTitle = pg['articleTitle']
    const chTitle = ch['articleTitle']
    return pgTitle === chTitle ? [] : [{id, field: 'articleTitle', pg: pgTitle, ch: chTitle}]
  }

  const boolFields = new Set(['useTitle', 'useAbstract', 'useFulltext', 'useFulltextNoImages'])

  const toBool = (value: unknown): boolean | null => {
    if (value === null || value === undefined) return null
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') {
      const trimmed = value.trim().toLowerCase()
      return trimmed === '1' || trimmed === 'true' ? true : trimmed === '0' || trimmed === 'false' ? false : null
    }
    return null
  }

  const normalize = (field: string, value: unknown) => {
    return boolFields.has(field) ? toBool(value) : value
  }

  const fields = [
    'articleId',
    'promptId',
    'modelId',
    'useTitle',
    'useAbstract',
    'useFulltext',
    'useFulltextNoImages',
    'answeredOriginal',
    'explanation',
  ]

  return fields.reduce(
    (acc, field) => {
      const pgValue = normalize(field, pg[field])
      const chValue = normalize(field, ch[field])
      return pgValue === chValue ? acc : acc.concat({id, field, pg: pgValue, ch: chValue})
    },
    [] as Array<{id: string; field: string; pg: unknown; ch: unknown}>,
  )
}

const getSampleVerifyResult = async (input: {
  table: 'articles' | 'judgments'
  sampleType: 'recent' | 'random' | 'deleted'
  sampleSize: number
}) => {
  const db = getDatabase()
  await ensureClickhouseSchema()
  const idsResult = await db.execute<{id: string}>(getSampleIdsQuery(input))
  const sampleIds = idsResult.rows.map((r) => {
    return r.id
  })

  if (sampleIds.length === 0) {
    return {
      table: input.table,
      sampleType: input.sampleType,
      sampled: 0,
      matched: 0,
      missingInCh: [],
      missingInPg: [],
      fieldMismatches: [],
    }
  }

  const pgRows =
    input.table === 'articles'
      ? await db
          .select({
            id: articles.id,
            updatedAt: articles.updatedAt,
            createdAt: articles.createdAt,
            articleTitle: articles.articleTitle,
          })
          .from(articles)
          .where(
            sql`${articles.id} IN (${sql.join(
              sampleIds.map((id) => {
                return sql`${id}::uuid`
              }),
              sql`, `,
            )})`,
          )
      : await db
          .select({
            id: judgments.id,
            updatedAt: judgments.updatedAt,
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
            explanation: judgments.explanation,
          })
          .from(judgments)
          .where(
            sql`${judgments.id} IN (${sql.join(
              sampleIds.map((id) => {
                return sql`${id}::uuid`
              }),
              sql`, `,
            )})`,
          )

  const pgById = pgRows.reduce(
    (acc, row) => {
      return {...acc, [row.id]: row}
    },
    {} as Record<string, (typeof pgRows)[number]>,
  )

  const client = getClickhouseClient()
  const chQuery =
    input.table === 'articles'
      ? `
          SELECT
            toString(id) as id,
            article_title as articleTitle
          FROM forska.articles FINAL
          WHERE id IN ({ids:Array(String)}) AND _peerdb_is_deleted = 0
        `
      : `
          SELECT
            toString(id) as id,
            toString(article_id) as articleId,
            toString(prompt_id) as promptId,
            toString(model_id) as modelId,
            use_title as useTitle,
            use_abstract as useAbstract,
            use_fulltext as useFulltext,
            use_fulltext_no_images as useFulltextNoImages,
            answered_original as answeredOriginal,
            explanation
          FROM forska.judgments_raw FINAL
          WHERE id IN ({ids:Array(String)}) AND deleted_at IS NULL AND _peerdb_is_deleted = 0
        `

  const chResult = await client.query({query: chQuery, query_params: {ids: sampleIds}, format: 'JSONEachRow'})
  const chRows = await chResult.json<Record<string, unknown>>()
  const chById = (Array.isArray(chRows) ? chRows : [chRows]).reduce(
    (acc, row) => {
      const id = typeof row['id'] === 'string' ? row['id'] : ''
      return id ? {...acc, [id]: row} : acc
    },
    {} as Record<string, Record<string, unknown>>,
  )

  const missingInCh = sampleIds.filter((id) => {
    return !chById[id]
  })
  const missingInPg = sampleIds.filter((id) => {
    return !pgById[id]
  })

  const fieldMismatches = sampleIds.reduce(
    (acc, id) => {
      const pg = pgById[id]
      const ch = chById[id]
      const next =
        pg && ch
          ? acc.concat(
              getFieldMismatches(
                input.table,
                id,
                pg as unknown as Record<string, unknown>,
                ch as unknown as Record<string, unknown>,
              ),
            )
          : acc
      return next.length > 50 ? next.slice(0, 50) : next
    },
    [] as Array<{id: string; field: string; pg: unknown; ch: unknown}>,
  )

  const mismatchedIds = new Set(
    fieldMismatches.map((m) => {
      return m.id
    }),
  )

  const matched =
    input.sampleType === 'deleted'
      ? missingInCh.length
      : sampleIds.length - missingInCh.length - missingInPg.length - mismatchedIds.size

  return {
    table: input.table,
    sampleType: input.sampleType,
    sampled: sampleIds.length,
    matched,
    missingInCh,
    missingInPg,
    fieldMismatches,
  }
}

const getPartitionCoverage = async (input: {table: 'articles' | 'judgments'; months: number}) => {
  const db = getDatabase()
  await ensureClickhouseSchema()
  const pgTable = input.table === 'articles' ? sql.identifier('articles') : sql.identifier('judgments')
  const pgFilter = input.table === 'judgments' ? sql`AND deleted_at IS NULL` : sql``

  const pgCounts = await db.execute<{month: string; count: number}>(sql`
    SELECT
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') as month,
      COUNT(*)::int as count
    FROM ${pgTable}
    WHERE created_at >= NOW() - make_interval(months => ${input.months})
    ${pgFilter}
    GROUP BY 1
    ORDER BY 1 DESC
  `)

  const client = getClickhouseClient()
  const chTable = input.table === 'articles' ? 'articles' : 'judgments_raw'
  const chCursorCol = 'created_at'
  const chWhere =
    input.table === 'articles' ? 'WHERE _peerdb_is_deleted = 0' : 'WHERE deleted_at IS NULL AND _peerdb_is_deleted = 0'
  const chNow = input.table === 'articles' ? "now64(6, 'UTC')" : "now64(3, 'UTC')"
  const chCountsResult = await client.query({
    query: `
      SELECT
        formatDateTime(toTimeZone(${chCursorCol}, 'UTC'), '%Y-%m') as month,
        count() as count
      FROM forska.${chTable} FINAL
      ${chWhere} AND ${chCursorCol} >= ${chNow} - INTERVAL {months:Int32} MONTH
      GROUP BY month
      ORDER BY month DESC
    `,
    query_params: {months: input.months},
    format: 'JSONEachRow',
  })
  const chCountsRows = await chCountsResult.json<{month: string; count: string | number}>()

  const pgByMonth = pgCounts.rows.reduce(
    (acc, row) => {
      return {...acc, [row.month]: row.count}
    },
    {} as Record<string, number>,
  )
  const chByMonth = chCountsRows.reduce(
    (acc, row) => {
      return {...acc, [row.month]: toNumber(row.count)}
    },
    {} as Record<string, number>,
  )

  const allMonths = [...new Set([...Object.keys(pgByMonth), ...Object.keys(chByMonth)])].sort((a, b) => {
    return b.localeCompare(a)
  })

  const months = allMonths.map((month) => {
    const pg = pgByMonth[month] ?? 0
    const ch = chByMonth[month] ?? 0
    const diff = pg - ch
    const status = diff === 0 ? 'synced' : ch === 0 && pg > 0 ? 'missing' : 'diff'
    return {month, pg, ch, diff, status}
  })

  const totalPg = months.reduce((sum, m) => {
    return sum + m.pg
  }, 0)
  const totalCh = months.reduce((sum, m) => {
    return sum + m.ch
  }, 0)

  const missingMonths = months
    .filter((m) => {
      return m.status === 'missing'
    })
    .map((m) => {
      return m.month
    })

  return {
    table: input.table,
    monthsChecked: input.months,
    months,
    summary: {
      totalPg,
      totalCh,
      missingMonths,
      status: missingMonths.length > 0 ? 'partition_gap' : totalPg === totalCh ? 'synced' : 'diff',
    },
  }
}

export const adminSyncStatsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireUserAuth())
  .get('/api/admin/sync-stats', async () => {
    const data = await buildSyncStatsData()
    return {data}
  })
  .get('/api/admin/sync-stats/peerdb-mirror-health', async () => {
    const data = await getPeerdbMirrorHealth()
    return {data}
  })
  .get('/api/admin/sync-stats/pg-replication-slot-health', async () => {
    const data = await getPostgresSlotHealth()
    return {data}
  })
  .get('/api/admin/sync-stats/ch-merge-parts-summary', async () => {
    const data = await getClickhouseMergePartsSummary()
    return {data}
  })
  .get('/api/admin/sync-stats/pg-articles', async () => {
    const data = await getPgArticlesFastStats()
    return {data}
  })
  .get('/api/admin/sync-stats/pg-judgments', async () => {
    const stats = await getPgTableStats('judgments')
    const data = {...stats, countType: 'exact' as const}
    return {data}
  })
  .get('/api/admin/sync-stats/ch-articles', async () => {
    await ensureClickhouseSchema()
    const stats = await getClickhouseTableStats('articles')
    const data = {count: stats.liveCount, countType: 'exact' as const, maxUpdatedAtMs: stats.liveMaxUpdatedAtMs}
    return {data}
  })
  .get('/api/admin/sync-stats/ch-judgments', async () => {
    await ensureClickhouseSchema()
    const stats = await getClickhouseTableStats('judgments')
    const data = {count: stats.liveCount, countType: 'exact' as const, maxUpdatedAtMs: stats.liveMaxUpdatedAtMs}
    return {data}
  })
  .get('/api/admin/sync-stats/ch-articles-ingestion', async () => {
    await ensureClickhouseSchema()
    const data = await getClickhouseIngestionStats('articles')
    return {data}
  })
  .get('/api/admin/sync-stats/ch-judgments-ingestion', async () => {
    await ensureClickhouseSchema()
    const data = await getClickhouseIngestionStats('judgments')
    return {data}
  })
  .get('/api/admin/sync-stats/ch-judgments-derived-health', async () => {
    await ensureClickhouseSchema()
    const data = await getClickhouseJudgmentsDerivedHealth()
    return {data}
  })
  .post('/api/admin/sync-stats/rebuild-ch-judgments-derived-table', async () => {
    const data = await rebuildClickhouseJudgmentsDerivedTable()
    return {data}
  })
  .get(
    '/api/admin/sync-stats/pg-articles-updated-after',
    async ({query}) => {
      const afterMs = Math.max(0, toNumber(query.afterMs))
      const count = await getPgArticlesUpdatedAfter(afterMs)
      const data = {afterMs, count}
      return {data}
    },
    {query: t.Object({afterMs: t.String()})},
  )
  .get(
    '/api/admin/sync-stats/pg-judgments-updated-after',
    async ({query}) => {
      const afterMs = Math.max(0, toNumber(query.afterMs))
      const count = await getPgJudgmentsUpdatedAfter(afterMs)
      const data = {afterMs, count}
      return {data}
    },
    {query: t.Object({afterMs: t.String()})},
  )
  .post(
    '/api/admin/refresh-sync-stats',
    async () => {
      const data = await buildSyncStatsData()
      return {data}
    },
    {
      body: t.Optional(
        t.Object({
          tables: t.Optional(t.Array(t.String())),
          fullRecount: t.Optional(t.Boolean()),
          includeUniqueCount: t.Optional(t.Boolean()),
        }),
      ),
    },
  )
  .get('/api/admin/refresh-sync-stats-progress', async () => {
    return {jobs: {}}
  })
  .post(
    '/api/admin/sample-verify',
    async ({body}) => {
      const sampleSize = Math.max(1, Math.min(500, body.sampleSize ?? 100))
      const sampleType = body.sampleType ?? 'recent'
      const result = await getSampleVerifyResult({table: body.table, sampleType, sampleSize})
      return {data: result}
    },
    {
      body: t.Object({
        table: t.Union([t.Literal('articles'), t.Literal('judgments')]),
        sampleSize: t.Optional(t.Number()),
        sampleType: t.Optional(t.Union([t.Literal('recent'), t.Literal('random'), t.Literal('deleted')])),
      }),
    },
  )
  .post(
    '/api/admin/partition-coverage-check',
    async ({body}) => {
      const months = Math.max(1, Math.min(60, body.months ?? 12))
      const result = await getPartitionCoverage({table: body.table, months})
      return {data: result}
    },
    {body: t.Object({table: t.Union([t.Literal('articles'), t.Literal('judgments')]), months: t.Optional(t.Number())})},
  )
