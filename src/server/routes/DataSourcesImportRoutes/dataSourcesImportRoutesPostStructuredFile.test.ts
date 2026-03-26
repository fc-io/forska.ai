import {expect, test} from 'bun:test'

type StructuredFileReimportBlockedResult = {result: {data: null; error: string}; setStatus: number}

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

test('structured file reimport is blocked because imported files are immutable', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')

        const dataSourceQueryServiceModulePath = new URL('./src/server/services/dataSourceQueryService.ts', 'file://' + process.cwd() + '/').pathname
        const structuredFileImportServiceModulePath = new URL('./src/server/services/structuredFileImportService.ts', 'file://' + process.cwd() + '/').pathname

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
            getStructuredFileImportConfig: (cursor) => {
              return cursor === 'cursor-json'
                ? {
                    assetPath: 'assets/structured_file_imports/upload.json',
                    boundaryDisplayPath: '$.records[]',
                    boundaryPointer: '/records',
                    format: 'json',
                    kind: 'structured_file',
                    sourceFileName: 'upload.json',
                    version: 1,
                  }
                : null
            },
          }
        })

        const {dataSourcesImportRoutesPostStructuredFile} = await import(
          './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFile.ts?test=' + Date.now(),
        )

        const set = {status: 200}
        const result = await dataSourcesImportRoutesPostStructuredFile({body: {id: 'datasource-1'}, set})
        console.log(JSON.stringify({result, setStatus: set.status}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Structured file reimport test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as StructuredFileReimportBlockedResult

  expect(parsed.setStatus).toBe(400)
  expect(parsed.result).toEqual({
    data: null,
    error: 'Imported XML/JSON data sources are immutable and can only be archived',
  })
})
