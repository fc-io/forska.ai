import {expect, test} from 'bun:test'

type StructuredFileConfig = {
  assetPath: string
  boundaryDisplayPath: string
  boundaryPointer: string
  format: 'json'
  kind: 'structured_file'
  sourceFileName: string
  version: 1
}

type ReimportRouteResult = {
  importCall: {config: StructuredFileConfig; dataSourceTitle: string; importRoute: string}
  result: {
    data: {
      dataSource: {id: string; importRoute: string; itemsAfterLastImport: number; title: string}
      stats: {itemCount: number; importedCount: number}
      structuredFileConfig: StructuredFileConfig
    }
    success: boolean
  }
  setStatus: number
  updateCall: {cursor: string; id: string; importRoute: string; importedCount: number}
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

test('structured file reimport uses the stable datasource-derived route', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname
        const structuredFileImportServiceModulePath = new URL('./src/server/services/structuredFileImportService.ts', 'file://' + process.cwd() + '/').pathname

        const structuredFileConfig = {
          assetPath: 'assets/structured_file_imports/upload.json',
          boundaryDisplayPath: '$.records[]',
          boundaryPointer: '/records',
          format: 'json',
          kind: 'structured_file',
          sourceFileName: 'upload.json',
          version: 1,
        }

        const state = {
          importCall: null,
          updateCall: null,
        }

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
                    description: 'Created from upload',
                    id,
                    importRoute: 'edited-import-route',
                    itemsAfterLastImport: 2,
                    lastImportAt: new Date('2026-01-02T00:00:00.000Z'),
                    title: 'Created datasource',
                    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
                  }
                },
                updateDataSourceAfterImport: async (params) => {
                  state.updateCall = params
                  return {
                    id: params.id,
                    importRoute: params.importRoute ?? null,
                    itemsAfterLastImport: params.importedCount,
                    title: 'Created datasource',
                  }
                },
              }
            },
          }
        })

        void mock.module(structuredFileImportServiceModulePath, () => {
          return {
            getStructuredFileImportConfig: (cursor) => {
              return cursor === 'cursor-json' ? structuredFileConfig : null
            },
            importStructuredFileFromConfig: async (params) => {
              state.importCall = params
              return {
                config: {kind: 'structured_file', version: 1},
                stats: {itemCount: 2, importedCount: 2},
              }
            },
          }
        })

        const {dataSourcesImportRoutesPostStructuredFile} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFile.ts?test=' + Date.now(),
        )

        const set = {status: 200}
        const result = await dataSourcesImportRoutesPostStructuredFile({body: {id: 'datasource-1'}, set})
        console.log(JSON.stringify({importCall: state.importCall, result, setStatus: set.status, updateCall: state.updateCall}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Structured file reimport test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as ReimportRouteResult

  expect(parsed.setStatus).toBe(200)
  expect(parsed.importCall).toEqual({
    config: {
      assetPath: 'assets/structured_file_imports/upload.json',
      boundaryDisplayPath: '$.records[]',
      boundaryPointer: '/records',
      format: 'json',
      kind: 'structured_file',
      sourceFileName: 'upload.json',
      version: 1,
    },
    dataSourceTitle: 'Created datasource',
    importRoute: 'structured-file:datasource-1',
  })
  expect(parsed.updateCall).toEqual({
    cursor: 'cursor-json',
    id: 'datasource-1',
    importRoute: 'structured-file:datasource-1',
    importedCount: 2,
  })
  expect(parsed.result).toEqual({
    success: true,
    data: {
      dataSource: {
        id: 'datasource-1',
        importRoute: 'structured-file:datasource-1',
        itemsAfterLastImport: 2,
        title: 'Created datasource',
      },
      stats: {itemCount: 2, importedCount: 2},
      structuredFileConfig: {
        assetPath: 'assets/structured_file_imports/upload.json',
        boundaryDisplayPath: '$.records[]',
        boundaryPointer: '/records',
        format: 'json',
        kind: 'structured_file',
        sourceFileName: 'upload.json',
        version: 1,
      },
    },
  })
})
