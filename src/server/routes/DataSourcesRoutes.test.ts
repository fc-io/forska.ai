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

type CovidencePackageConfigResponse = {
  files: Array<{
    assetPath: string
    fileRole: 'all' | 'irrelevant' | 'full_text' | 'excluded' | 'included'
    format: 'csv' | 'ris'
    sourceFileName: string
  }>
  kind: 'covidence_import'
  mode: 'title_abstract' | 'full_text'
  version: 1
}

type DataSourceResponseEntry = {
  archived: boolean
  covidencePackageConfig: CovidencePackageConfigResponse | null
  createdAt: string
  dateFrom: null
  dateTo: null
  description: string
  id: string
  immutable: boolean
  importRoute: string
  itemsAfterLastImport: number
  lastImportAt: string
  linkedProjectId: string | null
  linkedPromptIds: string[]
  reimportable: boolean
  structuredFileConfig: StructuredFileConfigResponse | null
  title: string
  updatedAt: string
}

type DataSourceListResponse = {data: DataSourceResponseEntry[]}
type DataSourceDetailResponse = {data: DataSourceResponseEntry}
type MockQueryRow = {
  archived: boolean
  createdAt: string
  cursor: string | null
  dateFrom: null
  dateTo: null
  description: string
  id: string
  importRoute: string
  itemsAfterLastImport: number
  lastImportAt: string
  title: string
  updatedAt: string
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

const covidencePackageConfig: CovidencePackageConfigResponse = {
  files: [
    {
      assetPath: 'assets/covidence_imports/datasource-2/all-all.csv',
      fileRole: 'all',
      format: 'csv',
      sourceFileName: 'all.csv',
    },
    {
      assetPath: 'assets/covidence_imports/datasource-2/irrelevant-irrelevant.csv',
      fileRole: 'irrelevant',
      format: 'csv',
      sourceFileName: 'irrelevant.csv',
    },
    {
      assetPath: 'assets/covidence_imports/datasource-2/full_text-full_text.ris',
      fileRole: 'full_text',
      format: 'ris',
      sourceFileName: 'full_text.ris',
    },
  ],
  kind: 'covidence_import',
  mode: 'title_abstract',
  version: 1,
}

const structuredRow: MockQueryRow = {
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  cursor: JSON.stringify(structuredFileConfig),
  dateFrom: null,
  dateTo: null,
  description: 'Created from upload',
  id: 'datasource-1',
  importRoute: 'imported-file:Created datasource',
  itemsAfterLastImport: 2,
  lastImportAt: '2026-01-02T00:00:00.000Z',
  title: 'Created datasource',
  updatedAt: '2026-01-02T00:00:00.000Z',
}

const covidenceRow: MockQueryRow = {
  archived: false,
  createdAt: '2026-02-01T00:00:00.000Z',
  cursor: JSON.stringify(covidencePackageConfig),
  dateFrom: null,
  dateTo: null,
  description: 'Imported from Covidence',
  id: 'datasource-2',
  importRoute: 'covidence:datasource-2',
  itemsAfterLastImport: 4,
  lastImportAt: '2026-02-02T00:00:00.000Z',
  title: 'Covidence datasource',
  updatedAt: '2026-02-02T00:00:00.000Z',
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

const runDataSourcesRoute = (params: {
  covidenceProjectLinks?: Array<{importRoute: string; projectId: string}>
  covidencePromptLinks?: Array<{importRoute: string; promptId: string}>
  row: MockQueryRow
  url: string
}) => {
  return globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {Elysia} = await import('elysia')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const row = ${JSON.stringify(params.row)}
        const covidenceProjectLinks = ${JSON.stringify(params.covidenceProjectLinks ?? [])}
        const covidencePromptLinks = ${JSON.stringify(params.covidencePromptLinks ?? [])}

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async (statement) => {
                  return statement.includes('INNER JOIN app.project_prompt')
                    ? covidencePromptLinks
                    : statement.includes('FROM app.project_import_route')
                      ? covidenceProjectLinks
                      : statement.includes("WHERE id = '" + row.id + "'")
                        ? [row]
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
        const response = await app.handle(new Request(${JSON.stringify(params.url)}))
        console.log(JSON.stringify({body: await response.json(), status: response.status}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )
}

test('datasource list responses omit raw cursor while including structured file config', () => {
  const runRoute = runDataSourcesRoute({row: structuredRow, url: 'http://localhost/api/datasources'})

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Datasource list route test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
    body: DataSourceListResponse
    status: number
  }

  expect(parsed.status).toBe(200)
  expect(parsed.body.data).toHaveLength(1)
  expect(parsed.body).toEqual({
    data: [
      {
        archived: false,
        covidencePackageConfig: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        dateFrom: null,
        dateTo: null,
        description: 'Created from upload',
        id: 'datasource-1',
        immutable: true,
        importRoute: 'imported-file:Created datasource',
        itemsAfterLastImport: 2,
        lastImportAt: '2026-01-02T00:00:00.000Z',
        linkedProjectId: null,
        linkedPromptIds: [],
        reimportable: false,
        structuredFileConfig,
        title: 'Created datasource',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
  })
  expect(Object.hasOwn(parsed.body.data[0] as object, 'cursor')).toBe(false)
})

test('datasource detail responses omit raw cursor while including structured file config', () => {
  const runRoute = runDataSourcesRoute({row: structuredRow, url: 'http://localhost/api/datasources/datasource-1'})

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
      archived: false,
      covidencePackageConfig: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      dateFrom: null,
      dateTo: null,
      description: 'Created from upload',
      id: 'datasource-1',
      immutable: true,
      importRoute: 'imported-file:Created datasource',
      itemsAfterLastImport: 2,
      lastImportAt: '2026-01-02T00:00:00.000Z',
      linkedProjectId: null,
      linkedPromptIds: [],
      reimportable: false,
      structuredFileConfig,
      title: 'Created datasource',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  })
  expect(Object.hasOwn(parsed.body.data, 'cursor')).toBe(false)
})

test('covidence datasource responses expose package config and linked project and prompt ids', () => {
  const runRoute = runDataSourcesRoute({
    covidenceProjectLinks: [{importRoute: 'covidence:datasource-2', projectId: 'project-covidence-1'}],
    covidencePromptLinks: [
      {importRoute: 'covidence:datasource-2', promptId: 'prompt-covidence-1'},
      {importRoute: 'covidence:datasource-2', promptId: 'prompt-covidence-2'},
    ],
    row: covidenceRow,
    url: 'http://localhost/api/datasources/datasource-2',
  })

  if (runRoute.exitCode !== 0) {
    throw new Error(
      runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence datasource route test failed',
    )
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
    body: DataSourceDetailResponse
    status: number
  }

  expect(parsed.status).toBe(200)
  expect(parsed.body).toEqual({
    data: {
      archived: false,
      covidencePackageConfig,
      createdAt: '2026-02-01T00:00:00.000Z',
      dateFrom: null,
      dateTo: null,
      description: 'Imported from Covidence',
      id: 'datasource-2',
      immutable: true,
      importRoute: 'covidence:datasource-2',
      itemsAfterLastImport: 4,
      lastImportAt: '2026-02-02T00:00:00.000Z',
      linkedProjectId: 'project-covidence-1',
      linkedPromptIds: ['prompt-covidence-1', 'prompt-covidence-2'],
      reimportable: true,
      structuredFileConfig: null,
      title: 'Covidence datasource',
      updatedAt: '2026-02-02T00:00:00.000Z',
    },
  })
  expect(Object.hasOwn(parsed.body.data, 'cursor')).toBe(false)
})

test('structured file datasource patch rejects non-archive edits', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {Elysia} = await import('elysia')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const row = ${JSON.stringify(structuredRow)}
        const state = {transactionCallCount: 0}

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async () => [row],
                run: async () => {},
                transaction: async () => {
                  state.transactionCallCount += 1
                  throw new Error('transaction should not be used')
                },
              }
            },
          }
        })

        const {dataSourcesRoutes} = await import('./src/server/routes/DataSourcesRoutes.ts?test=' + Date.now())
        const app = new Elysia().use(dataSourcesRoutes)
        const response = await app.handle(
          new Request('http://localhost/api/datasources/datasource-1', {
            method: 'PATCH',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({title: 'Edited title'}),
          }),
        )
        console.log(JSON.stringify({body: await response.text(), status: response.status, transactionCallCount: state.transactionCallCount}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(
      runRoute.stderr.toString() || runRoute.stdout.toString() || 'Datasource patch rejection test failed',
    )
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
    body: string
    status: number
    transactionCallCount: number
  }

  expect(parsed.status).toBe(500)
  expect(parsed.body).toContain('Imported XML/JSON data sources are immutable and can only be archived')
  expect(parsed.transactionCallCount).toBe(0)
})

test('covidence datasource patch rejects non-archive edits', () => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      `
        const {mock} = await import('bun:test')
        const {Elysia} = await import('elysia')

        const appDatabaseServiceModulePath = new URL('./src/server/services/appDatabaseService.ts', 'file://' + process.cwd() + '/').pathname
        const row = ${JSON.stringify(covidenceRow)}
        const state = {transactionCallCount: 0}

        void mock.module(appDatabaseServiceModulePath, () => {
          return {
            getAppDatabaseService: () => {
              return {
                queryJson: async () => [row],
                run: async () => {},
                transaction: async () => {
                  state.transactionCallCount += 1
                  throw new Error('transaction should not be used')
                },
              }
            },
          }
        })

        const {dataSourcesRoutes} = await import('./src/server/routes/DataSourcesRoutes.ts?test=' + Date.now())
        const app = new Elysia().use(dataSourcesRoutes)
        const response = await app.handle(
          new Request('http://localhost/api/datasources/datasource-2', {
            method: 'PATCH',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({title: 'Edited title'}),
          }),
        )
        console.log(JSON.stringify({body: await response.text(), status: response.status, transactionCallCount: state.transactionCallCount}))
      `,
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence patch rejection test failed')
  }

  const parsed = JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as {
    body: string
    status: number
    transactionCallCount: number
  }

  expect(parsed.status).toBe(500)
  expect(parsed.body).toContain('Imported XML/JSON data sources are immutable and can only be archived')
  expect(parsed.transactionCallCount).toBe(0)
})
