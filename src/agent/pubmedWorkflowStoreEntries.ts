import {type} from 'arktype'

import {storeImportedArticles} from '../server/services/articleImportStoreService.ts'

const DatabaseItem = type({
  article_id: 'string',
  article_title: 'string',
  article_summary: 'string',
  article_authors: 'string[]',
  article_updated_at: 'string',
  article_created_at: 'string',
  article_version: 'string',
  'doi?': 'string',
  pubmed_id: 'string',
  import_route: 'string',
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
        doi: entry.doi,
        pubmedId: entry.pubmed_id,
        originalData: entry.original_data,
        importRoute: entry.import_route,
      }
    }),
  )
}

export const pubmedWorkflowStoreEntries = async (entries: DatabaseEntry[]): Promise<void> => {
  const validated = entries.map((e, i) => {
    try {
      return DatabaseItem.assert(e)
    } catch (err) {
      throw new Error(`Validation failed for PubMed entry ${i}: ${String(err)}`, {cause: err})
    }
  })

  const batches = batchEntries(validated, 500)
  globalThis.console.log(`Storing ${validated.length} PubMed records in ${batches.length} batches`)

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    if (!batch) continue
    globalThis.console.log(`Storing PubMed batch ${i + 1}/${batches.length} (${batch.length} records)`)
    await storeBatch(batch)
    if (i < batches.length - 1) {
      await new Promise((resolve) => {
        return globalThis.setTimeout(resolve, 100)
      })
    }
  }
  globalThis.console.log(`Successfully stored ${validated.length} PubMed records to server`)
}

export type {DatabaseEntry}
export {DatabaseItem}
