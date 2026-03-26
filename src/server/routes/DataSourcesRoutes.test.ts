import {expect, test} from 'bun:test'

type StructuredFileConfigResponse = {
  assetPath: string
  boundaryDisplayPath: string
  boundaryPointer: string
  format: 'json'
  kind: 'structured_file'
  sourceFileName: string
  version: 1
}

type DataSourceListResponse = {
  data: Array<{
    archived: boolean
    createdAt: string
    dateFrom: null
    dateTo: null
    description: string
    id: string
    importRoute: string
    itemsAfterLastImport: number
    lastImportAt: string
    structuredFileConfig: StructuredFileConfigResponse
    title: string
    updatedAt: string
  }>
}

type DataSourceDetailResponse = {
  data: {
    createdAt: string
    dateFrom: null
    dateTo: null
    description: string
    id: string
    importRoute: string
    itemsAfterLastImport: number
    lastImportAt: string
    structuredFileConfig: StructuredFileConfigResponse
    title: string
    updatedAt: string
  }
}

const structuredFileConfig: StructuredFileConfigResponse = {
  assetPath: 'assets/structured_file_imports/upload.json',
  boundaryDisplayPath: '$.records[]',
  boundaryPointer: '/records',
  format: 'json',
  kind: 'structured_file',
  sourceFileName: 'upload.json',
  version: 1,
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

const runDataSourcesRoute = (url: string) => {
  return globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {Elysia} = await import('elysia')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname

        const row = {
          archived: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          cursor: ${JSON.stringify(JSON.stringify(structuredFileConfig))},
          dateFrom: null,
          dateTo: null,
          description: 'Created from upload',
          id: 'datasource-1',
          importRoute: 'structured-file:datasource-1',
          itemsAfterLastImport: 2,
          lastImportAt: '2026-01-02T00:00:00.000Z',
          title: 'Created datasource',
          updatedAt: '2026-01-02T00:00:00.000Z',
        }

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return statement.includes("WHERE id = 'datasource-1'")
                    ? [
                        {
                          createdAt: row.createdAt,
                          cursor: row.cursor,
                          dateFrom: row.dateFrom,
                          dateTo: row.dateTo,
                          description: row.description,
                          id: row.id,
                          importRoute: row.importRoute,
                          itemsAfterLastImport: row.itemsAfterLastImport,
                          lastImportAt: row.lastImportAt,
                          title: row.title,
                          updatedAt: row.updatedAt,
                        },
                      ]
                    : [row]
                },
                run: async () => {},
                transaction: async () => {
                  throw new Error('transaction should not be used in these GET tests')
                },
              }
            },
          }
        })

        const {dataSourcesRoutes} = await import('./src/server/routes/DataSourcesRoutes.ts?test=' + Date.now())
        const app = new Elysia().use(dataSourcesRoutes)
        const response = await app.handle(new Request(${JSON.stringify(url)}))
        console.log(JSON.stringify({body: await response.json(), status: response.status}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )
}

test('datasource list responses omit raw cursor while including structured file config', () => {
  const runRoute = runDataSourcesRoute('http://localhost/api/datasources')

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Datasource list route test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
    body: DataSourceListResponse
    status: number
  }

  expect(parsed.status).toBe(200)
  expect(parsed.body).toEqual({
    data: [
      {
        archived: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        dateFrom: null,
        dateTo: null,
        description: 'Created from upload',
        id: 'datasource-1',
        importRoute: 'structured-file:datasource-1',
        itemsAfterLastImport: 2,
        lastImportAt: '2026-01-02T00:00:00.000Z',
        structuredFileConfig,
        title: 'Created datasource',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
  })
  expect(Object.hasOwn(parsed.body.data[0], 'cursor')).toBe(false)
})

test('datasource detail responses omit raw cursor while including structured file config', () => {
  const runRoute = runDataSourcesRoute('http://localhost/api/datasources/datasource-1')

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Datasource detail route test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
    body: DataSourceDetailResponse
    status: number
  }

  expect(parsed.status).toBe(200)
  expect(parsed.body).toEqual({
    data: {
      createdAt: '2026-01-01T00:00:00.000Z',
      dateFrom: null,
      dateTo: null,
      description: 'Created from upload',
      id: 'datasource-1',
      importRoute: 'structured-file:datasource-1',
      itemsAfterLastImport: 2,
      lastImportAt: '2026-01-02T00:00:00.000Z',
      structuredFileConfig,
      title: 'Created datasource',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  })
  expect(Object.hasOwn(parsed.body.data, 'cursor')).toBe(false)
})
