import {sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, judgments} from '../../db/schema.ts'
import {getClickhouseClient, pingClickhouse} from '../../services/clickhouse/clickhouseClient.ts'
import {ensureClickhouseSchema} from '../../services/clickhouse/ensureClickhouseSchema.ts'
import {requireAdminAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

type LegacySyncStatsResponse = {legacy: true; message: string; clickhouse: {reachable: boolean}}

type LegacyRefreshResponse = {
  legacy: true
  started: false
  results: Array<{id: string; started: false; reason: string}>
}

type LegacyProgressResponse = {legacy: true; jobs: Record<string, never>}

const LEGACY_SYNC_MESSAGE = 'Manual PG→ClickHouse sync stats removed. Replication is handled by PeerDB.'

const getLegacySyncStatsResponse = async (): Promise<LegacySyncStatsResponse> => {
  const reachable = await pingClickhouse(2000)
  return {legacy: true, message: LEGACY_SYNC_MESSAGE, clickhouse: {reachable}}
}

const getLegacyRefreshResponse = (): LegacyRefreshResponse => {
  return {
    legacy: true,
    started: false,
    results: [{id: 'legacy_sync_stats', started: false, reason: LEGACY_SYNC_MESSAGE}],
  }
}

const getLegacyProgressResponse = (): LegacyProgressResponse => {
  return {legacy: true, jobs: {}}
}

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return parseInt(value, 10) || 0
  return typeof value === 'bigint' ? Number(value) : 0
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
            id,
            argMax(article_title, _peerdb_version) as articleTitle,
            argMax(_peerdb_is_deleted, _peerdb_version) as isDeleted
          FROM forska.articles
          WHERE id IN ({ids:Array(String)})
          GROUP BY id
          HAVING isDeleted = 0
        `
      : `
          SELECT
            id,
            argMax(articleId, _peerdb_version) as articleId,
            argMax(promptId, _peerdb_version) as promptId,
            argMax(modelId, _peerdb_version) as modelId,
            argMax(useTitle, _peerdb_version) as useTitle,
            argMax(useAbstract, _peerdb_version) as useAbstract,
            argMax(useFulltext, _peerdb_version) as useFulltext,
            argMax(useFulltextNoImages, _peerdb_version) as useFulltextNoImages,
            argMax(answeredOriginal, _peerdb_version) as answeredOriginal,
            argMax(explanation, _peerdb_version) as explanation,
            argMax(_peerdb_is_deleted, _peerdb_version) as isDeleted
          FROM forska.judgments
          WHERE id IN ({ids:Array(String)})
          GROUP BY id
          HAVING isDeleted = 0
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
  const chCursorCol = input.table === 'articles' ? 'created_at' : 'createdAt'
  const chCountsResult = await client.query({
    query: `
      SELECT
        formatDateTime(toTimeZone(${chCursorCol}, 'UTC'), '%Y-%m') as month,
        count() as count
      FROM forska.${input.table} FINAL
      WHERE _peerdb_is_deleted = 0 AND ${chCursorCol} >= now64(3, 'UTC') - INTERVAL {months:Int32} MONTH
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
    return getLegacySyncStatsResponse()
  })
  .post(
    '/api/admin/refresh-sync-stats',
    async () => {
      return getLegacyRefreshResponse()
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
    return getLegacyProgressResponse()
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
