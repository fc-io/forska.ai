import {type} from 'arktype'
import {inArray, sql} from 'drizzle-orm'

import {articleRouteLink, articles, importRoute as importRouteTable} from '../db/schema.ts'
import {getDatabase} from '../server/utils/getDatabase.ts'

// ArkType for entries we will store, mirroring plan
const DatabaseItem = type({
  article_id: 'string',
  article_title: 'string',
  article_summary: 'string',
  article_authors: 'string[]',
  article_updated_at: 'string',
  article_created_at: 'string',
  article_version: 'string',
  'doi?': 'string',
  openalex_id: 'string',
  language: 'string',
  venue: 'string',
  import_route: 'string',
  'url?': 'string',
  'original_data?': 'unknown',
})

type DatabaseEntry = typeof DatabaseItem.infer

const batchEntries = <T>(records: T[], batchSize: number): T[][] => {
  const batches: T[][] = []
  for (let i = 0; i < records.length; i += batchSize) {
    batches.push(records.slice(i, i + batchSize))
  }
  return batches
}

const storeBatch = async (batch: DatabaseEntry[]): Promise<void> => {
  const db = getDatabase()

  const articlesToUpsert = batch.map((entry) => {
    return {
      articleId: entry.article_id,
      articleTitle: entry.article_title,
      articleSummary: entry.article_summary,
      articleAuthors: entry.article_authors,
      articleUpdatedAt: new Date(entry.article_updated_at),
      articleCreatedAt: new Date(entry.article_created_at),
      articleVersion: Number.parseInt(entry.article_version, 10),
      openalexId: entry.openalex_id,
      doi: entry.doi,
      url: entry.url,
      originalData: entry.original_data,
      importRoute: entry.import_route,
    }
  })

  const upserted = await db
    .insert(articles)
    .values(articlesToUpsert)
    .onConflictDoUpdate({
      target: articles.articleId,
      set: {
        articleTitle: sql`EXCLUDED.article_title`,
        articleSummary: sql`EXCLUDED.article_summary`,
        articleAuthors: sql`EXCLUDED.article_authors`,
        articleUpdatedAt: sql`EXCLUDED.article_updated_at`,
        articleVersion: sql`EXCLUDED.article_version`,
        openalexId: sql`EXCLUDED.openalex_id`,
        doi: sql`EXCLUDED.doi`,
        url: sql`EXCLUDED.url`,
        originalData: sql`EXCLUDED.original_data`,
        importRoute: sql`EXCLUDED.import_route`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    })
    .returning({id: articles.id, articleId: articles.articleId})

  // Build a set of import routes to ensure they exist
  const routeList = Array.from(
    new Set(
      batch
        .map((e) => {
          return e.import_route
        })
        .filter((r) => {
          return Boolean(r && r.trim())
        }),
    ),
  )

  if (routeList.length === 0 || upserted.length === 0) {
    return
  }

  const existingRoutes = await db
    .select({id: importRouteTable.id, route: importRouteTable.route})
    .from(importRouteTable)
    .where(inArray(importRouteTable.route, routeList))

  const existingSet = new Set(
    existingRoutes.map((r) => {
      return r.route
    }),
  )
  const missingRoutes = routeList.filter((r) => {
    return !existingSet.has(r)
  })

  if (missingRoutes.length > 0) {
    await db
      .insert(importRouteTable)
      .values(
        missingRoutes.map((route) => {
          return {route, name: route, active: true}
        }),
      )
      .onConflictDoNothing()
  }

  const allRoutes = await db
    .select({id: importRouteTable.id, route: importRouteTable.route})
    .from(importRouteTable)
    .where(inArray(importRouteTable.route, routeList))

  const routeMap = new Map(
    allRoutes.map((r) => {
      return [r.route, r.id]
    }),
  )

  // Link upserted articles to import routes
  const links = upserted
    .map((a) => {
      const route = batch.find((e) => {
        return e.article_id === a.articleId
      })?.import_route
      const routeId = route ? routeMap.get(route) : undefined
      return routeId ? {articleId: a.id, importRouteId: routeId} : null
    })
    .filter((v): v is {articleId: string; importRouteId: string} => {
      return v !== null
    })

  if (links.length > 0) {
    await db.insert(articleRouteLink).values(links).onConflictDoNothing()
  }
}

export const openalexWorkflowStoreEntries = async (entries: DatabaseEntry[]): Promise<void> => {
  const validated = entries.map((e, i) => {
    try {
      return DatabaseItem.assert(e)
    } catch (err) {
      throw new Error(`Validation failed for OpenAlex entry ${i}: ${String(err)}`)
    }
  })

  const batches = batchEntries(validated, 500)
  globalThis.console.log(`Storing ${validated.length} OpenAlex records in ${batches.length} batches`)

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    if (!batch) continue
    globalThis.console.log(`Storing OpenAlex batch ${i + 1}/${batches.length} (${batch.length} records)`)
    await storeBatch(batch)
    if (i < batches.length - 1) {
      await new Promise((resolve) => {
        return globalThis.setTimeout(resolve, 100)
      })
    }
  }
  globalThis.console.log(`Successfully stored ${validated.length} OpenAlex records to server`)
}

export type {DatabaseEntry}
export {DatabaseItem}
