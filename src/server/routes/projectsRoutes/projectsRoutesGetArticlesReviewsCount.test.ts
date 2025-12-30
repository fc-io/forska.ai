import {expect, mock, test} from 'bun:test'
import {Elysia} from 'elysia'

const createDbMock = (selectResults: unknown[]) => {
  const resultsQueue = [...selectResults]

  const createQuery = (result: unknown) => {
    const query = {
      from: () => {
        return query
      },
      innerJoin: () => {
        return query
      },
      where: () => {
        return query
      },
      orderBy: () => {
        return query
      },
      limit: () => {
        return query
      },
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
        return Promise.resolve(result).then(onFulfilled, onRejected)
      },
    }

    return query
  }

  return {
    select: () => {
      const result = resultsQueue.shift() ?? []
      return createQuery(result)
    },
  }
}

const createClickhouseClientMock = (options: {totalCount: string}) => {
  const executedQueries: string[] = []
  const executedCommands: string[] = []
  const inserts: Array<{table: string; valuesCount: number; format: string}> = []

  const client = {
    command: async ({query}: {query: string}) => {
      executedCommands.push(query)
    },
    insert: async ({table, values, format}: {table: string; values: unknown[]; format: string}) => {
      inserts.push({table, valuesCount: values.length, format})
    },
    query: async ({query}: {query: string; format: string}) => {
      executedQueries.push(query)
      return {
        json: async () => {
          return [{totalCount: options.totalCount}]
        },
      }
    },
  }

  return {client, executedCommands, executedQueries, inserts}
}

const dbMockRef = {current: createDbMock([[], [], [], []])}
const clickhouseClientMockRef = {current: createClickhouseClientMock({totalCount: '0'}).client}

mock.module('../../utils/getDatabase.ts', () => {
  return {
    getDatabase: () => {
      return dbMockRef.current
    },
  }
})

mock.module('../../../services/clickhouse/clickhouseClient.ts', () => {
  return {
    getClickhouseClient: () => {
      return clickhouseClientMockRef.current
    },
  }
})

const postCount = async (body: unknown) => {
  const {projectsRoutesGetArticlesReviewsCount} = await import('./projectsRoutesGetArticlesReviewsCount.ts')

  const app = new Elysia().use(projectsRoutesGetArticlesReviewsCount)

  const response = await app.handle(
    new Request('http://localhost/api/articlesreviewscount', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    }),
  )

  const data = await response.json()

  return {data, response}
}

test('POST /api/articlesreviewscount uses temp table join scope check for large curated sets', async () => {
  const promptRows = [{id: 'prompt-1', order: 0}]
  const projectBoundsRows = [{dateFrom: null, dateTo: null, modelId: 'model-1'}]
  const importRouteRows: Array<{route: string}> = []
  const curatedArticleRows = Array.from({length: 1001}, (_, idx) => {
    return {articleId: `article-${idx}`}
  })

  dbMockRef.current = createDbMock([promptRows, projectBoundsRows, importRouteRows, curatedArticleRows])

  const clickhouse = createClickhouseClientMock({totalCount: '1'})
  clickhouseClientMockRef.current = clickhouse.client

  const {data} = await postCount({limit: '100', projectId: 'project-1', prompts: {}})

  expect(data).toEqual({totalCount: 1, totalPages: 1})
  expect(clickhouse.executedQueries).toHaveLength(1)
  expect(clickhouse.executedQueries[0]).toContain("t.articleId != ''")
})

test('POST /api/articlesreviewscount uses IN scope for small curated sets', async () => {
  const promptRows = [{id: 'prompt-1', order: 0}]
  const projectBoundsRows = [{dateFrom: null, dateTo: null, modelId: 'model-1'}]
  const importRouteRows: Array<{route: string}> = []
  const curatedArticleRows = [{articleId: 'article-a'}, {articleId: 'article-b'}]

  dbMockRef.current = createDbMock([promptRows, projectBoundsRows, importRouteRows, curatedArticleRows])

  const clickhouse = createClickhouseClientMock({totalCount: '2'})
  clickhouseClientMockRef.current = clickhouse.client

  const {data} = await postCount({limit: '100', projectId: 'project-1', prompts: {}})

  expect(data).toEqual({totalCount: 2, totalPages: 1})
  expect(clickhouse.executedQueries).toHaveLength(1)
  expect(clickhouse.executedQueries[0]).toContain("articleId IN ('article-a', 'article-b')")
  expect(clickhouse.executedQueries[0]).not.toContain('JOIN temp_curated_')
})
