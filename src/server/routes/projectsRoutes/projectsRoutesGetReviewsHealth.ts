import {and, eq, inArray, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, importRoute, projectArticles, projectPrompts, projectRouteLink} from '../../../db/schema.ts'
import {getClickhouseClient} from '../../../services/clickhouse/clickhouseClient.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

const escapeClickHouseString = (value: string): string => {
  return value.replace(/'/g, "''").replace(/\\/g, '\\\\')
}

const getEnabledPromptCount = async (projectId: string): Promise<number> => {
  const db = getDatabase()

  const rows = await db
    .select({count: sql<number>`COUNT(*)::int`.as('count')})
    .from(projectPrompts)
    .where(and(eq(projectPrompts.projectId, projectId), eq(projectPrompts.enabled, true)))

  return rows[0]?.count ?? 0
}

const getCuratedArticleCount = async (projectId: string): Promise<number> => {
  const db = getDatabase()

  const rows = await db
    .select({count: sql<number>`COUNT(*)::int`.as('count')})
    .from(projectArticles)
    .where(eq(projectArticles.projectId, projectId))

  return rows[0]?.count ?? 0
}

const getImportRoutes = async (projectId: string): Promise<string[]> => {
  const db = getDatabase()

  const rows = await db
    .select({route: importRoute.route})
    .from(projectRouteLink)
    .innerJoin(importRoute, eq(projectRouteLink.importRouteId, importRoute.id))
    .where(eq(projectRouteLink.projectId, projectId))

  return rows
    .map((r) => {
      return r.route
    })
    .filter((r): r is string => {
      return typeof r === 'string' && r.trim() !== ''
    })
}

const getImportRouteArticlesCount = async (routes: string[]): Promise<number> => {
  const db = getDatabase()

  if (routes.length === 0) {
    return 0
  }

  const rows = await db
    .select({count: sql<number>`COUNT(*)::int`.as('count')})
    .from(articles)
    .where(inArray(articles.importRoute, routes))

  return rows[0]?.count ?? 0
}

const getPostgresArticlesInScope = async (projectId: string, curatedCount: number, routes: string[]) => {
  const hasCurated = curatedCount > 0
  const hasRoutes = routes.length > 0
  const db = getDatabase()

  if (!hasCurated && !hasRoutes) {
    return 0
  }

  if (hasCurated && !hasRoutes) {
    const rows = await db
      .select({count: sql<number>`COUNT(DISTINCT ${projectArticles.articleId})::int`.as('count')})
      .from(projectArticles)
      .where(eq(projectArticles.projectId, projectId))

    return rows[0]?.count ?? 0
  }

  if (!hasCurated && hasRoutes) {
    const rows = await db
      .select({count: sql<number>`COUNT(*)::int`.as('count')})
      .from(articles)
      .where(inArray(articles.importRoute, routes))

    return rows[0]?.count ?? 0
  }

  const hasProjectArticle = sql`EXISTS (
    SELECT 1 FROM ${projectArticles} pa
    WHERE pa."article_id" = ${articles.id}
      AND pa."project_id" = ${projectId}::uuid
  )`

  const rows = await db
    .select({count: sql<number>`COUNT(DISTINCT ${articles.id})::int`.as('count')})
    .from(articles)
    .where(or(hasProjectArticle, inArray(articles.importRoute, routes)))

  return rows[0]?.count ?? 0
}

const getCuratedSampleIds = async (projectId: string, sampleSize: number): Promise<string[]> => {
  const db = getDatabase()

  const rows = await db
    .select({articleId: projectArticles.articleId})
    .from(projectArticles)
    .where(eq(projectArticles.projectId, projectId))
    .limit(sampleSize)

  return rows
    .map((r) => {
      return r.articleId
    })
    .filter((id): id is string => {
      return typeof id === 'string' && id.trim() !== ''
    })
}

const countClickhouseArticlesByRoutes = async (routes: string[]): Promise<number> => {
  if (routes.length === 0) {
    return 0
  }

  const client = getClickhouseClient()
  const routesQuoted = routes
    .map((r) => {
      return `'${escapeClickHouseString(r)}'`
    })
    .join(', ')

  const query = `
    SELECT count() AS count
    FROM forska.articles FINAL
    WHERE _peerdb_is_deleted = 0
      AND import_route IN (${routesQuoted})
  `

  const result = await client.query({query, format: 'JSONEachRow'})
  const data = await result.json<{count: string | number}>()
  const raw = data[0]?.count ?? 0
  return typeof raw === 'number' ? raw : parseInt(raw, 10) || 0
}

const countClickhouseArticlesByIds = async (ids: string[]): Promise<number> => {
  if (ids.length === 0) {
    return 0
  }

  const client = getClickhouseClient()
  const idsQuoted = ids
    .map((id) => {
      return `'${escapeClickHouseString(id)}'`
    })
    .join(', ')

  const query = `
    SELECT count() AS count
    FROM forska.articles FINAL
    WHERE _peerdb_is_deleted = 0
      AND id IN (${idsQuoted})
  `

  const result = await client.query({query, format: 'JSONEachRow'})
  const data = await result.json<{count: string | number}>()
  const raw = data[0]?.count ?? 0
  return typeof raw === 'number' ? raw : parseInt(raw, 10) || 0
}

export const projectsRoutesGetReviewsHealth = new Elysia().post(
  '/api/projectsreviewshealth',
  async ({body}) => {
    const projectId = body.projectId

    const [enabledPromptCount, curatedArticleCount, importRoutes] = await Promise.all([
      getEnabledPromptCount(projectId),
      getCuratedArticleCount(projectId),
      getImportRoutes(projectId),
    ])

    const importRouteArticlesCount = await getImportRouteArticlesCount(importRoutes)
    const postgresArticlesInScope = await getPostgresArticlesInScope(projectId, curatedArticleCount, importRoutes)

    const curatedSampleSize = curatedArticleCount > 0 ? 25 : 0
    const curatedSampleIds = curatedSampleSize > 0 ? await getCuratedSampleIds(projectId, curatedSampleSize) : []

    const clickhouse = await (async () => {
      try {
        const [routeArticlesInScope, curatedSampleFound] = await Promise.all([
          countClickhouseArticlesByRoutes(importRoutes),
          countClickhouseArticlesByIds(curatedSampleIds),
        ])

        return {ok: true as const, routeArticlesInScope, curatedSampleSize: curatedSampleIds.length, curatedSampleFound}
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : 'ClickHouse query failed',
          routeArticlesInScope: 0,
          curatedSampleSize: curatedSampleIds.length,
          curatedSampleFound: 0,
        }
      }
    })()

    return {
      data: {
        projectId,
        enabledPromptCount,
        scope: {curatedArticleCount, importRoutes, importRouteArticlesCount, postgresArticlesInScope},
        clickhouse,
      },
    }
  },
  {body: t.Object({projectId: t.String()})},
)
