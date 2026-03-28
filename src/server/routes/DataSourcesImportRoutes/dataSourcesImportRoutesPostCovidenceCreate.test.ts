import {expect, test} from 'bun:test'

type CovidenceCreateSuccessResult = {
  deleteCalls: string[]
  getDataSourceCallCount: number
  result: {
    data: {covidencePackageConfig: {kind: 'covidence_import'; mode: 'title_abstract'; version: 1}}
    success: boolean
  }
  storedFileCalls: Array<{datasourceId: string; files: Array<{fileName: string; fileRole: string}>}>
  transactionCallCount: number
  txStatements: string[]
}

type CovidenceCreateFailureResult = {
  deleteCalls: string[]
  errorMessage: string | null
  getDataSourceCallCount: number
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

test('Covidence datasource create stores package files and persists cursor config in one transaction', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const covidenceImportServiceModulePath = new URL('./src/server/services/covidenceImportService.ts', 'file://' + process.cwd() + '/').pathname
        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname

        const state = {
          deleteCalls: [],
          getDataSourceCallCount: 0,
          storedFileCalls: [],
          transactionCallCount: 0,
          txStatements: [],
        }

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                transaction: async (work) => {
                  state.transactionCallCount += 1
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
            buildCovidencePackageConfig: (params) => {
              return {kind: 'covidence_import', version: 1, ...params}
            },
            deleteCovidencePackageFiles: (datasourceId) => {
              state.deleteCalls.push(datasourceId)
            },
            getCovidencePackageCursor: (config) => {
              return JSON.stringify(config)
            },
            storeCovidencePackageFiles: async (params) => {
              state.storedFileCalls.push({
                datasourceId: params.datasourceId,
                files: params.files.map((entry) => {
                  return {fileName: entry.file.name, fileRole: entry.fileRole}
                }),
              })

              return [
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/all-all.csv',
                  fileRole: 'all',
                  format: 'csv',
                  sourceFileName: 'all.csv',
                },
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/irrelevant-irrelevant.csv',
                  fileRole: 'irrelevant',
                  format: 'csv',
                  sourceFileName: 'irrelevant.csv',
                },
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/full_text-full_text.ris',
                  fileRole: 'full_text',
                  format: 'ris',
                  sourceFileName: 'full_text.ris',
                },
              ]
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
                    description: 'Created from Covidence package',
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

        const {dataSourcesImportRoutesPostCovidenceCreate} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts?test=' + Date.now(),
        )

        const result = await dataSourcesImportRoutesPostCovidenceCreate({
          description: 'Created from Covidence package',
          files: [
            {file: new File(['a,b\\n1,2\\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
            {file: new File(['a,b\\n3,4\\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
            {file: new File(['TY  - JOUR\\nER  - \\n'], 'full_text.ris', {type: 'text/plain'}), fileRole: 'full_text'},
          ],
          mode: 'title_abstract',
          title: 'Created datasource',
        })

        console.log(JSON.stringify({...state, result}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence create success test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as CovidenceCreateSuccessResult

  expect(parsed.transactionCallCount).toBe(1)
  expect(parsed.storedFileCalls).toHaveLength(1)
  expect(parsed.storedFileCalls[0]?.files).toEqual([
    {fileName: 'all.csv', fileRole: 'all'},
    {fileName: 'irrelevant.csv', fileRole: 'irrelevant'},
    {fileName: 'full_text.ris', fileRole: 'full_text'},
  ])
  expect(parsed.txStatements).toHaveLength(1)
  expect(parsed.txStatements[0]).toContain('INSERT INTO app.data_source')
  expect(parsed.txStatements[0]).toContain('covidence:')
  expect(parsed.txStatements[0]).toContain('covidence_import')
  expect(parsed.deleteCalls).toEqual([])
  expect(parsed.getDataSourceCallCount).toBe(1)
  expect(parsed.result.success).toBe(true)
  expect(parsed.result.data.covidencePackageConfig).toMatchObject({
    kind: 'covidence_import',
    mode: 'title_abstract',
    version: 1,
  })
})

test('Covidence datasource create deletes stored files when the transaction fails', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const covidenceImportServiceModulePath = new URL('./src/server/services/covidenceImportService.ts', 'file://' + process.cwd() + '/').pathname
        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname

        const state = {
          deleteCalls: [],
          errorMessage: null,
          getDataSourceCallCount: 0,
          transactionCallCount: 0,
        }

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                transaction: async () => {
                  state.transactionCallCount += 1
                  throw new Error('boom')
                },
              }
            },
          }
        })

        void mock.module(covidenceImportServiceModulePath, () => {
          return {
            buildCovidencePackageConfig: (params) => {
              return {kind: 'covidence_import', version: 1, ...params}
            },
            deleteCovidencePackageFiles: (datasourceId) => {
              state.deleteCalls.push(datasourceId)
            },
            getCovidencePackageCursor: (config) => {
              return JSON.stringify(config)
            },
            storeCovidencePackageFiles: async (params) => {
              return [
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/all-all.csv',
                  fileRole: 'all',
                  format: 'csv',
                  sourceFileName: 'all.csv',
                },
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/irrelevant-irrelevant.csv',
                  fileRole: 'irrelevant',
                  format: 'csv',
                  sourceFileName: 'irrelevant.csv',
                },
                {
                  assetPath: 'assets/covidence_imports/' + params.datasourceId + '/full_text-full_text.ris',
                  fileRole: 'full_text',
                  format: 'ris',
                  sourceFileName: 'full_text.ris',
                },
              ]
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

        const {dataSourcesImportRoutesPostCovidenceCreate} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts?test=' + Date.now(),
        )

        try {
          await dataSourcesImportRoutesPostCovidenceCreate({
            files: [
              {file: new File(['a,b\\n1,2\\n'], 'all.csv', {type: 'text/csv'}), fileRole: 'all'},
              {file: new File(['a,b\\n3,4\\n'], 'irrelevant.csv', {type: 'text/csv'}), fileRole: 'irrelevant'},
              {file: new File(['TY  - JOUR\\nER  - \\n'], 'full_text.ris', {type: 'text/plain'}), fileRole: 'full_text'},
            ],
            mode: 'title_abstract',
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
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence create failure test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as CovidenceCreateFailureResult

  expect(parsed.errorMessage).toBe('boom')
  expect(parsed.transactionCallCount).toBe(1)
  expect(parsed.deleteCalls).toHaveLength(1)
  expect(parsed.getDataSourceCallCount).toBe(0)
})
