import {Elysia} from 'elysia'

import {importRoute as importRouteTable} from '../../db/schema.ts'
import {getClickhouseClient} from '../../services/clickhouse/clickhouseClient.ts'
import {ensureClickhouseSchema} from '../../services/clickhouse/ensureClickhouseSchema.ts'
import {requireAdminAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

type ImportRouteYearCount = {year: number; count: number; fallbackCount: number}

type ImportRouteStats = {
  importRoute: string | null
  importRouteName: string | null
  total: number
  fallbackTotal: number
  years: ImportRouteYearCount[]
}

type ClickhouseImportRouteTotalRow = {
  importRoute: string | null
  total: string | number
  fallbackCount: string | number
}

type ClickhouseImportRouteYearRow = {
  importRoute: string | null
  year: string | number
  count: string | number
  fallbackCount: string | number
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
          count() AS total,
          countIf(isNull(article_created_at)) AS fallbackCount
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
          count() AS count,
          countIf(isNull(article_created_at)) AS fallbackCount
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
    map.set(importRouteKey(importRoute), {
      importRoute,
      importRouteName,
      total: toNumber(row.total),
      fallbackTotal: toNumber(row.fallbackCount),
      years: [],
    })
    return map
  }, new Map<string, ImportRouteStats>())

  const withYears = yearRows.reduce((map, row) => {
    const importRoute = row.importRoute ?? null
    const key = importRouteKey(importRoute)
    const existing = map.get(key)
    const updated = existing
      ? existing
      : {importRoute, importRouteName: getImportRouteName(nameMap, importRoute), total: 0, fallbackTotal: 0, years: []}
    const years = [
      ...updated.years,
      {year: toNumber(row.year), count: toNumber(row.count), fallbackCount: toNumber(row.fallbackCount)},
    ]
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

export const adminImportRouteStatsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireAdminAuth())
  .get('/api/admin/import-route-stats', async () => {
    const data = await buildImportRouteStatsFromClickhouse()
    return {data}
  })
