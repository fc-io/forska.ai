import {expect, test} from 'bun:test'

type CovidenceReimportResult = {
  queueCalls: string[][]
  result: {
    data: {id: string} | null
    error?: string
    success?: boolean
    stats?: {importedCount: number; itemCount: number}
  }
  setStatus: number
  txStatements: string[]
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

test('Covidence reimport reloads config and updates the existing datasource route', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const articleImportStoreServiceModulePath = new URL('./src/server/services/articleImportStoreService.ts', 'file://' + process.cwd() + '/').pathname
        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const covidenceImportServiceModulePath = new URL('./src/server/services/covidenceImportService.ts', 'file://' + process.cwd() + '/').pathname
        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname

        const state = {queueCalls: [], txStatements: []}

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
                  return await work({
                    run: async (statement) => {
                      state.txStatements.push(statement)
                    },
                  })
                },
              }
            },
          }
        })

        void mock.module(covidenceImportServiceModulePath, () => {
          return {
            getCovidencePackageConfig: (cursor) => {
              return cursor === 'cursor-json'
                ? {kind: 'covidence_import', version: 1, mode: 'title_abstract', files: []}
                : null
            },
            getCovidencePackageCursor: (config) => {
              return JSON.stringify(config)
            },
            importCovidencePackageFromConfig: async () => {
              return {importRouteIds: ['route-1'], stats: {importedCount: 3, itemCount: 3}}
            },
          }
        })

        void mock.module(dataSourceQueryServiceModulePath, () => {
          return {
            getDataSourceQueryService: () => {
              return {
                getDataSourceById: async (id) => {
                  return {
                    archived: false,
                    createdAt: new Date('2026-01-01T00:00:00.000Z'),
                    cursor: 'cursor-json',
                    dateFrom: null,
                    dateTo: null,
                    description: 'Created from Covidence package',
                    id,
                    importRoute: 'covidence:' + id,
                    itemsAfterLastImport: 3,
                    lastImportAt: new Date('2026-01-02T00:00:00.000Z'),
                    title: 'Created datasource',
                    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
                  }
                },
              }
            },
          }
        })

        const {dataSourcesImportRoutesPostCovidence} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.ts?test=' + Date.now(),
        )

        const set = {status: 200}
        const result = await dataSourcesImportRoutesPostCovidence({body: {id: 'datasource-1'}, set})
        console.log(JSON.stringify({queueCalls: state.queueCalls, result, setStatus: set.status, txStatements: state.txStatements}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence reimport test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as CovidenceReimportResult

  expect(parsed.setStatus).toBe(200)
  expect(parsed.txStatements).toHaveLength(2)
  expect(parsed.txStatements[0]).toContain('UPDATE app.import_route')
  expect(parsed.txStatements[1]).toContain("WHERE id = 'datasource-1'")
  expect(parsed.txStatements[1]).toContain('items_after_last_import = 3')
  expect(parsed.queueCalls).toEqual([['route-1']])
  expect(parsed.result.success).toBe(true)
  expect((parsed.result.data as {id: string} | null)?.id).toBe('datasource-1')
  expect(parsed.result.stats).toEqual({importedCount: 3, itemCount: 3})
})

test('Covidence reimport returns 400 when the datasource cursor is not a Covidence config', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname
        const covidenceImportServiceModulePath = new URL('./src/server/services/covidenceImportService.ts', 'file://' + process.cwd() + '/').pathname

        void mock.module(dataSourceQueryServiceModulePath, () => {
          return {
            getDataSourceQueryService: () => {
              return {
                getDataSourceById: async (id) => {
                  return {
                    archived: false,
                    createdAt: new Date('2026-01-01T00:00:00.000Z'),
                    cursor: 'not-covidence',
                    dateFrom: null,
                    dateTo: null,
                    description: null,
                    id,
                    importRoute: 'covidence:' + id,
                    itemsAfterLastImport: 0,
                    lastImportAt: null,
                    title: 'Created datasource',
                    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
                  }
                },
              }
            },
          }
        })

        void mock.module(covidenceImportServiceModulePath, () => {
          return {
            getCovidencePackageConfig: () => null,
            getCovidencePackageCursor: () => 'cursor-json',
            importCovidencePackageFromConfig: async () => {
              return {importRouteIds: [], stats: {importedCount: 0, itemCount: 0}}
            },
          }
        })

        const {dataSourcesImportRoutesPostCovidence} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.ts?test=' + Date.now(),
        )

        const set = {status: 200}
        const result = await dataSourcesImportRoutesPostCovidence({body: {id: 'datasource-1'}, set})
        console.log(JSON.stringify({result, setStatus: set.status}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(
      runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence invalid reimport test failed',
    )
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as CovidenceReimportResult

  expect(parsed.setStatus).toBe(400)
  expect(parsed.result).toEqual({data: null, error: 'Data source is not configured for Covidence import'})
})
