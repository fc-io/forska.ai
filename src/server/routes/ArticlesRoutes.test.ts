import {afterEach, expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const appDatabaseServiceModulePath = new URL('../services/appDatabaseService.ts', import.meta.url).pathname
const articleImportStoreServiceModulePath = new URL('../services/articleImportStoreService.ts', import.meta.url)
  .pathname

const queryJsonRef = {
  current: async (_statement: string): Promise<unknown[]> => {
    return []
  },
}

const transactionRef = {
  current: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
    return await callback({})
  },
}

const storeImportedArticlesWithTxRef = {
  current: async (_tx: unknown, rows: unknown[]): Promise<{acceptedCount: number; importRouteIds: string[]}> => {
    return {acceptedCount: rows.length, importRouteIds: []}
  },
}

const registerModuleMocks = () => {
  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: (statement: string) => {
            return queryJsonRef.current(statement)
          },
          run: async () => {
            return undefined
          },
          transaction: <T>(callback: (tx: unknown) => Promise<T>) => {
            return transactionRef.current(callback)
          },
        }
      },
    }
  })

  void mock.module(articleImportStoreServiceModulePath, () => {
    return {
      storeImportedArticlesWithTx: (tx: unknown, rows: unknown[]) => {
        return storeImportedArticlesWithTxRef.current(tx, rows)
      },
    }
  })
}

const loadRoutes = (): Promise<typeof import('./ArticlesRoutes.ts')> => {
  registerModuleMocks()
  return import(`./ArticlesRoutes.ts?test=${Date.now()}-${Math.random()}`)
}

const getApp = async () => {
  const {articlesRoutes} = await loadRoutes()
  return new Elysia().use(articlesRoutes)
}

afterEach(() => {
  mock.restore()
})

test('latest articles include URL fields needed for article links', async () => {
  queryJsonRef.current = async () => {
    return [
      {
        articleAuthors: ['Alice Example'],
        articleCreatedAt: '2026-01-02T00:00:00.000Z',
        articleId: 'external-article-1',
        articleTitle: 'Linked article',
        arxivId: null,
        biorxivId: null,
        doi: '10.1000/latest-link',
        id: 'article-1',
        medrxivId: null,
        pubmedId: null,
        sourceMetadata: null,
        url: 'https://example.com/article-1',
      },
    ]
  }

  const app = await getApp()
  const response = await app.handle(new Request('http://localhost/api/articles/latest'))
  const body = (await response.json()) as {data: Array<{doi: string | null; url: string | null}>}

  expect(response.status).toBe(200)
  expect(body.data[0]).toMatchObject({doi: '10.1000/latest-link', url: 'https://example.com/article-1'})
})

test('batch article upsert fails when canonical matching drops entries', async () => {
  storeImportedArticlesWithTxRef.current = async () => {
    return {acceptedCount: 0, importRouteIds: []}
  }

  const app = await getApp()
  const response = await app.handle(
    new Request('http://localhost/api/articles/batch-upsert', {
      body: JSON.stringify({
        entries: [
          {
            article_authors: ['Alice Example'],
            article_created_at: '2026-01-02T00:00:00.000Z',
            article_id: 'legacy-only-article-id',
            article_summary: 'Summary',
            article_title: 'Unmatched article',
            article_updated_at: '2026-01-03T00:00:00.000Z',
            article_version: '1',
            import_route: 'legacy-route',
          },
        ],
      }),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {error: string}

  expect(response.status).toBe(400)
  expect(body.error).toContain('accepted 0 of 1 entries')
})

test('PDF explicit bulk route admits durable article-id-only jobs', async () => {
  const statements: string[] = []

  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async () => {
            return []
          },
          run: async (statement: string) => {
            statements.push(statement)
          },
          transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
            return callback({})
          },
        }
      },
    }
  })
  void mock.module(articleImportStoreServiceModulePath, () => {
    return {storeImportedArticlesWithTx: storeImportedArticlesWithTxRef.current}
  })

  const routesModule = (await import(
    `./ArticlesRoutes.ts?test=pdf-bulk-${Date.now()}-${Math.random()}`
  )) as typeof import('./ArticlesRoutes.ts')
  const {articlesRoutes} = routesModule
  const app = new Elysia().use(articlesRoutes)
  const response = await app.handle(
    new Request('http://localhost/api/articles/pdf-fetch-bulk', {
      body: JSON.stringify({articleIds: ['article-1', 'article-2'], concurrency: 2, forceRefetch: true}),
      headers: {'content-type': 'application/json'},
      method: 'POST',
    }),
  )
  const body = (await response.json()) as {job: {jobKind: string; latestSnapshotSemantics: boolean}}
  const joined = statements.join('\n')

  expect(response.status).toBe(202)
  expect(body.job).toMatchObject({jobKind: 'review.pdf.selection', latestSnapshotSemantics: true})
  expect(joined).toContain('INSERT INTO app.review_bulk_operation_job')
  expect(joined).toContain("'review.pdf.selection'")
  expect(joined).toContain('article-id-only')
  expect(joined).toContain('article-1')
  expect(joined).toContain('requestId')
})
