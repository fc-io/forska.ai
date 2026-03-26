import {expect, test} from 'bun:test'

type StructuredFileCreateSuccessResult = {
  getDataSourceCallCount: number
  importCallHasTx: boolean
  queueCalls: string[][]
  result: {data: {stats: {itemCount: number; importedCount: number}}; success: boolean}
  transactionCallCount: number
  txStatements: string[]
}

type StructuredFileCreateFailureResult = {
  errorMessage: string | null
  getDataSourceCallCount: number
  queueCalls: string[][]
  transactionCallCount: number
}

const getLastJsonLine = (stdout: string) => {
  return (
    stdout
      .split('\n')
      .map((line) => {
        return line.trim()
      })
      .filter((line) => {
        return line !== ''
      })
      .at(-1) ?? ''
  )
}

test('structured file datasource create runs import inside a transaction and queues refreshes after commit', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const articleImportStoreServiceModulePath = new URL('./src/server/services/articleImportStoreService.ts', 'file://' + process.cwd() + '/').pathname
        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname
        const structuredFileImportServiceModulePath = new URL('./src/server/services/structuredFileImportService.ts', 'file://' + process.cwd() + '/').pathname

        const state = {
          getDataSourceCallCount: 0,
          importCallHasTx: false,
          queueCalls: [],
          transactionCallCount: 0,
          txStatements: [],
        }

        void mock.module(articleImportStoreServiceModulePath, () => {
          return {
            queueImportedArticleRefreshes: async (importRouteIds) => {
              state.queueCalls.push(importRouteIds)
            },
          }
        })

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                transaction: async (work) => {
                  state.transactionCallCount += 1
                  const tx = {
                    queryJson: async () => [],
                    run: async (statement) => {
                      state.txStatements.push(statement)
                    },
                  }
                  return await work(tx)
                },
              }
            },
          }
        })

        void mock.module(dataSourceQueryServiceModulePath, () => {
          return {
            getDataSourceQueryService: () => {
              return {
                getDataSourceById: async (id) => {
                  state.getDataSourceCallCount += 1
                  return {
                    archived: false,
                    createdAt: new Date('2026-01-01T00:00:00.000Z'),
                    cursor: 'cursor-json',
                    dateFrom: null,
                    dateTo: null,
                    description: 'Created from upload',
                    id,
                    importRoute: 'imported-file:Created datasource',
                    itemsAfterLastImport: 2,
                    lastImportAt: new Date('2026-01-02T00:00:00.000Z'),
                    title: 'Created datasource',
                    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
                  }
                },
              }
            },
          }
        })

        void mock.module(structuredFileImportServiceModulePath, () => {
          return {
            buildStructuredFileImportConfig: (params) => {
              return {kind: 'structured_file', version: 1, ...params}
            },
            getStructuredFileImportCursor: () => {
              return 'cursor-json'
            },
            importStructuredFileFromConfig: async (params) => {
              state.importCallHasTx = Boolean(params.tx)
              return {
                config: {kind: 'structured_file', version: 1},
                importRouteIds: ['route-1'],
                stats: {itemCount: 2, importedCount: 2},
              }
            },
          }
        })

        const {dataSourcesImportRoutesPostStructuredFileCreate} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileCreate.ts?test=' + Date.now(),
        )

        const result = await dataSourcesImportRoutesPostStructuredFileCreate({
          assetPath: 'assets/structured_file_imports/upload.json',
          boundaryDisplayPath: '$.records[]',
          boundaryPointer: '/records',
          description: 'Created from upload',
          format: 'json',
          sourceFileName: 'records.json',
          title: 'Created datasource',
        })

        console.log(
          JSON.stringify({
            getDataSourceCallCount: state.getDataSourceCallCount,
            importCallHasTx: state.importCallHasTx,
            queueCalls: state.queueCalls,
            result,
            transactionCallCount: state.transactionCallCount,
            txStatements: state.txStatements,
          }),
        )
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(
      runRoute.stderr.toString() || runRoute.stdout.toString() || 'Structured file create success test failed',
    )
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as StructuredFileCreateSuccessResult

  expect(parsed.transactionCallCount).toBe(1)
  expect(parsed.importCallHasTx).toBe(true)
  expect(parsed.txStatements).toHaveLength(3)
  expect(parsed.queueCalls).toEqual([['route-1']])
  expect(parsed.getDataSourceCallCount).toBe(1)
  expect(parsed.result.success).toBe(true)
  expect(parsed.result.data.stats).toEqual({itemCount: 2, importedCount: 2})
  expect(parsed.txStatements[1]).toContain('UPDATE app.import_route')
  expect(parsed.txStatements[1]).toContain("'Created datasource'")
})

test('structured file datasource create does not queue refreshes when the transactional import fails', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const articleImportStoreServiceModulePath = new URL('./src/server/services/articleImportStoreService.ts', 'file://' + process.cwd() + '/').pathname
        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname
        const structuredFileImportServiceModulePath = new URL('./src/server/services/structuredFileImportService.ts', 'file://' + process.cwd() + '/').pathname

        const state = {
          errorMessage: null,
          getDataSourceCallCount: 0,
          queueCalls: [],
          transactionCallCount: 0,
        }

        void mock.module(articleImportStoreServiceModulePath, () => {
          return {
            queueImportedArticleRefreshes: async (importRouteIds) => {
              state.queueCalls.push(importRouteIds)
            },
          }
        })

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                transaction: async (work) => {
                  state.transactionCallCount += 1
                  const tx = {
                    queryJson: async () => [],
                    run: async () => {},
                  }
                  return await work(tx)
                },
              }
            },
          }
        })

        void mock.module(dataSourceQueryServiceModulePath, () => {
          return {
            getDataSourceQueryService: () => {
              return {
                getDataSourceById: async () => {
                  state.getDataSourceCallCount += 1
                  return null
                },
              }
            },
          }
        })

        void mock.module(structuredFileImportServiceModulePath, () => {
          return {
            buildStructuredFileImportConfig: (params) => {
              return {kind: 'structured_file', version: 1, ...params}
            },
            getStructuredFileImportCursor: () => {
              return 'cursor-json'
            },
            importStructuredFileFromConfig: async () => {
              throw new Error('boom')
            },
          }
        })

        const {dataSourcesImportRoutesPostStructuredFileCreate} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileCreate.ts?test=' + Date.now(),
        )

        try {
          await dataSourcesImportRoutesPostStructuredFileCreate({
            assetPath: 'assets/structured_file_imports/upload.json',
            boundaryDisplayPath: '$.records[]',
            boundaryPointer: '/records',
            description: 'Created from upload',
            format: 'json',
            sourceFileName: 'records.json',
            title: 'Created datasource',
          })
        } catch (error) {
          state.errorMessage = error instanceof Error ? error.message : String(error)
        }

        console.log(JSON.stringify(state))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(
      runRoute.stderr.toString() || runRoute.stdout.toString() || 'Structured file create failure test failed',
    )
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as StructuredFileCreateFailureResult

  expect(parsed.errorMessage).toBe('boom')
  expect(parsed.transactionCallCount).toBe(1)
  expect(parsed.queueCalls).toEqual([])
  expect(parsed.getDataSourceCallCount).toBe(0)
})
