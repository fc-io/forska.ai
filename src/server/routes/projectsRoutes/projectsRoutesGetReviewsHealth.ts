import {and, eq, inArray, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, importRoute, projectArticles, projectPrompts, projectRouteLink} from '../../../db/schema.ts'
import {getClickhouseClient} from '../../../services/clickhouse/clickhouseClient.ts'
import {getDatabase} from '../../utils/getDatabase.ts'

const CURATED_ARTICLES_TEMP_TABLE_THRESHOLD = 1000
const TEMP_TABLE_INSERT_BATCH_SIZE = 10000

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
    .select({count: sql<number>`COUNT(DISTINCT ${projectArticles.articleId})::int`.as('count')})
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

type TempTableInfo = {tableName: string; cleanup: () => Promise<void>}

const getCuratedArticleIds = async (projectId: string): Promise<string[]> => {
  const db = getDatabase()

  const rows = await db
    .select({articleId: projectArticles.articleId})
    .from(projectArticles)
    .where(eq(projectArticles.projectId, projectId))

  return rows
    .map((r) => {
      return r.articleId
    })
    .filter((id): id is string => {
      return typeof id === 'string' && id.trim() !== ''
    })
}

const createTempTable = async (articleIds: string[]): Promise<TempTableInfo> => {
  const client = getClickhouseClient()
  const tableName = `temp_reviews_health_${Date.now()}_${Math.random().toString(36).substring(7)}`

  await client.command({query: `CREATE TABLE ${tableName} (articleId String) ENGINE = Memory`})

  const insertBatch = async (offset: number): Promise<void> => {
    const batch = articleIds.slice(offset, offset + TEMP_TABLE_INSERT_BATCH_SIZE)
    if (batch.length === 0) {
      return
    }

    await client.insert({
      table: tableName,
      values: batch.map((id) => {
        return {articleId: id}
      }),
      format: 'JSONEachRow',
    })

    return insertBatch(offset + TEMP_TABLE_INSERT_BATCH_SIZE)
  }

  await insertBatch(0)

  const cleanup = async () => {
    await client.command({query: `DROP TABLE IF EXISTS ${tableName}`}).catch(() => {
      return
    })
  }

  return {tableName, cleanup}
}

const countClickhouseCuratedArticles = async (curatedIds: string[]): Promise<number> => {
  if (curatedIds.length === 0) {
    return 0
  }

  const client = getClickhouseClient()
  const useTempTable = curatedIds.length > CURATED_ARTICLES_TEMP_TABLE_THRESHOLD
  const tempTableInfo = useTempTable ? await createTempTable(curatedIds) : null

  try {
    const wherePart = tempTableInfo
      ? `id IN (SELECT articleId FROM ${tempTableInfo.tableName})`
      : `id IN (${curatedIds
          .map((id) => {
            return `'${escapeClickHouseString(id)}'`
          })
          .join(', ')})`

    const query = `
      SELECT count() AS count
      FROM forska.articles FINAL
      WHERE _peerdb_is_deleted = 0
        AND ${wherePart}
    `

    const result = await client.query({query, format: 'JSONEachRow'})
    const data = await result.json<{count: string | number}>()
    const raw = data[0]?.count ?? 0
    return typeof raw === 'number' ? raw : parseInt(raw, 10) || 0
  } finally {
    if (tempTableInfo) {
      await tempTableInfo.cleanup()
    }
  }
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

    const shouldSkipClickhouse = enabledPromptCount === 0 || postgresArticlesInScope === 0

    const clickhouse = await (async () => {
      if (shouldSkipClickhouse) {
        return {ok: true as const, skipped: true as const, routeArticlesInScope: 0, curatedArticlesInScope: null}
      }

      try {
        const routeArticlesInScope = await countClickhouseArticlesByRoutes(importRoutes)
        const needsCuratedFullCheck =
          curatedArticleCount > 0 && importRouteArticlesCount === 0 && routeArticlesInScope === 0
        const curatedArticlesInScope = needsCuratedFullCheck
          ? await (async () => {
              const curatedIds = await getCuratedArticleIds(projectId)
              return countClickhouseCuratedArticles(curatedIds)
            })()
          : null

        return {ok: true as const, skipped: false as const, routeArticlesInScope, curatedArticlesInScope}
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : 'ClickHouse query failed',
          routeArticlesInScope: 0,
          curatedArticlesInScope: null,
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
