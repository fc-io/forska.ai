import {sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'
import {Client} from 'pg'

import {articles, judgments} from '../../db/schema.ts'
import {getClickhouseClient, pingClickhouse} from '../../services/clickhouse/clickhouseClient.ts'
import {ensureClickhouseSchema} from '../../services/clickhouse/ensureClickhouseSchema.ts'
import {requireAdminAuth} from '../utils/authGuard.ts'
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

const getPeerdbMirrorName = (): string => {
  const raw = String(process.env['PEERDB_MIRROR_NAME'] ?? '').trim()
  return raw ? raw : 'forska_pg_to_ch_cdc'
}

const getPeerdbConnectionConfig = () => {
  const host = String(process.env['PEERDB_HOST'] ?? 'localhost').trim() || 'localhost'
  const port = toNumber(process.env['PEERDB_PORT'] ?? '9900') || 9900
  const user = String(process.env['PEERDB_USER'] ?? 'peerdb').trim() || 'peerdb'
  const password = String(process.env['PEERDB_PASSWORD'] ?? 'peerdb')
  return {host, port, user, password, database: user}
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
    console.error('[PeerDB] Health check failed:', error)
    await client.end().catch(() => {})
    return {mirrorName, reachable: false, exists: false, status: 'unreachable'}
  }
}

const getPeerdbSlotName = (): string => {
  const raw = String(process.env['PEERDB_SLOT'] ?? '').trim()
  return raw ? raw : 'peerdb_slot'
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
  const result = await db.execute<{count: string | number; max_updated_at: Date | null}>(sql`
    SELECT
      COUNT(*)::text AS count,
      MAX(updated_at) AS max_updated_at
    FROM ${sql.identifier(table)} ${where}
  `)

  const row = result.rows[0]
  return row
    ? {count: toNumber(row.count), maxUpdatedAtMs: toMsOrNull(row.max_updated_at)}
    : {count: 0, maxUpdatedAtMs: null}
}

type ClickhouseTableStats = {
  totalCount: number
  maxUpdatedAtMs: number | null
  liveCount: number
  liveMaxUpdatedAtMs: number | null
  dedupDrift: number
}

const getClickhouseTableStats = async (table: 'articles' | 'judgments'): Promise<ClickhouseTableStats> => {
  const client = getClickhouseClient()
  const targetTable = table === 'articles' ? 'articles' : 'judgments_raw'
  const liveWhere =
    table === 'articles' ? 'WHERE _peerdb_is_deleted = 0' : 'WHERE deleted_at IS NULL AND _peerdb_is_deleted = 0'

  const [rawResult, liveResult] = await Promise.all([
    client.query({
      query: `
        SELECT
          count() as totalCount,
          if(count() = 0, NULL, toUnixTimestamp64Milli(max(updated_at))) as maxUpdatedAtMs
        FROM forska.${targetTable}
      `,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT
          count() as liveCount,
          if(count() = 0, NULL, toUnixTimestamp64Milli(max(updated_at))) as liveMaxUpdatedAtMs
        FROM forska.${targetTable} FINAL
        ${liveWhere}
      `,
      format: 'JSONEachRow',
    }),
  ])

  const rawRow = await rawResult.json<{totalCount: string | number; maxUpdatedAtMs: string | number | null}>()
  const liveRow = await liveResult.json<{liveCount: string | number; liveMaxUpdatedAtMs: string | number | null}>()

  const totalCount = toNumber((Array.isArray(rawRow) ? rawRow[0] : rawRow)?.totalCount)
  const maxUpdatedAtMs = toMsOrNull((Array.isArray(rawRow) ? rawRow[0] : rawRow)?.maxUpdatedAtMs)
  const liveCount = toNumber((Array.isArray(liveRow) ? liveRow[0] : liveRow)?.liveCount)
  const liveMaxUpdatedAtMs = toMsOrNull((Array.isArray(liveRow) ? liveRow[0] : liveRow)?.liveMaxUpdatedAtMs)
  const dedupDrift = Math.max(0, totalCount - liveCount)

  return {totalCount, maxUpdatedAtMs, liveCount, liveMaxUpdatedAtMs, dedupDrift}
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
          WHERE id IN ({ids:Array(UUID)}) AND _peerdb_is_deleted = 0
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
          WHERE id IN ({ids:Array(UUID)}) AND deleted_at IS NULL AND _peerdb_is_deleted = 0
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
  .use(requireAdminAuth())
  .get('/api/admin/sync-stats', async () => {
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
      data: {
        queriedAt: new Date().toISOString(),
        replication: {peerdb, postgres: {slot: postgresSlot}, clickhouse: clickhouseMergeParts},
        stats: {articles, judgments},
      },
    }
  })
  .post(
    '/api/admin/refresh-sync-stats',
    async () => {
      return {started: true}
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
