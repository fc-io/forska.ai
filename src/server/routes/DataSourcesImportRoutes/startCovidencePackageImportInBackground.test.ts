import {expect, test} from 'bun:test'

type StateCall =
  | {dataSourceId: string; kind: 'failed'; message: string}
  | {dataSourceId: string; kind: 'started'; startsFresh: boolean; trigger: string}

type CovidencePackageImportResult = {
  clearCalls: string[]
  deleteCalls: string[]
  importCalls: Array<{candidateCount: number; datasourceId: string; importRoute: string}>
  rebuildRequests: Array<{projectId: string; reason: string}>
  runStatements: string[]
  runningAfterStart: boolean
  runningAfterSettle: boolean
  scopeCalls: Array<{importRoute: string; projectId: string | null}>
  seedCalls: Array<{importRoute: string; projectId: string | null}>
  stateCalls: StateCall[]
  stateCallsAfterStart: StateCall[]
  txStatements: string[]
  txStatementsAfterStart: string[]
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

const getHarnessScript = (params: {projectId: string | null; settle: 'reject' | 'resolve'}) => {
  return `
    const {mock} = await import('bun:test')

    const getModulePath = (path) => {
      return new URL(path, 'file://' + process.cwd() + '/').href
    }
    const state = {
      clearCalls: [],
      deleteCalls: [],
      importCalls: [],
      imports: [],
      rebuildRequests: [],
      runStatements: [],
      scopeCalls: [],
      seedCalls: [],
      stateCalls: [],
      txStatements: [],
    }
    const packageRows = {candidates: [{articleKey: 'a'}, {articleKey: 'b'}], warnings: {}}

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
    void mock.module(getModulePath('./src/server/services/articleImportStoreService.ts'), () => {
      return {
        articleImportStoreWorkloadContext: {
          allowsTempSpill: true,
          fallbackIntent: 'reject',
          routeOrJobKey: 'import.storeArticles',
          timeoutMs: 120000,
          workloadClass: 'background.importStore',
        },
      }
    })
    void mock.module(getModulePath('./src/server/services/covidenceImportService.ts'), () => {
      return {
        clearCovidenceSeededHumanJudgments: async (params) => {
          state.clearCalls.push(params.importRoute)
        },
        deleteCovidencePackageFiles: (datasourceId) => {
          state.deleteCalls.push(datasourceId)
        },
        getCovidencePackageCursor: (config) => {
          return JSON.stringify(config)
        },
        importCovidencePackageFromConfig: async (params) => {
          const deferred = Promise.withResolvers()
          state.importCalls.push({
            candidateCount: params.packageRows.candidates.length,
            datasourceId: params.datasourceId,
            importRoute: params.importRoute,
          })
          state.imports.push(deferred)
          return await deferred.promise
        },
        seedCovidenceHumanJudgmentsFromConfig: async (params) => {
          state.seedCalls.push({importRoute: params.importRoute, projectId: params.projectId ?? null})
        },
        syncCovidenceProjectScopeFromConfig: async (params) => {
          state.scopeCalls.push({importRoute: params.importRoute, projectId: params.projectId ?? null})
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

    const {isDataSourceImportRunningInProcess} = await import(
      './src/server/routes/DataSourcesImportRoutes/startDataSourceImportInBackground.ts'
    )
    const {startCovidencePackageImportInBackground} = await import(
      './src/server/routes/DataSourcesImportRoutes/startCovidencePackageImportInBackground.ts?test=' + Date.now()
    )
    const waitFor = async (check) => {
      const deadline = Date.now() + 5000
      while (!check() && Date.now() < deadline) {
        await Bun.sleep(5)
      }
      if (!check()) {
        throw new Error('Timed out waiting for the background Covidence import')
      }
    }

    await startCovidencePackageImportInBackground({
      config: {kind: 'covidence_import', version: 1, mode: 'full_text', files: []},
      dataSourceId: 'datasource-1',
      packageRows,
      projectId: ${JSON.stringify(params.projectId)},
      title: 'Covidence datasource',
      trigger: 'auto_resume',
    })
    const runningAfterStart = isDataSourceImportRunningInProcess('datasource-1')
    const stateCallsAfterStart = [...state.stateCalls]
    const txStatementsAfterStart = [...state.txStatements]

    await waitFor(() => {
      return state.imports.length === 1
    })
    ${
      params.settle === 'resolve'
        ? "state.imports[0].resolve({config: {}, importRouteIds: ['route-1'], packageRows, stats: {importedCount: 2, itemCount: 2}})"
        : "state.imports[0].reject(new Error('Failed to delete all rows from index'))"
    }
    await waitFor(() => {
      return !isDataSourceImportRunningInProcess('datasource-1')
    })
    await Bun.sleep(20)

    console.log(JSON.stringify({
      clearCalls: state.clearCalls,
      deleteCalls: state.deleteCalls,
      importCalls: state.importCalls,
      rebuildRequests: state.rebuildRequests,
      runStatements: state.runStatements,
      runningAfterStart,
      runningAfterSettle: isDataSourceImportRunningInProcess('datasource-1'),
      scopeCalls: state.scopeCalls,
      seedCalls: state.seedCalls,
      stateCalls: state.stateCalls,
      stateCallsAfterStart,
      txStatements: state.txStatements,
      txStatementsAfterStart,
    }))
  `
}

const runHarness = (params: {projectId: string | null; settle: 'reject' | 'resolve'}) => {
  const run = globalThis.Bun.spawnSync(['bun', '-e', getHarnessScript(params)], {cwd: process.cwd(), env: process.env})

  if (run.exitCode !== 0) {
    throw new Error(run.stderr.toString() || run.stdout.toString() || 'Covidence package import test failed')
  }

  return JSON.parse(getLastJsonLine(run.stdout.toString())) as CovidencePackageImportResult
}

test('the Covidence package import returns once the run is recorded and commits status with the import', () => {
  const result = runHarness({projectId: 'project-1', settle: 'resolve'})

  expect(result.runningAfterStart).toBe(true)
  expect(result.stateCallsAfterStart).toEqual([
    {dataSourceId: 'datasource-1', kind: 'started', startsFresh: true, trigger: 'auto_resume'},
  ])
  expect(result.txStatementsAfterStart).toEqual([])
  expect(result.runStatements).toHaveLength(1)
  expect(result.runStatements[0]).toContain('total_count = 2')
  expect(result.runStatements[0]).toContain("WHERE data_source_id = 'datasource-1'")

  expect(result.clearCalls).toEqual(['covidence:datasource-1'])
  expect(result.importCalls).toEqual([
    {candidateCount: 2, datasourceId: 'datasource-1', importRoute: 'covidence:datasource-1'},
  ])
  expect(result.scopeCalls).toEqual([{importRoute: 'covidence:datasource-1', projectId: 'project-1'}])
  expect(result.seedCalls).toEqual([{importRoute: 'covidence:datasource-1', projectId: 'project-1'}])
  expect(result.txStatements).toHaveLength(4)
  expect(result.txStatements[0]).toContain('UPDATE app.import_route')
  expect(result.txStatements[0]).toContain("'Covidence datasource'")
  expect(result.txStatements[1]).toContain('UPDATE app.data_source')
  expect(result.txStatements[1]).toContain('items_after_last_import = 2')
  expect(result.txStatements[1]).toContain('covidence_import')
  expect(result.txStatements[2]).toContain('fetched_count = run_start_fetched_count + 2')
  expect(result.txStatements[2]).toContain('total_count = 2')
  expect(result.txStatements[3]).toContain("status = 'completed'")
  expect(result.rebuildRequests).toEqual([{projectId: 'project-1', reason: 'missingReviewServingSnapshot'}])
  expect(result.stateCalls).toEqual(result.stateCallsAfterStart)
  expect(result.deleteCalls).toEqual([])
  expect(result.runningAfterSettle).toBe(false)
})

test('a failed Covidence package import is recorded as failed and keeps the stored package files', () => {
  const result = runHarness({projectId: null, settle: 'reject'})

  expect(result.runningAfterStart).toBe(true)
  expect(result.stateCalls).toEqual([
    {dataSourceId: 'datasource-1', kind: 'started', startsFresh: true, trigger: 'auto_resume'},
    {dataSourceId: 'datasource-1', kind: 'failed', message: 'Failed to delete all rows from index'},
  ])
  expect(result.txStatements).toEqual([])
  expect(result.scopeCalls).toEqual([])
  expect(result.rebuildRequests).toEqual([])
  expect(result.deleteCalls).toEqual([])
  expect(result.runningAfterSettle).toBe(false)
})
