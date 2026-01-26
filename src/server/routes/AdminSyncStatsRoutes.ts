import {eq, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, judgments, pgChSyncStats} from '../../db/schema.ts'
import {getClickhouseClient, pingClickhouse} from '../../services/clickhouse/clickhouseClient.ts'
import {ensureClickhouseSchema} from '../../services/clickhouse/ensureClickhouseSchema.ts'
import {parseClickhouseDateTimeUtc} from '../../services/clickhouse/parseClickhouseDateTimeUtc.ts'
import {requireAdminAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

const SYNC_STATS_IDS = ['pg_articles', 'ch_articles', 'pg_judgments', 'ch_judgments'] as const

type SyncStatsId = (typeof SYNC_STATS_IDS)[number]

const BATCH_SIZE = 50_000
const STALE_JOB_MINUTES = 30

const ISO_UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
const MIN_UUID_TEXT = '00000000-0000-0000-0000-000000000000'

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return parseInt(value, 10) || 0
  return typeof value === 'bigint' ? Number(value) : 0
}

const toNullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : null
  return typeof value === 'number' || typeof value === 'bigint' ? String(value) : null
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Unknown error'
}

const toLagSeconds = (pgMaxCursorAt: string | null, chMaxCursorAt: string | null): number | null => {
  const pg = parseClickhouseDateTimeUtc(pgMaxCursorAt)
  const ch = parseClickhouseDateTimeUtc(chMaxCursorAt)
  return pg && ch ? Math.round((pg.getTime() - ch.getTime()) / 1000) : null
}

const isStaleHeartbeat = (lastUpdatedAt: Date | null, nowMs: number): boolean => {
  return lastUpdatedAt ? nowMs - lastUpdatedAt.getTime() > STALE_JOB_MINUTES * 60 * 1000 : false
}

const ensurePgChSyncStatsSeeded = async (): Promise<void> => {
  const db = getDatabase()
  const now = new Date()
  await db
    .insert(pgChSyncStats)
    .values(
      SYNC_STATS_IDS.map((id) => {
        return {
          id,
          lastUpdatedAt: now,
          jobStatus: 'idle',
          jobRowsCounted: 0,
          totalCount: 0,
          activeCount: 0,
          deletedCount: 0,
        }
      }),
    )
    .onConflictDoNothing()
}

const setJobRunning = async (statsId: SyncStatsId): Promise<{started: boolean; reason?: string}> => {
  const db = getDatabase()
  const now = new Date()
  const nowMs = Date.now()

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({jobStatus: pgChSyncStats.jobStatus, lastUpdatedAt: pgChSyncStats.lastUpdatedAt})
      .from(pgChSyncStats)
      .where(eq(pgChSyncStats.id, statsId))
      .for('update')

    const stale = current?.jobStatus === 'running' ? isStaleHeartbeat(current.lastUpdatedAt ?? null, nowMs) : false

    if (current?.jobStatus === 'running' && !stale) {
      return {started: false, reason: 'Job already running'}
    }

    await tx
      .update(pgChSyncStats)
      .set({
        jobStatus: 'running',
        jobStartedAt: now,
        jobCompletedAt: null,
        jobError: null,
        jobCurrentBatch: 0,
        jobRowsCounted: 0,
        lastUpdatedAt: now,
      })
      .where(eq(pgChSyncStats.id, statsId))

    return {started: true}
  })
}

const setJobCompleted = async (statsId: SyncStatsId): Promise<void> => {
  const db = getDatabase()
  const now = new Date()
  await db
    .update(pgChSyncStats)
    .set({jobStatus: 'completed', jobCompletedAt: now, lastUpdatedAt: now})
    .where(eq(pgChSyncStats.id, statsId))
}

const setJobError = async (statsId: SyncStatsId, error: unknown): Promise<void> => {
  const db = getDatabase()
  const now = new Date()
  const message = getErrorMessage(error)
  await db
    .update(pgChSyncStats)
    .set({jobStatus: 'error', jobError: message, jobCompletedAt: now, lastUpdatedAt: now})
    .where(eq(pgChSyncStats.id, statsId))
}

const resetSyncStatsRow = async (statsId: SyncStatsId): Promise<void> => {
  const db = getDatabase()
  const now = new Date()
  await db
    .update(pgChSyncStats)
    .set({
      totalCount: 0,
      activeCount: 0,
      deletedCount: 0,
      uniqueCount: null,
      uniqueCountAt: null,
      watermarkCursorCol: null,
      watermarkTs: null,
      watermarkId: null,
      maxCursorAt: null,
      jobCurrentBatch: 0,
      jobRowsCounted: 0,
      jobError: null,
      lastUpdatedAt: now,
    })
    .where(eq(pgChSyncStats.id, statsId))
}

const getPgFullRecountBoundary = async (
  tableName: 'articles' | 'judgments',
  cursorColName: 'updated_at' | 'created_at',
): Promise<{ts: string; id: string} | null> => {
  const db = getDatabase()
  const result = await db.execute<{ts: string | null; id: string | null}>(sql`
    SELECT
      to_char(${sql.identifier(cursorColName)} AT TIME ZONE 'UTC', ${ISO_UTC_FORMAT}) as ts,
      id::text as id
    FROM ${sql.identifier(tableName)}
    ORDER BY ${sql.identifier(cursorColName)} DESC, id DESC
    LIMIT 1
  `)

  const row = result.rows[0]
  return row?.ts && row?.id ? {ts: row.ts, id: row.id} : null
}

const getPgBatchCounts = async (input: {
  tableName: 'articles' | 'judgments'
  hasDeletedAt: boolean
  cursorColName: 'updated_at' | 'created_at'
  watermarkTs: string | null
  watermarkId: string | null
  boundary: {ts: string; id: string} | null
}): Promise<{
  totalCount: number
  activeCount: number
  deletedCount: number
  lastCursorAt: string | null
  lastId: string | null
}> => {
  const db = getDatabase()
  const boundaryClause = input.boundary
    ? sql`AND (${sql.identifier(input.cursorColName)}, id) <= (${input.boundary.ts}::timestamptz, ${input.boundary.id}::uuid)`
    : sql``

  const deletedCols = input.hasDeletedAt ? sql`, deleted_at` : sql``
  const activeDeletedCounts = input.hasDeletedAt
    ? sql`COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active_count,
          COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted_count,`
    : sql`COUNT(*)::int AS active_count,
          0 AS deleted_count,`

  const result = await db.execute<{
    total_count: number
    active_count: number
    deleted_count: number
    last_cursor_at: string | null
    last_id: string | null
  }>(sql`
    WITH batch AS (
      SELECT
        id,
        ${sql.identifier(input.cursorColName)} AS cursor_at
        ${deletedCols}
      FROM ${sql.identifier(input.tableName)}
      WHERE (${sql.identifier(input.cursorColName)}, id) > (
        COALESCE(${input.watermarkTs}::timestamptz, '-infinity'::timestamptz),
        COALESCE(${input.watermarkId}::uuid, ${MIN_UUID_TEXT}::uuid)
      )
      ${boundaryClause}
      ORDER BY ${sql.identifier(input.cursorColName)} ASC, id ASC
      LIMIT ${BATCH_SIZE}
    )
    SELECT
      COUNT(*)::int AS total_count,
      ${activeDeletedCounts}
      (SELECT to_char(cursor_at AT TIME ZONE 'UTC', ${ISO_UTC_FORMAT}) FROM batch ORDER BY cursor_at DESC, id DESC LIMIT 1) AS last_cursor_at,
      (SELECT id::text FROM batch ORDER BY cursor_at DESC, id DESC LIMIT 1) AS last_id
    FROM batch
  `)

  const row = result.rows[0]

  return {
    totalCount: row?.total_count ?? 0,
    activeCount: row?.active_count ?? 0,
    deletedCount: row?.deleted_count ?? 0,
    lastCursorAt: row?.last_cursor_at ?? null,
    lastId: row?.last_id ?? null,
  }
}

const updatePgCountsForBatch = async (input: {
  statsId: SyncStatsId
  cursorLabel: 'updated_at' | 'createdAt' | 'updatedAt'
  batchNumber: number
  batchCounts: {totalCount: number; activeCount: number; deletedCount: number; lastCursorAt: string; lastId: string}
}): Promise<void> => {
  const db = getDatabase()
  const now = new Date()
  const lastCursorAt = input.batchCounts.lastCursorAt

  await db
    .update(pgChSyncStats)
    .set({
      totalCount: sql`${pgChSyncStats.totalCount} + ${input.batchCounts.totalCount}`,
      activeCount: sql`${pgChSyncStats.activeCount} + ${input.batchCounts.activeCount}`,
      deletedCount: sql`${pgChSyncStats.deletedCount} + ${input.batchCounts.deletedCount}`,
      watermarkCursorCol: input.cursorLabel,
      watermarkTs: lastCursorAt,
      watermarkId: input.batchCounts.lastId,
      maxCursorAt: sql`COALESCE(
        CASE WHEN ${pgChSyncStats.maxCursorAt} > ${lastCursorAt}
             THEN ${pgChSyncStats.maxCursorAt}
             ELSE ${lastCursorAt} END,
        ${lastCursorAt}
      )`,
      jobCurrentBatch: input.batchNumber,
      jobRowsCounted: sql`${pgChSyncStats.jobRowsCounted} + ${input.batchCounts.totalCount}`,
      lastUpdatedAt: now,
    })
    .where(eq(pgChSyncStats.id, input.statsId))
}

const completePgFullRecount = async (statsId: SyncStatsId): Promise<void> => {
  const db = getDatabase()
  const now = new Date()
  await db
    .update(pgChSyncStats)
    .set({uniqueCount: sql`${pgChSyncStats.activeCount}`, uniqueCountAt: now, lastFullCountAt: now, lastUpdatedAt: now})
    .where(eq(pgChSyncStats.id, statsId))
}

const runPgCountsJob = async (input: {
  statsId: SyncStatsId
  tableName: 'articles' | 'judgments'
  hasDeletedAt: boolean
  cursorColName: 'updated_at' | 'created_at'
  cursorLabel: 'updated_at' | 'createdAt' | 'updatedAt'
  fullRecount: boolean
}): Promise<void> => {
  const db = getDatabase()

  const boundary = input.fullRecount ? await getPgFullRecountBoundary(input.tableName, input.cursorColName) : null

  const [stats] = await db
    .select({watermarkTs: pgChSyncStats.watermarkTs, watermarkId: pgChSyncStats.watermarkId})
    .from(pgChSyncStats)
    .where(eq(pgChSyncStats.id, input.statsId))
    .limit(1)

  const startWatermark = {ts: stats?.watermarkTs ?? null, id: stats?.watermarkId ?? null}

  const countRecursive = async (
    watermark: {ts: string | null; id: string | null},
    batchNumber: number,
  ): Promise<void> => {
    const batch = await getPgBatchCounts({
      tableName: input.tableName,
      hasDeletedAt: input.hasDeletedAt,
      cursorColName: input.cursorColName,
      watermarkTs: watermark.ts,
      watermarkId: watermark.id,
      boundary,
    })

    if (batch.totalCount === 0 || !batch.lastCursorAt || !batch.lastId) {
      return
    }

    await updatePgCountsForBatch({
      statsId: input.statsId,
      cursorLabel: input.cursorLabel,
      batchNumber,
      batchCounts: {
        totalCount: batch.totalCount,
        activeCount: batch.activeCount,
        deletedCount: batch.deletedCount,
        lastCursorAt: batch.lastCursorAt,
        lastId: batch.lastId,
      },
    })

    return countRecursive({ts: batch.lastCursorAt, id: batch.lastId}, batchNumber + 1)
  }

  await countRecursive(startWatermark, 1)

  return input.fullRecount ? completePgFullRecount(input.statsId) : Promise.resolve()
}

const hasClickhouseColumn = async (dbName: string, table: string, col: string): Promise<boolean> => {
  const client = getClickhouseClient()
  const result = await client.query({
    query: `
      SELECT count() AS cnt
      FROM system.columns
      WHERE database = {db:String} AND table = {table:String} AND name = {col:String}
    `,
    query_params: {db: dbName, table, col},
    format: 'JSONEachRow',
  })
  const rows = await result.json<{cnt: string | number}>()
  const firstRow = Array.isArray(rows) ? rows[0] : rows
  return toNumber(firstRow?.cnt) > 0
}

const fetchClickhouseTableStats = async (input: {
  table: 'articles' | 'judgments'
  includeUniqueExact: boolean
}): Promise<{
  totalCount: number
  activeCount: number
  deletedCount: number
  uniqueCount: number | null
  cursorCol: 'updated_at' | 'createdAt' | 'updatedAt'
  maxCursorAt: string | null
}> => {
  await ensureClickhouseSchema()

  const client = getClickhouseClient()

  const hasJudgmentsUpdatedAt =
    input.table === 'judgments' ? await hasClickhouseColumn('forska', 'judgments', 'updatedAt') : true
  const hasJudgmentsDeletedAt =
    input.table === 'judgments' ? await hasClickhouseColumn('forska', 'judgments', 'deletedAt') : false

  const cursorCol = input.table === 'articles' ? 'updated_at' : hasJudgmentsUpdatedAt ? 'updatedAt' : 'createdAt'
  const countsQuery =
    input.table === 'articles'
      ? `
          SELECT
            count() as totalCount,
            toString(maxOrNull(updated_at)) as maxCursorAt
          FROM forska.articles
        `
      : hasJudgmentsDeletedAt
        ? `
            SELECT
              count() as totalCount,
              countIf(deletedAt IS NULL) as activeCount,
              countIf(deletedAt IS NOT NULL) as deletedCount,
              toString(maxOrNull(${cursorCol})) as maxCursorAt
            FROM forska.judgments
          `
        : `
            SELECT
              count() as totalCount,
              count() as activeCount,
              0 as deletedCount,
              toString(maxOrNull(${cursorCol})) as maxCursorAt
            FROM forska.judgments
          `

  const uniqueQuery = input.includeUniqueExact
    ? input.table === 'articles'
      ? 'SELECT uniqExact(id) as uniqueCount FROM forska.articles'
      : 'SELECT uniqExact(id) as uniqueCount FROM forska.judgments'
    : input.table === 'articles'
      ? 'SELECT uniqCombined(id) as uniqueCount FROM forska.articles'
      : 'SELECT uniqCombined(id) as uniqueCount FROM forska.judgments'

  const [countsResult, uniqueResult] = await Promise.all([
    client.query({query: countsQuery, format: 'JSONEachRow'}),
    client.query({query: uniqueQuery, format: 'JSONEachRow'}),
  ])

  const countsRows = await countsResult.json<Record<string, string | number | null>>()
  const countsRow = Array.isArray(countsRows) ? countsRows[0] : countsRows

  const uniqueRows = await uniqueResult.json<{uniqueCount: string | number | null}>()
  const uniqueRow = Array.isArray(uniqueRows) ? uniqueRows[0] : uniqueRows

  const totalCount = toNumber(countsRow?.['totalCount'])
  const activeCount = toNumber(countsRow?.['activeCount'] ?? totalCount)
  const deletedCount = toNumber(countsRow?.['deletedCount'] ?? 0)
  const uniqueCount = uniqueRow ? toNumber(uniqueRow.uniqueCount) : null
  const maxCursorAt = toNullableString(countsRow?.['maxCursorAt'])

  return {totalCount, activeCount, deletedCount, uniqueCount, cursorCol, maxCursorAt}
}

const runClickhouseCountsJob = async (input: {
  statsId: SyncStatsId
  table: 'articles' | 'judgments'
  includeUniqueExact: boolean
}): Promise<void> => {
  const db = getDatabase()
  const now = new Date()
  const stats = await fetchClickhouseTableStats({table: input.table, includeUniqueExact: input.includeUniqueExact})

  await db
    .update(pgChSyncStats)
    .set({
      totalCount: stats.totalCount,
      activeCount: stats.activeCount,
      deletedCount: stats.deletedCount,
      uniqueCount: stats.uniqueCount,
      uniqueCountAt: stats.uniqueCount !== null ? now : null,
      watermarkCursorCol: stats.cursorCol,
      maxCursorAt: stats.maxCursorAt,
      jobCurrentBatch: 1,
      jobRowsCounted: stats.totalCount,
      lastUpdatedAt: now,
    })
    .where(eq(pgChSyncStats.id, input.statsId))
}

const getJobsSnapshot = async () => {
  const db = getDatabase()
  const rows = await db
    .select({
      id: pgChSyncStats.id,
      status: pgChSyncStats.jobStatus,
      currentBatch: pgChSyncStats.jobCurrentBatch,
      rowsCounted: pgChSyncStats.jobRowsCounted,
      startedAt: pgChSyncStats.jobStartedAt,
      completedAt: pgChSyncStats.jobCompletedAt,
      error: pgChSyncStats.jobError,
      lastHeartbeatAt: pgChSyncStats.lastUpdatedAt,
    })
    .from(pgChSyncStats)
    .where(
      sql`${pgChSyncStats.id} IN (${sql.join(
        SYNC_STATS_IDS.map((id) => {
          return sql`${id}`
        }),
        sql`, `,
      )})`,
    )

  return rows.reduce(
    (acc, row) => {
      return {
        ...acc,
        [row.id]: {
          status: row.status,
          currentBatch: row.currentBatch ?? null,
          rowsCounted: row.rowsCounted ?? null,
          startedAt: row.startedAt?.toISOString() ?? null,
          completedAt: row.completedAt?.toISOString() ?? null,
          error: row.error ?? null,
          lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
        },
      }
    },
    {} as Record<string, unknown>,
  )
}

const getStatsRowsById = async (): Promise<Record<SyncStatsId, typeof pgChSyncStats.$inferSelect>> => {
  const db = getDatabase()
  const rows = await db
    .select()
    .from(pgChSyncStats)
    .where(
      sql`${pgChSyncStats.id} IN (${sql.join(
        SYNC_STATS_IDS.map((id) => {
          return sql`${id}`
        }),
        sql`, `,
      )})`,
    )

  return rows.reduce(
    (acc, row) => {
      return {...acc, [row.id as SyncStatsId]: row}
    },
    {} as Record<SyncStatsId, typeof pgChSyncStats.$inferSelect>,
  )
}

const getSyncDiff = (pgUnique: number | null, chUnique: number | null) => {
  const pg = pgUnique ?? 0
  const ch = chUnique ?? 0
  const absolute = pg - ch
  const percentage = pg > 0 ? (absolute / pg) * 100 : 0
  const direction = absolute === 0 ? 'synced' : absolute > 0 ? 'pg_ahead' : 'ch_ahead'
  return {absolute, percentage, direction}
}

const getSyncStatusLabel = (input: {
  lagSeconds: number | null
  uniqueDiffPct: number
  dedupDrift: number
  reachable: boolean
}) => {
  if (!input.reachable) return 'unreachable'

  const lagAbs = input.lagSeconds === null ? 0 : Math.abs(input.lagSeconds)
  const diffAbs = Math.abs(input.uniqueDiffPct)

  if (lagAbs < 3600 && diffAbs < 2 && input.dedupDrift < 100) return 'synced'
  if (input.dedupDrift > 1000) return 'merge_pending'
  if (lagAbs > 6 * 3600 || diffAbs > 5) return 'critical'
  return lagAbs >= 3600 || diffAbs >= 2 ? 'behind' : 'synced'
}

const runJobInBackground = (promise: Promise<void>, statsId: SyncStatsId) => {
  void promise.then(
    () => {
      return setJobCompleted(statsId)
    },
    (error) => {
      return setJobError(statsId, error)
    },
  )
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
  const judgmentsCursorCol =
    input.table === 'judgments'
      ? (await hasClickhouseColumn('forska', 'judgments', 'updatedAt'))
        ? 'updatedAt'
        : 'createdAt'
      : null

  const chQuery =
    input.table === 'articles'
      ? `
          SELECT
            id,
            argMax(article_title, updated_at) as articleTitle
          FROM forska.articles
          WHERE id IN ({ids:Array(String)})
          GROUP BY id
        `
      : `
          SELECT
            id,
            argMax(articleId, ${judgmentsCursorCol}) as articleId,
            argMax(promptId, ${judgmentsCursorCol}) as promptId,
            argMax(modelId, ${judgmentsCursorCol}) as modelId,
            argMax(useTitle, ${judgmentsCursorCol}) as useTitle,
            argMax(useAbstract, ${judgmentsCursorCol}) as useAbstract,
            argMax(useFulltext, ${judgmentsCursorCol}) as useFulltext,
            argMax(useFulltextNoImages, ${judgmentsCursorCol}) as useFulltextNoImages,
            argMax(answeredOriginal, ${judgmentsCursorCol}) as answeredOriginal,
            argMax(explanation, ${judgmentsCursorCol}) as explanation
          FROM forska.judgments
          WHERE id IN ({ids:Array(String)})
          GROUP BY id
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
      const next = pg && ch ? acc.concat(getFieldMismatches(input.table, id, pg, ch)) : acc
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
  const chCursorCol = input.table === 'articles' ? 'created_at' : 'createdAt'
  const chCountsResult = await client.query({
    query: `
      SELECT
        formatDateTime(toTimeZone(${chCursorCol}, 'UTC'), '%Y-%m') as month,
        count() as count
      FROM forska.${input.table}
      WHERE ${chCursorCol} >= now64(3, 'UTC') - INTERVAL {months:Int32} MONTH
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
  .use(requireAdminAuth())
  .get('/api/admin/sync-stats', async () => {
    await ensurePgChSyncStatsSeeded()

    const byId = await getStatsRowsById()
    const clickhouseReachable = await pingClickhouse(2000)

    const pgArticles = byId.pg_articles
    const chArticles = byId.ch_articles
    const pgJudgments = byId.pg_judgments
    const chJudgments = byId.ch_judgments

    const articlesDiff = getSyncDiff(
      pgArticles.uniqueCount ?? pgArticles.activeCount,
      chArticles.uniqueCount ?? chArticles.activeCount,
    )
    const judgmentsDiff = getSyncDiff(
      pgJudgments.uniqueCount ?? pgJudgments.activeCount,
      chJudgments.uniqueCount ?? chJudgments.activeCount,
    )

    const articlesLagSeconds =
      pgArticles.watermarkCursorCol === chArticles.watermarkCursorCol
        ? toLagSeconds(pgArticles.maxCursorAt, chArticles.maxCursorAt)
        : null
    const judgmentsLagSeconds =
      pgJudgments.watermarkCursorCol === chJudgments.watermarkCursorCol
        ? toLagSeconds(pgJudgments.maxCursorAt, chJudgments.maxCursorAt)
        : null

    const articlesDedupDrift =
      chArticles.uniqueCount !== null ? Math.max(0, (chArticles.totalCount ?? 0) - (chArticles.uniqueCount ?? 0)) : 0
    const judgmentsDedupDrift =
      chJudgments.uniqueCount !== null ? Math.max(0, (chJudgments.totalCount ?? 0) - (chJudgments.uniqueCount ?? 0)) : 0

    const jobs = await getJobsSnapshot()

    return {
      stats: {
        articles: {
          pg: {
            total: pgArticles.totalCount,
            active: pgArticles.activeCount,
            deleted: pgArticles.deletedCount,
            uniqueCount: pgArticles.uniqueCount,
            uniqueCountAt: pgArticles.uniqueCountAt?.toISOString() ?? null,
            cursorCol: pgArticles.watermarkCursorCol,
            maxCursorAt: pgArticles.maxCursorAt,
          },
          ch: {
            total: chArticles.totalCount,
            active: chArticles.activeCount,
            deleted: chArticles.deletedCount,
            uniqueCount: chArticles.uniqueCount,
            uniqueCountAt: chArticles.uniqueCountAt?.toISOString() ?? null,
            cursorCol: chArticles.watermarkCursorCol,
            maxCursorAt: chArticles.maxCursorAt,
            dedupDrift: articlesDedupDrift,
          },
          diff: articlesDiff,
          lag: {seconds: articlesLagSeconds},
          status: getSyncStatusLabel({
            lagSeconds: articlesLagSeconds,
            uniqueDiffPct: articlesDiff.percentage,
            dedupDrift: articlesDedupDrift,
            reachable: clickhouseReachable,
          }),
        },
        judgments: {
          pg: {
            total: pgJudgments.totalCount,
            active: pgJudgments.activeCount,
            deleted: pgJudgments.deletedCount,
            uniqueCount: pgJudgments.uniqueCount,
            uniqueCountAt: pgJudgments.uniqueCountAt?.toISOString() ?? null,
            cursorCol: pgJudgments.watermarkCursorCol,
            maxCursorAt: pgJudgments.maxCursorAt,
          },
          ch: {
            total: chJudgments.totalCount,
            active: chJudgments.activeCount,
            deleted: chJudgments.deletedCount,
            uniqueCount: chJudgments.uniqueCount,
            uniqueCountAt: chJudgments.uniqueCountAt?.toISOString() ?? null,
            cursorCol: chJudgments.watermarkCursorCol,
            maxCursorAt: chJudgments.maxCursorAt,
            dedupDrift: judgmentsDedupDrift,
          },
          diff: judgmentsDiff,
          lag: {seconds: judgmentsLagSeconds},
          status: getSyncStatusLabel({
            lagSeconds: judgmentsLagSeconds,
            uniqueDiffPct: judgmentsDiff.percentage,
            dedupDrift: judgmentsDedupDrift,
            reachable: clickhouseReachable,
          }),
        },
      },
      jobs,
      clickhouse: {reachable: clickhouseReachable},
    }
  })
  .post(
    '/api/admin/refresh-sync-stats',
    async ({body}) => {
      await ensurePgChSyncStatsSeeded()

      const tables = body?.tables?.length ? body.tables : SYNC_STATS_IDS
      const fullRecount = body?.fullRecount ?? false
      const includeUniqueCount = body?.includeUniqueCount ?? false

      const normalized = tables.filter((t): t is SyncStatsId => {
        return (SYNC_STATS_IDS as readonly string[]).includes(t)
      })

      const startForId = async (id: SyncStatsId) => {
        const started = await setJobRunning(id)
        if (!started.started) return started

        if (fullRecount) {
          await resetSyncStatsRow(id)
        }

        const job =
          id === 'pg_articles'
            ? runPgCountsJob({
                statsId: id,
                tableName: 'articles',
                hasDeletedAt: false,
                cursorColName: 'updated_at',
                cursorLabel: 'updated_at',
                fullRecount,
              })
            : id === 'pg_judgments'
              ? runPgCountsJob({
                  statsId: id,
                  tableName: 'judgments',
                  hasDeletedAt: true,
                  cursorColName: 'updated_at',
                  cursorLabel: 'updatedAt',
                  fullRecount,
                })
              : id === 'ch_articles'
                ? runClickhouseCountsJob({statsId: id, table: 'articles', includeUniqueExact: includeUniqueCount})
                : runClickhouseCountsJob({statsId: id, table: 'judgments', includeUniqueExact: includeUniqueCount})

        runJobInBackground(job, id)
        return {started: true}
      }

      const results = await Promise.all(
        normalized.map((id) => {
          return startForId(id).then((r) => {
            return {id, ...r}
          })
        }),
      )

      const anyStarted = results.some((r) => {
        return r.started
      })

      return {started: anyStarted, results}
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
    await ensurePgChSyncStatsSeeded()
    const jobs = await getJobsSnapshot()
    return {jobs}
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
