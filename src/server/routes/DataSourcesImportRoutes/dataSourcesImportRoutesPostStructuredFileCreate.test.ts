import {expect, mock, test} from 'bun:test'

const articleImportStoreServiceModulePath = new URL('../../services/articleImportStoreService.ts', import.meta.url)
  .pathname
const appDatabaseServiceModulePath = new URL('../../services/appDatabaseService.ts', import.meta.url).pathname
const dataSourceQueryServiceModulePath = new URL('../../services/dataSourceQueryService.ts', import.meta.url).pathname
const structuredFileImportServiceModulePath = new URL('../../services/structuredFileImportService.ts', import.meta.url)
  .pathname

const state = {
  getDataSourceById: mock(async (id: string) => {
    return {
      archived: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      cursor: 'cursor-json',
      dateFrom: null,
      dateTo: null,
      description: 'Created from upload',
      id,
      importRoute: `structured-file:${id}`,
      itemsAfterLastImport: 2,
      lastImportAt: new Date('2026-01-02T00:00:00.000Z'),
      title: 'Created datasource',
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    }
  }),
  importStructuredFileFromConfig: mock(async (params: {tx?: unknown}) => {
    return {
      config: {kind: 'structured_file', version: 1},
      importRouteIds: ['route-1'],
      stats: {itemCount: 2, importedCount: 2},
      tx: params.tx,
    }
  }),
  queueImportedArticleRefreshes: mock(async (_importRouteIds: string[]) => {}),
  transaction: mock(
    async (
      work: (tx: {
        queryJson: <T>(_statement: string) => Promise<T[]>
        run: (statement: string) => Promise<void>
      }) => Promise<unknown>,
    ) => {
      const tx = {
        queryJson: async <T>(_statement: string) => {
          return [] as T[]
        },
        run: async (statement: string) => {
          state.txStatements.push(statement)
        },
      }

      return await work(tx)
    },
  ),
  txStatements: [] as string[],
}

void mock.module(articleImportStoreServiceModulePath, () => {
  return {queueImportedArticleRefreshes: state.queueImportedArticleRefreshes}
})

void mock.module(appDatabaseServiceModulePath, () => {
  return {
    getAppDatabaseService: () => {
      return {transaction: state.transaction}
    },
  }
})

void mock.module(dataSourceQueryServiceModulePath, () => {
  return {
    getDataSourceQueryService: () => {
      return {getDataSourceById: state.getDataSourceById}
    },
  }
})

void mock.module(structuredFileImportServiceModulePath, () => {
  return {
    buildStructuredFileImportConfig: (params: Record<string, unknown>) => {
      return {kind: 'structured_file', version: 1, ...params}
    },
    getStructuredFileImportCursor: () => {
      return 'cursor-json'
    },
    importStructuredFileFromConfig: state.importStructuredFileFromConfig,
  }
})

const loadRoute = async () => {
  const module = await import('./dataSourcesImportRoutesPostStructuredFileCreate.ts')
  return module.dataSourcesImportRoutesPostStructuredFileCreate
}

test('structured file datasource create runs import inside a transaction and queues refreshes after commit', async () => {
  state.getDataSourceById.mockClear()
  state.importStructuredFileFromConfig.mockClear()
  state.queueImportedArticleRefreshes.mockClear()
  state.transaction.mockClear()
  state.txStatements = []

  const route = await loadRoute()
  const result = await route({
    assetPath: 'assets/structured_file_imports/upload.json',
    boundaryDisplayPath: '$.records[]',
    boundaryPointer: '/records',
    description: 'Created from upload',
    format: 'json',
    sourceFileName: 'records.json',
    title: 'Created datasource',
  })

  expect(state.transaction).toHaveBeenCalledTimes(1)
  expect(state.importStructuredFileFromConfig).toHaveBeenCalledTimes(1)
  expect(state.importStructuredFileFromConfig.mock.calls[0]?.[0]?.tx).toBeDefined()
  expect(state.txStatements).toHaveLength(2)
  expect(state.queueImportedArticleRefreshes).toHaveBeenCalledWith(['route-1'])
  expect(state.getDataSourceById).toHaveBeenCalledTimes(1)
  expect(result.success).toBe(true)
  expect(result.data.stats).toEqual({itemCount: 2, importedCount: 2})
})

test('structured file datasource create does not queue refreshes when the transactional import fails', async () => {
  state.getDataSourceById.mockClear()
  state.queueImportedArticleRefreshes.mockClear()
  state.transaction.mockClear()
  state.txStatements = []
  state.importStructuredFileFromConfig.mockImplementationOnce(async () => {
    throw new Error('boom')
  })

  const route = await loadRoute()

  let error: Error | null = null

  try {
    await route({
      assetPath: 'assets/structured_file_imports/upload.json',
      boundaryDisplayPath: '$.records[]',
      boundaryPointer: '/records',
      description: 'Created from upload',
      format: 'json',
      sourceFileName: 'records.json',
      title: 'Created datasource',
    })
  } catch (caughtError) {
    error = caughtError instanceof Error ? caughtError : new Error(String(caughtError))
  }

  expect(error?.message).toBe('boom')
  expect(state.transaction).toHaveBeenCalledTimes(1)
  expect(state.queueImportedArticleRefreshes).not.toHaveBeenCalled()
  expect(state.getDataSourceById).not.toHaveBeenCalled()
})
