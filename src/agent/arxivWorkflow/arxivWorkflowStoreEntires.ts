import {type} from 'arktype'
import {inArray, sql} from 'drizzle-orm'

import {articleRouteLink, articles, importRoute as importRouteTable} from '../../db/schema.ts'

// Define the ArxivEntry type to match the transformed record structure
const arxivEntry = type({
  id: 'string',
  title: 'string',
  summary: 'string',
  updated: 'string',
  published: 'string',
  author: 'object[]',
  link: 'string[]',
  'primary_category?': 'string',
  'category?': 'string | string[]',
  'comment?': 'string',
})

type ArxivEntry = typeof arxivEntry.infer

// Database item schema using arktype
const DatabaseItem = type({
  article_id: 'string',
  article_title: 'string',
  article_summary: 'string',
  article_authors: 'string[]',
  article_updated_at: 'string',
  article_created_at: 'string',
  article_version: 'string',
  arxiv_id: 'string',
  import_route: 'string',
  'original_data?': 'unknown',
})

// Transform ArxivEntry to DatabaseItem
const transformEntry = (entry: typeof arxivEntry.infer, importRoute: string): typeof DatabaseItem.infer => {
  // Safely extract authors
  const authors = Array.isArray(entry.author)
    ? entry.author.map((author) => {
        const authorObj = author as {name?: string}
        return authorObj.name || JSON.stringify(author)
      })
    : [entry.author]

  // Extract arXiv ID from the full ID
  const arxivId = entry.id.includes('arxiv.org') ? (entry.id.split('/').pop() ?? entry.id) : entry.id

  // Extract version number, default to '1' if not found
  const versionMatch = arxivId.match(/v(\d+)$/)
  const version = versionMatch?.[1] ?? '1'

  return {
    article_id: entry.id,
    article_title: entry.title,
    article_summary: entry.summary,
    article_authors: authors,
    arxiv_id: arxivId,
    article_updated_at: entry.updated,
    article_created_at: entry.published,
    article_version: version,
    import_route: importRoute,
    original_data: entry,
  }
}

// Batch records into chunks of max size
const batchEntries = <T>(records: T[], batchSize: number): T[][] => {
  const batches: T[][] = []
  for (let i = 0; i < records.length; i += batchSize) {
    batches.push(records.slice(i, i + batchSize))
  }
  return batches
}

// Store a batch of records directly via Drizzle and link import routes
const storeBatch = async (batch: (typeof DatabaseItem.infer)[]): Promise<void> => {
  const {getDatabase} = await import('../../server/utils/getDatabase.ts')
  const db = getDatabase()

  const articlesToUpsert = batch.map((entry) => {
    return {
      articleId: entry.article_id,
      articleTitle: entry.article_title,
      articleSummary: entry.article_summary,
      articleAuthors: entry.article_authors,
      articleUpdatedAt: new Date(entry.article_updated_at),
      articleCreatedAt: new Date(entry.article_created_at),
      articleVersion: parseInt(entry.article_version),
      arxivId: entry.arxiv_id,
      originalData: entry.original_data,
    }
  })

  const inserted = await db
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
        arxivId: sql`EXCLUDED.arxiv_id`,
        originalData: sql`EXCLUDED.original_data`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    })
    .returning({id: articles.id, articleId: articles.articleId})

  const articleIdToDbId = new Map(
    inserted.map((r) => {
      return [r.articleId, r.id]
    }),
  )

  const routeList = Array.from(
    new Set(
      batch
        .map((e) => {
          return e.import_route
        })
        .filter((r): r is string => {
          return Boolean(r && r.trim())
        }),
    ),
  )

  if (routeList.length === 0 || inserted.length === 0) {
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

  const importRoutes = await db
    .select({id: importRouteTable.id, route: importRouteTable.route})
    .from(importRouteTable)
    .where(inArray(importRouteTable.route, routeList))

  const routeMap = new Map(
    importRoutes.map((r) => {
      return [r.route, r.id]
    }),
  )

  const links = batch
    .map((e) => {
      const articleId = articleIdToDbId.get(e.article_id)
      const importRouteId = e.import_route ? routeMap.get(e.import_route) : undefined
      return articleId && importRouteId ? {articleId, importRouteId} : null
    })
    .filter((v): v is {articleId: string; importRouteId: string} => {
      return v !== null
    })

  if (links.length > 0) {
    await db.insert(articleRouteLink).values(links).onConflictDoNothing()
  }
}

// Main function to store records with batching
const arxivWorkflowStoreEntires = async (records: (typeof arxivEntry.infer)[], importRoute: string): Promise<void> => {
  try {
    // Transform records to database format
    const transformedEntries = records.map((entry) => {
      return transformEntry(entry, importRoute)
    })

    // Validate transformed records
    transformedEntries.forEach((entry, index) => {
      try {
        DatabaseItem.assert(entry)
      } catch (error) {
        throw new Error(`Validation failed for entry ${index}: ${String(error)}`)
      }
    })

    // Batch records (max 500 at a time)
    const batches = batchEntries(transformedEntries, 500)

    globalThis.console.log(`Storing ${records.length} records in ${batches.length} batches`)

    // Store each batch
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]
      if (!batch) {
        continue
      }

      globalThis.console.log(`Storing batch ${i + 1}/${batches.length} (${batch.length} records)`)

      await storeBatch(batch)

      // Add a small delay between batches to avoid overwhelming the API
      if (i < batches.length - 1) {
        await new Promise((resolve) => {
          return globalThis.setTimeout(resolve, 100)
        })
      }
    }

    globalThis.console.log(`Successfully stored ${records.length} records to server`)
  } catch (error) {
    globalThis.console.error('Error storing records:', error)
    throw error
  }
}

export {type ArxivEntry, arxivEntry, arxivWorkflowStoreEntires, DatabaseItem}
