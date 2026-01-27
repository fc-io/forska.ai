import {asc, desc, eq, sql} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {articles, importRoute as importRouteTable} from '../../db/schema.ts'
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

const importRouteKey = (route: string | null): string => {
  return route ?? '__null__'
}

const compareImportRoutes = (a: string | null, b: string | null): number => {
  const rankA = a ? 0 : 1
  const rankB = b ? 0 : 1
  return rankA !== rankB ? rankA - rankB : String(a ?? '').localeCompare(String(b ?? ''))
}

const buildImportRouteStats = async (): Promise<ImportRouteStats[]> => {
  const db = getDatabase()
  const yearExpr = sql<number>`EXTRACT(YEAR FROM COALESCE(${articles.articleCreatedAt}, ${articles.createdAt}))::int`

  const totals = await db
    .select({
      importRoute: articles.importRoute,
      importRouteName: importRouteTable.name,
      total: sql<number>`COUNT(*)::int`.as('total'),
    })
    .from(articles)
    .leftJoin(importRouteTable, eq(importRouteTable.route, articles.importRoute))
    .groupBy(articles.importRoute, importRouteTable.name)
    .orderBy(asc(articles.importRoute))

  const yearlyCounts = await db
    .select({
      importRoute: articles.importRoute,
      importRouteName: importRouteTable.name,
      year: yearExpr.as('year'),
      count: sql<number>`COUNT(*)::int`.as('count'),
    })
    .from(articles)
    .leftJoin(importRouteTable, eq(importRouteTable.route, articles.importRoute))
    .groupBy(articles.importRoute, importRouteTable.name, yearExpr)
    .orderBy(asc(articles.importRoute), desc(yearExpr))

  const byRoute = totals.reduce((map, row) => {
    map.set(importRouteKey(row.importRoute), {...row, years: []})
    return map
  }, new Map<string, ImportRouteStats>())

  const withYears = yearlyCounts.reduce((map, row) => {
    const key = importRouteKey(row.importRoute)
    const existing = map.get(key)
    const updated = existing
      ? existing
      : {importRoute: row.importRoute, importRouteName: row.importRouteName, total: 0, years: []}
    const years = [...updated.years, {year: row.year, count: row.count}]
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
    const data = await buildImportRouteStats()
    return {data}
  })
