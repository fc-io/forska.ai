import {type} from 'arktype'

import {storeImportedArticles} from '../../server/services/articleImportStoreService.ts'

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

// Store a batch of records and link import routes
const storeBatch = async (batch: (typeof DatabaseItem.infer)[]): Promise<void> => {
  await storeImportedArticles(
    batch.map((entry) => {
      return {
        articleId: entry.article_id,
        articleTitle: entry.article_title,
        articleSummary: entry.article_summary,
        articleAuthors: entry.article_authors,
        articleUpdatedAt: new Date(entry.article_updated_at),
        articleCreatedAt: new Date(entry.article_created_at),
        articleVersion: parseInt(entry.article_version),
        arxivId: entry.arxiv_id,
        importRoute: entry.import_route,
        originalData: entry.original_data,
      }
    }),
  )
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
        throw new Error(`Validation failed for entry ${index}: ${String(error)}`, {cause: error})
      }
    })

    // Batch records (max 500 at a time)
    const batches = batchEntries(transformedEntries, 500)

    console.log(`Storing ${records.length} ArXiv records in ${batches.length} batches`)

    // Store each batch
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]
      if (!batch) {
        continue
      }

      console.log(`Storing ArXiv batch ${i + 1}/${batches.length} (${batch.length} records)`)

      await storeBatch(batch)

      // Add a small delay between batches to avoid overwhelming the API
      if (i < batches.length - 1) {
        await new Promise((resolve) => {
          return setTimeout(resolve, 100)
        })
      }
    }

    console.log(`Successfully stored ${records.length} ArXiv records to server`)
  } catch (error) {
    console.error('Error storing records:', error)
    throw error
  }
}

export {type ArxivEntry, arxivEntry, arxivWorkflowStoreEntires, DatabaseItem}
