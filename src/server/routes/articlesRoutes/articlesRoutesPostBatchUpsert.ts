import type {Context, Static, t} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {storeImportedArticlesWithTx} from '../../services/articleImportStoreService.ts'

export const articlesRoutesPostBatchUpsert = async ({
  body,
  set,
}: {
  body: {
    entries: Array<{
      article_id: string
      article_title: string
      article_summary: string
      article_authors: string[]
      article_updated_at: string
      article_created_at: string
      article_version: string
      arxiv_id?: string
      doi?: string
      pubmed_id?: string
      import_route: string
      original_data?: Static<ReturnType<typeof t.Any>>
    }>
  }
  set: Context['set']
}) => {
  const {entries} = body
  const rows = entries.map((entry) => {
    return {
      articleAuthors: entry.article_authors,
      articleCreatedAt: new Date(entry.article_created_at),
      articleId: entry.article_id,
      articleSummary: entry.article_summary,
      articleTitle: entry.article_title,
      articleUpdatedAt: new Date(entry.article_updated_at),
      articleVersion: Number.parseInt(entry.article_version, 10),
      arxivId: entry.arxiv_id ?? null,
      doi: entry.doi ?? null,
      importRoute: entry.import_route,
      originalData: entry.original_data as unknown,
      pubmedId: entry.pubmed_id ?? null,
    }
  })

  let importRefreshState = {acceptedCount: 0, importRouteIds: [] as string[]}

  await getAppDatabaseService().transaction(async (tx) => {
    importRefreshState = await storeImportedArticlesWithTx(tx, rows)
  })

  if (importRefreshState.acceptedCount !== entries.length) {
    set.status = 400
    return {
      data: null,
      error: `Failed to upsert all articles: accepted ${importRefreshState.acceptedCount} of ${entries.length} entries`,
    }
  }

  return {success: true, count: importRefreshState.acceptedCount}
}
