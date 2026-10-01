import {expect, test} from 'bun:test'

type RouteResponse = {
  dataSourceId: string | null
  error: string | null
  projectId: string | null
  status: number
  success: boolean
}

type StateCall =
  | {dataSourceId: string; kind: 'failed'; message: string}
  | {dataSourceId: string; kind: 'started'; startsFresh: boolean; trigger: string}

type CovidenceRouteLifecycleResult = {
  completedStatementsAfterCreate: number
  completedStatementsWhileCreateRunning: number
  completedStatementsWhileReimportRunning: number
  created: RouteResponse
  deleteCalls: string[]
  duplicate: RouteResponse
  importCalls: Array<{candidateCount: number; importRoute: string}>
  missing: RouteResponse
  notConfigured: RouteResponse
  rebuildRequests: Array<{projectId: string; reason: string}>
  reimport: RouteResponse
  stateCalls: StateCall[]
  totalStatements: string[]
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

const covidenceRouteHarnessScript = `
  const {mock} = await import('bun:test')

  const getModulePath = (path) => {
    return new URL(path, 'file://' + process.cwd() + '/').href
  }
  const state = {
    deleteCalls: [],
    importCalls: [],
    imports: [],
    rebuildRequests: [],
    runStatements: [],
    stateCalls: [],
    txStatements: [],
  }
  const packageRows = {
    candidates: [{articleKey: 'a'}, {articleKey: 'b'}, {articleKey: 'c'}],
    warnings: {conflictingStageMemberships: [], duplicateStudyGroups: [], missingMatches: [], studyDecisionConflicts: []},
  }
  const getRecord = (id) => {
    return {
      archived: false,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      cursor: id === 'not-configured' ? 'plain-cursor' : 'cursor-json',
      dateFrom: null,
      dateTo: null,
      description: null,
      id,
      importRoute: 'covidence:' + id,
      itemsAfterLastImport: 0,
      lastImportAt: null,
      title: 'Covidence datasource',
      trackingEnabled: false,
      trackingReconcileScheduleMonths: [3, 12],
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    }
  }
  const dataSourceQueryService = {
    countArticlesLinkedToImportRoute: async () => {
      return 0
    },
    getDataSourceById: async (id) => {
      return id === 'missing' ? null : getRecord(id)
    },
    updateDataSourceAfterImport: async (params) => {
      return getRecord(params.id)
    },
  }

  void mock.module(getModulePath('./src/server/services/appDatabaseService.ts'), () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async () => {
            return []
          },
          run: async (statement) => {
            state.runStatements.push(statement)
          },
          transaction: async (work) => {
            return await work({
              queryJson: async () => {
                return []
              },
              run: async (statement) => {
                state.txStatements.push(statement)
              },
            })
          },
        }
      },
    }
  })
  void mock.module(getModulePath('./src/server/services/covidenceImportService.ts'), () => {
    return {
      analyzeCovidencePackageFiles: async () => {
        return {data: null, ok: true}
      },
      buildCovidencePackageConfig: (params) => {
        return {kind: 'covidence_import', version: 1, ...params}
      },
      buildCovidencePromptDefinition: () => {
        return {originalText: 'Prompt body', promptHeading: 'Prompt heading', type: "'yes' | 'no'"}
      },
      buildCovidencePromptDefinitionsForEligibilityFields: () => {
        return []
      },
      clearCovidenceSeededHumanJudgments: async () => {},
      deleteCovidencePackageFiles: (datasourceId) => {
        state.deleteCalls.push(datasourceId)
      },
      getCovidencePackageConfig: (cursor) => {
        return cursor === 'cursor-json' ? {kind: 'covidence_import', version: 1, mode: 'title_abstract', files: []} : null
      },
      getCovidencePackageCursor: (config) => {
        return JSON.stringify(config)
      },
      getCovidencePackageRowsFromConfig: () => {
        return packageRows
      },
      getOrCreateCovidenceProject: async (params) => {
        return {
          created: true,
          humanJudgmentMode: 'summary',
          id: 'project-1',
          modelId: 'model-1',
          name: params.title,
          useAbstract: true,
          useFulltext: false,
          useFulltextNoImages: false,
          useTitle: true,
        }
      },
      getOrCreateCovidencePrompt: async () => {
        return null
      },
      importCovidencePackageInBatches: async (params) => {
        const deferred = Promise.withResolvers()
        state.importCalls.push({candidateCount: params.packageRows.candidates.length, importRoute: params.importRoute})
        state.imports.push(deferred)
        const result = await deferred.promise
        await params.onBatchStored?.({storedCount: 3, totalCount: 3})
        return result
      },
      seedCovidenceHumanJudgmentsFromConfig: async () => {},
      storeCovidencePackageFiles: async (params) => {
        return params.files.map((entry) => {
          return {
            assetPath: 'assets/covidence_imports/' + params.datasourceId + '/' + entry.fileRole + '.csv',
            fileRole: entry.fileRole,
            format: 'csv',
            sourceFileName: entry.file.name,
          }
        })
      },
      syncCovidenceProjectPrompts: async () => {},
      syncCovidenceProjectScopeFromConfig: async () => {},
    }
  })
  void mock.module(getModulePath('./src/server/services/dataSourceQueryService.ts'), () => {
    return {
      createDataSourceCursorUpdater: () => {
        return async () => {
          return undefined
        }
      },
      dataSourceQueryService,
      getDataSourceQueryService: () => {
        return dataSourceQueryService
      },
      updateDataSourceCursor: async () => {
        return undefined
      },
    }
  })
  void mock.module(getModulePath('./src/server/reviewServing/reviewServingV4RebuildRequestService.ts'), () => {
    return {
      requestReviewServingV4Rebuild: async (input) => {
        state.rebuildRequests.push(input)
        return null
      },
    }
  })
  const importStateRepositoryModulePath = getModulePath('./src/server/services/dataSourceImportStateRepository.ts')
  const importStateRepositoryModule = await import(importStateRepositoryModulePath)
  void mock.module(importStateRepositoryModulePath, () => {
    return {
      ...importStateRepositoryModule,
      getDataSourceImportStateRepository: () => {
        return {
          listResumeCandidates: async () => {
            return []
          },
          markRunFailed: async (input) => {
            state.stateCalls.push({
              dataSourceId: input.dataSourceId,
              kind: 'failed',
              message: input.error instanceof Error ? input.error.message : String(input.error),
            })
            return null
          },
          markRunStarted: async (input) => {
            state.stateCalls.push({
              dataSourceId: input.dataSourceId,
              kind: 'started',
              startsFresh: input.startsFresh,
              trigger: input.trigger,
            })
          },
          markRunStopped: async () => {
            return undefined
          },
        }
      },
    }
  })

  const {Elysia} = await import('elysia')
  const {dataSourcesImportRoutes} = await import('./src/server/routes/DataSourcesImportRoutes.ts?test=' + Date.now())
  const app = new Elysia().use(dataSourcesImportRoutes)
  const parseResponse = async (response) => {
    const text = await response.text()
    const body = text.startsWith('{') ? JSON.parse(text) : text

    return {
      dataSourceId: body?.data?.dataSource?.id ?? body?.data?.id ?? null,
      error: typeof body === 'string' ? body : (body.error ?? null),
      projectId: body?.data?.covidenceProject?.id ?? null,
      status: response.status,
      success: body?.success === true,
    }
  }
  const postCreate = async () => {
    const formData = new FormData()
    formData.append('title', 'Covidence datasource')
    formData.append('mode', 'title_abstract')
    formData.append('files[0].file', new File(['a,b'], 'all.csv', {type: 'text/csv'}))
    formData.append('files[0].fileRole', 'all')
    formData.append('files[1].file', new File(['a,b'], 'irrelevant.csv', {type: 'text/csv'}))
    formData.append('files[1].fileRole', 'irrelevant')
    formData.append('files[2].file', new File(['a,b'], 'full_text.csv', {type: 'text/csv'}))
    formData.append('files[2].fileRole', 'full_text')

    return await parseResponse(
      await app.handle(
        new Request('http://localhost/api/datasources/import/covidence-create', {body: formData, method: 'POST'}),
      ),
    )
  }
  const postReimport = async (id) => {
    return await parseResponse(
      await app.handle(
        new Request('http://localhost/api/datasources/import/covidence', {
          body: JSON.stringify({id}),
          headers: {'content-type': 'application/json'},
          method: 'POST',
        }),
      ),
    )
  }
  const countCompletedStatements = () => {
    return state.txStatements.filter((statement) => {
      return statement.includes("status = 'completed'")
    }).length
  }
  const waitFor = async (check) => {
    const deadline = Date.now() + 5000
    while (!check() && Date.now() < deadline) {
      await Bun.sleep(5)
    }
    if (!check()) {
      throw new Error('Timed out waiting for the background Covidence import')
    }
  }

  const created = await postCreate()
  const completedStatementsWhileCreateRunning = countCompletedStatements()
  const duplicate = await postReimport(created.dataSourceId)

  await waitFor(() => {
    return state.imports.length === 1
  })
  state.imports[0].resolve({config: {}, importRouteIds: ['route-1'], packageRows, stats: {importedCount: 3, itemCount: 3}})
  await waitFor(() => {
    return countCompletedStatements() === 1 && state.rebuildRequests.length === 1
  })
  const completedStatementsAfterCreate = countCompletedStatements()

  const reimport = await postReimport('datasource-1')
  const completedStatementsWhileReimportRunning = countCompletedStatements()

  await waitFor(() => {
    return state.imports.length === 2
  })
  state.imports[1].reject(new Error('DuckDB write conflict'))
  await waitFor(() => {
    return state.stateCalls.some((call) => {
      return call.kind === 'failed'
    })
  })

  const notConfigured = await postReimport('not-configured')
  const missing = await postReimport('missing')

  console.log(JSON.stringify({
    completedStatementsAfterCreate,
    completedStatementsWhileCreateRunning,
    completedStatementsWhileReimportRunning,
    created,
    deleteCalls: state.deleteCalls,
    duplicate,
    importCalls: state.importCalls,
    missing,
    notConfigured,
    rebuildRequests: state.rebuildRequests,
    reimport,
    stateCalls: state.stateCalls,
    totalStatements: state.runStatements,
    txStatements: state.txStatements,
  }))
`

const runCovidenceRouteHarness = () => {
  const runRoute = globalThis.Bun.spawnSync(['bun', '-e', covidenceRouteHarnessScript], {
    cwd: process.cwd(),
    env: process.env,
  })

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Covidence import route test failed')
  }

  return JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as CovidenceRouteLifecycleResult
}

test('Covidence create and reimport answer before the package import finishes and track it as a background import', () => {
  const result = runCovidenceRouteHarness()

  expect(result.created.status).toBe(200)
  expect(result.created.success).toBe(true)
  expect(result.created.projectId).toBe('project-1')
  expect(result.created.dataSourceId).not.toBeNull()
  expect(result.completedStatementsWhileCreateRunning).toBe(0)
  expect(result.importCalls).toEqual([
    {candidateCount: 3, importRoute: `covidence:${result.created.dataSourceId}`},
    {candidateCount: 3, importRoute: 'covidence:datasource-1'},
  ])
  expect(result.txStatements[0]).toContain('INSERT INTO app.data_source')
  expect(result.txStatements[1]).toContain('INSERT INTO app.import_route')
  expect(result.txStatements[1]).toContain("'Covidence datasource'")

  expect(result.duplicate).toEqual({
    dataSourceId: null,
    error: 'An import is already running for this data source',
    projectId: null,
    status: 409,
    success: false,
  })

  expect(result.completedStatementsAfterCreate).toBe(1)
  expect(result.rebuildRequests).toEqual([{projectId: 'project-1', reason: 'missingReviewServingSnapshot'}])
  expect(result.totalStatements).toHaveLength(3)
  expect(result.totalStatements[0]).toContain('fetched_count = run_start_fetched_count + 0')
  expect(result.totalStatements[0]).toContain('total_count = 3')
  expect(result.totalStatements[1]).toContain('fetched_count = run_start_fetched_count + 3')
  expect(result.totalStatements[2]).toContain('fetched_count = run_start_fetched_count + 0')
  expect(
    result.txStatements.slice(2, 6).map((statement) => {
      return statement.trim().split(/\s+/).slice(0, 3).join(' ')
    }),
  ).toEqual([
    'UPDATE app.import_route SET',
    'UPDATE app.data_source SET',
    'UPDATE app.data_source_import_state SET',
    'UPDATE app.data_source_import_state SET',
  ])
  expect(result.txStatements[3]).toContain('items_after_last_import = 3')
  expect(result.txStatements[4]).toContain('fetched_count = run_start_fetched_count + 3')

  expect(result.reimport).toEqual({
    dataSourceId: 'datasource-1',
    error: null,
    projectId: null,
    status: 200,
    success: true,
  })
  expect(result.completedStatementsWhileReimportRunning).toBe(1)
  expect(result.deleteCalls).toEqual([])
  expect(result.stateCalls).toEqual([
    {dataSourceId: result.created.dataSourceId ?? '', kind: 'started', startsFresh: true, trigger: 'manual'},
    {dataSourceId: 'datasource-1', kind: 'started', startsFresh: true, trigger: 'manual'},
    {dataSourceId: 'datasource-1', kind: 'failed', message: 'DuckDB write conflict'},
  ])

  expect(result.notConfigured).toEqual({
    dataSourceId: null,
    error: 'Data source is not configured for Covidence import',
    projectId: null,
    status: 400,
    success: false,
  })
  expect(result.missing).toEqual({
    dataSourceId: null,
    error: 'Data source not found',
    projectId: null,
    status: 404,
    success: false,
  })
}, 30_000)
