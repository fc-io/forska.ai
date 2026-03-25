import {type} from 'arktype'

import {storeImportedArticles} from '../server/services/articleImportStoreService.ts'

const DatabaseItem = type({
  article_id: 'string',
  article_title: 'string',
  article_summary: 'string',
  article_authors: 'string[]',
  article_updated_at: 'string | null',
  article_created_at: 'string',
  article_version: 'string',
  'medrxiv_id?': 'string',
  'doi?': 'string',
  import_route: 'string',
  'url?': 'string',
  'original_data?': 'unknown',
})

type DatabaseEntry = typeof DatabaseItem.infer

const toVersionNumber = (value: string): number => {
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

const toTimestamp = (value: string | null): number => {
  if (!value) return 0
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

const dedupeEntries = (records: DatabaseEntry[]): DatabaseEntry[] => {
  const map = records.reduce((acc, entry) => {
    const existing = acc.get(entry.article_id)
    const incomingVersion = toVersionNumber(entry.article_version)
    const existingVersion = existing ? toVersionNumber(existing.article_version) : incomingVersion
    const shouldReplace =
      existing === undefined
        ? true
        : incomingVersion !== existingVersion
          ? incomingVersion > existingVersion
          : toTimestamp(entry.article_updated_at) > toTimestamp(existing.article_updated_at)

    if (shouldReplace) {
      acc.set(entry.article_id, entry)
    }
    return acc
  }, new Map<string, DatabaseEntry>())

  return Array.from(map.values())
}

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
        articleUpdatedAt: entry.article_updated_at ? new Date(entry.article_updated_at) : null,
        articleCreatedAt: new Date(entry.article_created_at),
        articleVersion: toVersionNumber(entry.article_version),
        medrxivId: entry.medrxiv_id ?? null,
        doi: entry.doi,
        url: entry.url,
        originalData: entry.original_data,
        importRoute: entry.import_route,
      }
    }),
  )
}

export const medrxivWorkflowStoreEntries = async (entries: DatabaseEntry[]): Promise<void> => {
  const validated = entries.map((e, i) => {
    try {
      return DatabaseItem.assert(e)
    } catch (err) {
      throw new Error(`Validation failed for medRxiv entry ${i}: ${String(err)}`, {cause: err})
    }
  })

  const uniqueEntries = dedupeEntries(validated)
  const batches = batchEntries(uniqueEntries, 500)
  globalThis.console.log(
    `Storing ${uniqueEntries.length} medRxiv records in ${batches.length} batches${validated.length !== uniqueEntries.length ? ` (deduped from ${validated.length})` : ''}`,
  )

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    if (!batch) continue

    await storeBatch(batch)
    if (i < batches.length - 1) {
      await new Promise((resolve) => {
        return globalThis.setTimeout(resolve, 100)
      })
    }
  }
  globalThis.console.log(`Successfully stored ${uniqueEntries.length} medRxiv records to server`)
}

export type {DatabaseEntry}
export {DatabaseItem}
