import {Elysia, t} from 'elysia'

import {importRoute as importRouteTable} from '../../db/schema.ts'
import {getClickhouseClient} from '../../services/clickhouse/clickhouseClient.ts'
import {ensureClickhouseSchema} from '../../services/clickhouse/ensureClickhouseSchema.ts'
import {requireAdminAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

type ImportRouteYearCount = {year: number; count: number}

type ImportRouteStats = {
  importRoute: string | null
  importRouteName: string | null
  total: number
  years: ImportRouteYearCount[]
}

type ImportRouteStatsYearArticle = {
  id: string
  articleTitle: string | null
  articleId: string | null
  importRoute: string | null
  importRouteName: string | null
  date: string
}

type ImportRouteStatsYearArticles = {year: number; total: number; articles: ImportRouteStatsYearArticle[]}

type ClickhouseImportRouteTotalRow = {importRoute: string | null; total: string | number}

type ClickhouseImportRouteYearRow = {importRoute: string | null; year: string | number; count: string | number}

type ClickhouseYearCountRow = {total: string | number}

type ClickhouseImportRouteStatsYearArticleRow = {
  id: string
  articleTitle: string | null
  articleId: string | null
  importRoute: string | null
  date: string
}

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return parseInt(value, 10) || 0
  return typeof value === 'bigint' ? Number(value) : 0
}

const toRows = <T>(value: T | T[]): T[] => {
  return Array.isArray(value) ? value : [value]
}

const importRouteKey = (route: string | null): string => {
  return route ?? '__null__'
}

const parseYear = (value: string): number => {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error('Invalid year')
  }
  if (parsed < 1800 || parsed > 3000) {
    throw new Error('Invalid year')
  }
  return parsed
}

const compareImportRoutes = (a: string | null, b: string | null): number => {
  const rankA = a ? 0 : 1
  const rankB = b ? 0 : 1
  return rankA !== rankB ? rankA - rankB : String(a ?? '').localeCompare(String(b ?? ''))
}

const fetchImportRouteNameMap = async (): Promise<Map<string, string | null>> => {
  const db = getDatabase()
  const rows = await db.select({route: importRouteTable.route, name: importRouteTable.name}).from(importRouteTable)

  return rows.reduce((map, row) => {
    map.set(row.route, row.name)
    return map
  }, new Map<string, string | null>())
}

const getImportRouteName = (nameMap: Map<string, string | null>, importRoute: string | null): string | null => {
  return importRoute ? (nameMap.get(importRoute) ?? null) : null
}

const buildImportRouteStatsFromClickhouse = async (): Promise<ImportRouteStats[]> => {
  await ensureClickhouseSchema()
  const client = getClickhouseClient()

  const [nameMap, totalsResult, yearlyResult] = await Promise.all([
    fetchImportRouteNameMap(),
    client.query({
      query: `
        SELECT
          import_route AS importRoute,
          count() AS total
        FROM forska.articles FINAL
        WHERE _peerdb_is_deleted = 0
        GROUP BY import_route
        ORDER BY import_route
      `,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT
          import_route AS importRoute,
          toInt32(toYear(coalesce(article_created_at, created_at))) AS year,
          count() AS count
        FROM forska.articles FINAL
        WHERE _peerdb_is_deleted = 0
        GROUP BY import_route, year
        ORDER BY import_route, year DESC
      `,
      format: 'JSONEachRow',
    }),
  ])

  const totalsRows = toRows(await totalsResult.json<ClickhouseImportRouteTotalRow>())
  const yearRows = toRows(await yearlyResult.json<ClickhouseImportRouteYearRow>())

  const byRoute = totalsRows.reduce((map, row) => {
    const importRoute = row.importRoute ?? null
    const importRouteName = getImportRouteName(nameMap, importRoute)
    map.set(importRouteKey(importRoute), {importRoute, importRouteName, total: toNumber(row.total), years: []})
    return map
  }, new Map<string, ImportRouteStats>())

  const withYears = yearRows.reduce((map, row) => {
    const importRoute = row.importRoute ?? null
    const key = importRouteKey(importRoute)
    const existing = map.get(key)
    const updated = existing
      ? existing
      : {importRoute, importRouteName: getImportRouteName(nameMap, importRoute), total: 0, years: []}
    const years = [...updated.years, {year: toNumber(row.year), count: toNumber(row.count)}]
    map.set(key, {...updated, years})
    return map
  }, byRoute)

  return [...withYears.values()]
    .map((row) => {
      const years = [...row.years].sort((a, b) => {
        return b.year - a.year
      })
      return {...row, years}
    })
    .sort((a, b) => {
      return compareImportRoutes(a.importRoute, b.importRoute)
    })
}

const buildYearArticlesFromClickhouse = async (year: number): Promise<ImportRouteStatsYearArticles> => {
  await ensureClickhouseSchema()
  const client = getClickhouseClient()

  const [nameMap, countResult, listResult] = await Promise.all([
    fetchImportRouteNameMap(),
    client.query({
      query: `
        SELECT
          count() AS total
        FROM forska.articles FINAL
        WHERE _peerdb_is_deleted = 0
          AND toInt32(toYear(coalesce(article_created_at, created_at))) = {year:Int32}
      `,
      query_params: {year},
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT
          toString(id) AS id,
          article_title AS articleTitle,
          article_id AS articleId,
          import_route AS importRoute,
          formatDateTime(toTimeZone(coalesce(article_created_at, created_at), 'UTC'), '%Y-%m-%dT%H:%M:%SZ') AS date
        FROM forska.articles FINAL
        WHERE _peerdb_is_deleted = 0
          AND toInt32(toYear(coalesce(article_created_at, created_at))) = {year:Int32}
        ORDER BY coalesce(article_created_at, created_at) ASC, created_at ASC, id ASC
        LIMIT 200
      `,
      query_params: {year},
      format: 'JSONEachRow',
    }),
  ])

  const countRows = toRows(await countResult.json<ClickhouseYearCountRow>())
  const countRow = countRows[0]
  const total = toNumber(countRow?.total)

  const rows = toRows(await listResult.json<ClickhouseImportRouteStatsYearArticleRow>())
  const articles = rows.map((row) => {
    const importRoute = row.importRoute ?? null
    return {
      id: row.id,
      articleTitle: row.articleTitle,
      articleId: row.articleId,
      importRoute,
      importRouteName: getImportRouteName(nameMap, importRoute),
      date: row.date,
    }
  })

  return {year, total, articles}
}

export const adminImportRouteStatsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireAdminAuth())
  .get('/api/admin/import-route-stats', async () => {
    const data = await buildImportRouteStatsFromClickhouse()
    return {data}
  })
  .get(
    '/api/admin/import-route-stats/year-articles',
    async ({query}) => {
      const year = parseYear(query.year)
      const data = await buildYearArticlesFromClickhouse(year)
      return {data}
    },
    {query: t.Object({year: t.String()})},
  )
