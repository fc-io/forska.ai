import {type} from 'arktype'

import {storeImportedArticles} from '../server/services/articleImportStoreService.ts'

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
  await storeImportedArticles(
    batch.map((entry) => {
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
    }),
  )
}

export const openalexWorkflowStoreEntries = async (entries: DatabaseEntry[]): Promise<void> => {
  const validated = entries.map((e, i) => {
    try {
      return DatabaseItem.assert(e)
    } catch (err) {
      throw new Error(`Validation failed for OpenAlex entry ${i}: ${String(err)}`, {cause: err})
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
