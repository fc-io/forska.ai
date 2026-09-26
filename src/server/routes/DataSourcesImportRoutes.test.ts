import {expect, test} from 'bun:test'

type RouteResponse = {dataId: string | null; error: string | null; status: number; success: boolean}

type HarvestCall = {cursor: string | null; fromDate: string; importRoute: string; toDate: string}

type StateCall =
  | {dataSourceId: string; kind: 'failed'; message: string}
  | {dataSourceId: string; kind: 'started'; startsFresh: boolean; trigger: string}

type ImportLifecycleResult = {
  afterFailure: RouteResponse
  afterSuccess: RouteResponse
  duplicate: RouteResponse
  failureLogs: string[]
  first: RouteResponse
  harvestCalls: HarvestCall[]
  missing: RouteResponse
  stateCalls: StateCall[]
  updateCalls: Array<{cursor: string | null; id: string; importedCount: number}>
  updateCallsWhileRunning: number
}

type TrackedImportResult = {
  harvestCallsAfterLeaseConflict: number
  leaseCalls: string[]
  leaseConflict: RouteResponse
  leaseCallsWhileRunning: string[]
  started: RouteResponse
  stateCalls: StateCall[]
  updateCalls: Array<{cursor: string | null; id: string; importedCount: number}>
}

const harvestImportRoutes = [
  '/api/datasources/import/pubmed',
  '/api/datasources/import/europe-pmc-ppr',
  '/api/datasources/import/medrxiv',
  '/api/datasources/import/biorxiv',
  '/api/datasources/import/arxiv',
]

const trackedHarvestImportRoutes = ['/api/datasources/import/pubmed', '/api/datasources/import/europe-pmc-ppr']

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

const getRouteHarnessScript = (params: {
  claimResults: boolean[]
  route: string
  steps: string
  trackingEnabled: boolean
}) => {
  return `
    const {mock} = await import('bun:test')

    const getModulePath = (path) => {
      return new URL(path, 'file://' + process.cwd() + '/').href
    }
    const route = ${JSON.stringify(params.route)}
    const state = {
      claimResults: ${JSON.stringify(params.claimResults)},
      failureLogs: [],
      harvestCalls: [],
      harvests: [],
      leaseCalls: [],
      stateCalls: [],
      updateCalls: [],
    }
    const record = {
      archived: false,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      cursor: 'resume-cursor',
      dateFrom: new Date('2026-05-01T00:00:00.000Z'),
      dateTo: new Date('2026-09-01T00:00:00.000Z'),
      description: null,
      id: 'datasource-1',
      importRoute: route,
      itemsAfterLastImport: 0,
      lastImportAt: null,
      title: 'Harvest datasource',
      trackingEnabled: ${JSON.stringify(params.trackingEnabled)},
      trackingReconcileScheduleMonths: [3, 12],
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    }
    const harvest = async (input) => {
      const deferred = Promise.withResolvers()
      state.harvestCalls.push({
        cursor: input.cursor,
        fromDate: input.fromDate,
        importRoute: input.importRoute,
        toDate: input.toDate,
      })
      state.harvests.push(deferred)
      return await deferred.promise
    }
    const dataSourceQueryService = {
      countArticlesLinkedToImportRoute: async () => {
        return 42
      },
      getDataSourceById: async (id) => {
        return id === record.id ? record : null
      },
      updateDataSourceAfterImport: async (params) => {
        state.updateCalls.push(params)
        return {...record, cursor: params.cursor, itemsAfterLastImport: params.importedCount}
      },
    }
    const trackingRepositoryModulePath = getModulePath('./src/server/services/dataSourceTrackingRepository.ts')
    const trackingRepositoryModule = await import(trackingRepositoryModulePath)
    const importStateRepositoryModulePath = getModulePath('./src/server/services/dataSourceImportStateRepository.ts')
    const importStateRepositoryModule = await import(importStateRepositoryModulePath)
    const originalConsoleError = console.error

    console.error = (message, ...args) => {
      if (String(message).startsWith('[dataSourceImport] import failed')) {
        state.failureLogs.push([message, ...args.map((arg) => {
          return arg instanceof Error ? arg.message : String(arg)
        })].join(' '))
      }
      originalConsoleError(message, ...args)
    }

    void mock.module(getModulePath('./src/agent/pubmedHarvest.ts'), () => {
      return {pubmedHarvest: harvest}
    })
    void mock.module(getModulePath('./src/agent/europePmcPprHarvest.ts'), () => {
      return {europePmcPprHarvest: harvest}
    })
    void mock.module(getModulePath('./src/agent/startMedrxivHarvest.ts'), () => {
      return {startMedrxivHarvest: harvest}
    })
    void mock.module(getModulePath('./src/agent/startBiorxivHarvest.ts'), () => {
      return {startBiorxivHarvest: harvest}
    })
    void mock.module(getModulePath('./src/agent/startArxivHarvest.ts'), () => {
      return {startArxivHarvest: harvest}
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
    void mock.module(trackingRepositoryModulePath, () => {
      return {
        ...trackingRepositoryModule,
        createDataSourceTrackingRepository: () => {
          return {
            claimImportLease: async (input) => {
              state.leaseCalls.push('claim')
              return state.claimResults.shift() ? {leaseOwner: input.leaseOwner} : null
            },
            releaseSourceLease: async () => {
              state.leaseCalls.push('release')
              return null
            },
            renewSourceLease: async (input) => {
              return {leaseOwner: input.leaseOwner}
            },
          }
        },
      }
    })

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
    const postImport = async (id = record.id) => {
      const response = await app.handle(
        new Request('http://localhost' + route, {
          body: JSON.stringify({id}),
          headers: {'content-type': 'application/json'},
          method: 'POST',
        }),
      )
      const text = await response.text()
      const body = text.startsWith('{') ? JSON.parse(text) : text

      return {
        dataId: body?.data?.id ?? null,
        error: typeof body === 'string' ? body : (body.error ?? null),
        status: response.status,
        success: body?.success === true,
      }
    }
    const waitFor = async (check) => {
      const deadline = Date.now() + 5000
      while (!check() && Date.now() < deadline) {
        await Bun.sleep(5)
      }
      if (!check()) {
        throw new Error('Timed out waiting for background datasource import')
      }
    }

    ${params.steps}
  `
}

const runRouteHarness = <T>(params: {
  claimResults?: boolean[]
  route: string
  steps: string
  trackingEnabled?: boolean
}) => {
  const runRoute = globalThis.Bun.spawnSync(
    [
      'bun',
      '-e',
      getRouteHarnessScript({
        claimResults: params.claimResults ?? [],
        route: params.route,
        steps: params.steps,
        trackingEnabled: params.trackingEnabled ?? false,
      }),
    ],
    {cwd: process.cwd(), env: process.env},
  )

  if (runRoute.exitCode !== 0) {
    throw new Error(runRoute.stderr.toString() || runRoute.stdout.toString() || 'Datasource import route test failed')
  }

  return JSON.parse(getLastJsonLine(runRoute.stdout.toString())) as T
}

const importLifecycleSteps = `
  const first = await postImport()
  const updateCallsWhileRunning = state.updateCalls.length
  const duplicate = await postImport()

  state.harvests[0].resolve()
  await waitFor(() => {
    return state.updateCalls.length === 1
  })
  const afterSuccess = await postImport()

  state.harvests[1].reject(new Error('Europe PMC unavailable'))
  await waitFor(() => {
    return state.failureLogs.length === 1
  })
  const afterFailure = await postImport()

  state.harvests[2].resolve()
  await waitFor(() => {
    return state.updateCalls.length === 2
  })
  const missing = await postImport('missing-datasource')

  console.log(JSON.stringify({
    afterFailure,
    afterSuccess,
    duplicate,
    failureLogs: state.failureLogs,
    first,
    harvestCalls: state.harvestCalls,
    missing,
    stateCalls: state.stateCalls,
    updateCalls: state.updateCalls,
    updateCallsWhileRunning,
  }))
`

const trackedImportSteps = `
  const leaseConflict = await postImport()
  const harvestCallsAfterLeaseConflict = state.harvestCalls.length
  const started = await postImport()
  const leaseCallsWhileRunning = [...state.leaseCalls]

  state.harvests[0].resolve()
  await waitFor(() => {
    return state.leaseCalls.at(-1) === 'release'
  })

  console.log(JSON.stringify({
    harvestCallsAfterLeaseConflict,
    leaseCalls: state.leaseCalls,
    leaseConflict,
    leaseCallsWhileRunning,
    started,
    stateCalls: state.stateCalls,
    updateCalls: state.updateCalls,
  }))
`

test.each(harvestImportRoutes)(
  '%s starts the harvest in the background, rejects duplicates while it runs, and releases the guard afterwards',
  (route) => {
    const result = runRouteHarness<ImportLifecycleResult>({route, steps: importLifecycleSteps})

    expect(result.first).toEqual({dataId: 'datasource-1', error: null, status: 200, success: true})
    expect(result.updateCallsWhileRunning).toBe(0)
    expect(result.duplicate).toEqual({
      dataId: null,
      error: 'An import is already running for this data source',
      status: 409,
      success: false,
    })
    expect(result.afterSuccess).toEqual({dataId: 'datasource-1', error: null, status: 200, success: true})
    expect(result.afterFailure).toEqual({dataId: 'datasource-1', error: null, status: 200, success: true})
    expect(result.harvestCalls).toEqual([
      {cursor: 'resume-cursor', fromDate: '2026-05-01', importRoute: route, toDate: '2026-09-01'},
      {cursor: 'resume-cursor', fromDate: '2026-05-01', importRoute: route, toDate: '2026-09-01'},
      {cursor: 'resume-cursor', fromDate: '2026-05-01', importRoute: route, toDate: '2026-09-01'},
    ])
    expect(result.updateCalls).toEqual([
      {cursor: null, id: 'datasource-1', importedCount: 42},
      {cursor: null, id: 'datasource-1', importedCount: 42},
    ])
    expect(result.failureLogs).toEqual([
      '[dataSourceImport] import failed for data source datasource-1 Europe PMC unavailable',
    ])
    expect(result.missing.error).toBe('Data source not found')
    expect(result.missing.success).toBe(false)
    expect(result.stateCalls).toEqual([
      {dataSourceId: 'datasource-1', kind: 'started', startsFresh: false, trigger: 'manual'},
      {dataSourceId: 'datasource-1', kind: 'started', startsFresh: false, trigger: 'manual'},
      {dataSourceId: 'datasource-1', kind: 'failed', message: 'Europe PMC unavailable'},
      {dataSourceId: 'datasource-1', kind: 'started', startsFresh: false, trigger: 'manual'},
    ])
  },
  30_000,
)

test.each(trackedHarvestImportRoutes)(
  '%s reports a held tracking lease as 409 before starting and keeps the lease for the background harvest',
  (route) => {
    const result = runRouteHarness<TrackedImportResult>({
      claimResults: [false, true],
      route,
      steps: trackedImportSteps,
      trackingEnabled: true,
    })

    expect(result.leaseConflict).toEqual({
      dataId: null,
      error: 'Data source tracking import is already running',
      status: 409,
      success: false,
    })
    expect(result.harvestCallsAfterLeaseConflict).toBe(0)
    expect(result.started).toEqual({dataId: 'datasource-1', error: null, status: 200, success: true})
    expect(result.leaseCallsWhileRunning).toEqual(['claim', 'claim'])
    expect(result.leaseCalls).toEqual(['claim', 'claim', 'release'])
    expect(result.updateCalls).toEqual([{cursor: null, id: 'datasource-1', importedCount: 42}])
    expect(result.stateCalls).toEqual([
      {dataSourceId: 'datasource-1', kind: 'started', startsFresh: false, trigger: 'manual'},
    ])
  },
  30_000,
)
