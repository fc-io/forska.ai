import {expect, test} from 'bun:test'

type BackgroundCall = {
  candidateCount: number
  dataSourceId: string
  mode: string
  projectId: string | null
  title: string
  trigger: string
}

type CovidenceReimportResult = {
  backgroundCalls: BackgroundCall[]
  error: {message: string; status: number | null} | null
  getDataSourceCallCount: number
  result: {data: {id: string} | null; success?: boolean} | null
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

const getHarnessScript = (params: {cursor: string | null; dataSourceExists: boolean; steps: string}) => {
  return `
    const {mock} = await import('bun:test')

    const getModulePath = (path) => {
      return new URL(path, 'file://' + process.cwd() + '/').href
    }
    const state = {backgroundCalls: [], getDataSourceCallCount: 0}

    void mock.module(getModulePath('./src/server/services/covidenceImportService.ts'), () => {
      return {
        getCovidencePackageConfig: (cursor) => {
          return cursor === 'cursor-json'
            ? {kind: 'covidence_import', version: 1, mode: 'full_text', files: []}
            : null
        },
        getCovidencePackageRowsFromConfig: () => {
          return {candidates: [{articleKey: 'a'}, {articleKey: 'b'}, {articleKey: 'c'}], warnings: {}}
        },
      }
    })
    void mock.module(getModulePath('./src/server/services/dataSourceQueryService.ts'), () => {
      return {
        getDataSourceQueryService: () => {
          return {
            getDataSourceById: async (id) => {
              state.getDataSourceCallCount += 1
              return ${JSON.stringify(params.dataSourceExists)}
                ? {
                    archived: false,
                    createdAt: new Date('2026-01-01T00:00:00.000Z'),
                    cursor: ${JSON.stringify(params.cursor)},
                    dateFrom: null,
                    dateTo: null,
                    description: 'Created from Covidence package',
                    id,
                    importRoute: 'covidence:' + id,
                    itemsAfterLastImport: 3,
                    lastImportAt: new Date('2026-01-02T00:00:00.000Z'),
                    title: 'Full text datasource',
                    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
                  }
                : null
            },
          }
        },
      }
    })
    void mock.module(getModulePath('./src/server/routes/DataSourcesImportRoutes/startCovidencePackageImportInBackground.ts'), () => {
      return {
        getCovidenceImportRoute: (dataSourceId) => {
          return 'covidence:' + dataSourceId
        },
        isCovidenceImportRoute: (importRoute) => {
          return typeof importRoute === 'string' && importRoute.startsWith('covidence:')
        },
        startCovidencePackageImportInBackground: async (input) => {
          state.backgroundCalls.push({
            candidateCount: input.packageRows.candidates.length,
            dataSourceId: input.dataSourceId,
            mode: input.config.mode,
            projectId: input.projectId,
            title: input.title,
            trigger: input.trigger,
          })
        },
      }
    })

    const {dataSourcesImportRoutesPostCovidence} = await import(
      './src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.ts?test=' + Date.now()
    )
    const output = {backgroundCalls: state.backgroundCalls, error: null, getDataSourceCallCount: 0, result: null}

    try {
      ${params.steps}
    } catch (error) {
      output.error = {message: error instanceof Error ? error.message : String(error), status: error?.status ?? null}
    }

    output.getDataSourceCallCount = state.getDataSourceCallCount
    console.log(JSON.stringify(output))
  `
}

const runHarness = (params: {cursor: string | null; dataSourceExists: boolean; steps: string}) => {
  const run = globalThis.Bun.spawnSync(['bun', '-e', getHarnessScript(params)], {cwd: process.cwd(), env: process.env})

  if (run.exitCode !== 0) {
    throw new Error(run.stderr.toString() || run.stdout.toString() || 'Covidence reimport test failed')
  }

  return JSON.parse(getLastJsonLine(run.stdout.toString())) as CovidenceReimportResult
}

test('Covidence reimport starts the package import in the background and returns the datasource', () => {
  const result = runHarness({
    cursor: 'cursor-json',
    dataSourceExists: true,
    steps: `
      const manual = await dataSourcesImportRoutesPostCovidence({id: 'datasource-1'})
      await dataSourcesImportRoutesPostCovidence({id: 'datasource-1'}, {trigger: 'auto_retry'})
      output.result = manual
    `,
  })

  expect(result.error).toBeNull()
  expect(result.result?.success).toBe(true)
  expect(result.result?.data?.id).toBe('datasource-1')
  expect(result.getDataSourceCallCount).toBe(4)
  expect(result.backgroundCalls).toEqual([
    {
      candidateCount: 3,
      dataSourceId: 'datasource-1',
      mode: 'full_text',
      projectId: null,
      title: 'Full text datasource',
      trigger: 'manual',
    },
    {
      candidateCount: 3,
      dataSourceId: 'datasource-1',
      mode: 'full_text',
      projectId: null,
      title: 'Full text datasource',
      trigger: 'auto_retry',
    },
  ])
})

test('Covidence reimport rejects with 400 when the datasource cursor is not a Covidence config', () => {
  const result = runHarness({
    cursor: 'not-covidence',
    dataSourceExists: true,
    steps: `
      output.result = await dataSourcesImportRoutesPostCovidence({id: 'datasource-1'})
    `,
  })

  expect(result.result).toBeNull()
  expect(result.error).toEqual({message: 'Data source is not configured for Covidence import', status: 400})
  expect(result.backgroundCalls).toEqual([])
})

test('Covidence reimport rejects with 404 when the datasource does not exist', () => {
  const result = runHarness({
    cursor: null,
    dataSourceExists: false,
    steps: `
      output.result = await dataSourcesImportRoutesPostCovidence({id: 'missing-datasource'})
    `,
  })

  expect(result.result).toBeNull()
  expect(result.error).toEqual({message: 'Data source not found', status: 404})
  expect(result.backgroundCalls).toEqual([])
})
