import {and, eq, inArray, isNotNull, isNull, notExists, sql} from 'drizzle-orm'

import {articleRouteLink, articles, importRoute as importRouteTable} from '../../db/schema.ts'
import {getDatabase} from '../../server/utils/getDatabase.ts'

const BATCH_SIZE = 1000
const ARXIV_IMPORT_ROUTE_ID = 'a86bb16d-73cc-44b3-955c-1f30bc77c488'
const ARXIV_ROUTE = '/api/datasources/import/arxiv'

const fetchBatch = async (
  offset: number,
): Promise<Array<{id: string; importRoute: string}>> => {
  const db = getDatabase()
  const rows = await db
    .select({id: articles.id, importRoute: articles.importRoute})
    .from(articles)
    .where(isNotNull(articles.importRoute))
    .limit(BATCH_SIZE)
    .offset(offset)

  return rows as Array<{id: string; importRoute: string}>
}

const fetchAllArticlesWithRoute = async (
  offset = 0,
  acc: Array<{id: string; importRoute: string}> = [],
): Promise<Array<{id: string; importRoute: string}>> => {
  const batch = await fetchBatch(offset)
  return batch.length === 0 ? acc : fetchAllArticlesWithRoute(offset + batch.length, [...acc, ...batch])
}

const fetchBatchNull = async (offset: number): Promise<string[]> => {
  const db = getDatabase()
  const rows = await db
    .select({id: articles.id})
    .from(articles)
    .where(isNull(articles.importRoute))
    .limit(BATCH_SIZE)
    .offset(offset)
  return rows.map((r) => {
    return r.id
  })
}

const fetchAllArticlesWithNullRoute = async (offset = 0, acc: string[] = []): Promise<string[]> => {
  const batch = await fetchBatchNull(offset)
  return batch.length === 0 ? acc : fetchAllArticlesWithNullRoute(offset + batch.length, [...acc, ...batch])
}

const ensureImportRoutes = async (routes: string[]): Promise<Map<string, string>> => {
  const db = getDatabase()
  const uniqueRoutes = Array.from(new Set(routes.filter((r) => {
    return Boolean(r && r.trim())
  })))
  if (uniqueRoutes.length === 0) {
    return new Map()
  }

  const existing = await db
    .select({id: importRouteTable.id, route: importRouteTable.route})
    .from(importRouteTable)
    .where(inArray(importRouteTable.route, uniqueRoutes))

  const existingSet = new Set(existing.map((r) => {
    return r.route
  }))
  const missing = uniqueRoutes.filter((r) => {
    return !existingSet.has(r)
  })

  if (missing.length > 0) {
    await db
      .insert(importRouteTable)
      .values(
        missing.map((route) => {
          return {route, name: route, active: true}
        }),
      )
      .onConflictDoNothing()
  }

  const all = await db
    .select({id: importRouteTable.id, route: importRouteTable.route})
    .from(importRouteTable)
    .where(inArray(importRouteTable.route, uniqueRoutes))

  return new Map(
    all.map((r) => {
      return [r.route, r.id]
    }),
  )
}

const ensureArxivRouteId = async (): Promise<string | null> => {
  const db = getDatabase()
  const byId = await db
    .select({id: importRouteTable.id})
    .from(importRouteTable)
    .where(eq(importRouteTable.id, ARXIV_IMPORT_ROUTE_ID))
    .limit(1)
  if (byId[0]) {
    return byId[0].id
  }

  const byRoute = await db
    .select({id: importRouteTable.id})
    .from(importRouteTable)
    .where(eq(importRouteTable.route, ARXIV_ROUTE))
    .limit(1)
  if (byRoute[0]) {
    return byRoute[0].id
  }

  // Insert with requested ID; if route exists concurrently, conflict on route prevents insert
  await db
    .insert(importRouteTable)
    .values({id: ARXIV_IMPORT_ROUTE_ID, route: ARXIV_ROUTE, name: 'arXiv', active: true})
    .onConflictDoNothing()

  const [row] = await db
    .select({id: importRouteTable.id})
    .from(importRouteTable)
    .where(eq(importRouteTable.route, ARXIV_ROUTE))
    .limit(1)
  return row ? row.id : null
}

const insertLinksInChunks = async (
  rows: Array<{articleId: string; importRouteId: string}>,
  size = BATCH_SIZE,
): Promise<void> => {
  const db = getDatabase()
  const chunk = rows.slice(0, size)
  const rest = rows.slice(size)
  return chunk.length === 0
    ? undefined
    : db
        .insert(articleRouteLink)
        .values(chunk)
        .onConflictDoNothing()
        .then(async () => {
          return insertLinksInChunks(rest, size)
        })
}

const run = async (): Promise<void> => {
  const db = getDatabase()
  const [articlesWithRoute, nullRouteArticles] = await Promise.all([fetchAllArticlesWithRoute(), fetchAllArticlesWithNullRoute()])

  // Backfill non-null import_route via route string → import_route.id
  const uniqueRoutes = Array.from(new Set(articlesWithRoute.map((a) => a.importRoute).filter((v): v is string => {
    return Boolean(v && v.trim())
  })))
  if (uniqueRoutes.length > 0 && articlesWithRoute.length > 0) {
    const routeMap = await ensureImportRoutes(uniqueRoutes)

    // Only attempt to link articles not already linked
    const toLink = articlesWithRoute.filter((a) => {
      return routeMap.has(a.importRoute)
    })

    const existingLinks = await db
      .select({articleId: articleRouteLink.articleId, importRouteId: articleRouteLink.importRouteId})
      .from(articleRouteLink)
      .where(inArray(articleRouteLink.articleId, toLink.map((a) => {
        return a.id
      })))

    const existingSet = new Set(existingLinks.map((l) => {
      return `${l.articleId}:${l.importRouteId}`
    }))

    const links = toLink
      .map((a) => {
        const importRouteId = routeMap.get(a.importRoute)
        return importRouteId ? {articleId: a.id, importRouteId} : null
      })
      .filter((v): v is {articleId: string; importRouteId: string} => {
        return v !== null && !existingSet.has(`${v.articleId}:${v.importRouteId}`)
      })

    if (links.length > 0) {
      await insertLinksInChunks(links)
      console.log(`Backfilled ${links.length} article_route_link rows (from non-null import_route)`) 
    } else {
      console.log('No new links to create for articles with non-null import_route')
    }
  } else {
    console.log('No articles with non-null import_route to backfill')
  }

  // Backfill null import_route → ArXiv route id
  if (nullRouteArticles.length > 0) {
    const arxivRouteId = await ensureArxivRouteId()
    if (!arxivRouteId) {
      console.warn(`ArXiv import route not found and could not be created; skipping NULL import_route backfill`)
    } else {
      // Avoid inserting links that already exist
      const existingArxivLinks = await db
        .select({articleId: articleRouteLink.articleId})
        .from(articleRouteLink)
        .where(
          and(
            inArray(articleRouteLink.articleId, nullRouteArticles),
            eq(articleRouteLink.importRouteId, arxivRouteId),
          ),
        )
      const alreadyLinked = new Set(existingArxivLinks.map((l) => {
        return l.articleId
      }))

      const linksNull = nullRouteArticles
        .filter((id) => {
          return !alreadyLinked.has(id)
        })
        .map((articleId) => {
          return {articleId, importRouteId: arxivRouteId}
        })
      await insertLinksInChunks(linksNull)
      console.log(`Backfilled ${linksNull.length} article_route_link rows (NULL import_route → ArXiv)`) 
    }
  } else {
    console.log('No articles with NULL import_route to backfill')
  }
}

void run()
