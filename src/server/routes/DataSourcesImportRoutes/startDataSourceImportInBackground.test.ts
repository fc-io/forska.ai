import {afterEach, expect, test} from 'bun:test'

import {createDuckdbShuttingDownError} from '../../utils/duckdbShuttingDownError.ts'
import {HttpError} from '../../utils/httpError.ts'
import {markServerShutdownStarted, resetServerShutdownStateForTests} from '../../utils/serverShutdownState.ts'
import {
  isDataSourceImportRunningInProcess,
  startDataSourceImportInBackground,
} from './startDataSourceImportInBackground.ts'

type StateCall =
  | {dataSourceId: string; kind: 'failed'; message: string; runningInProcess: boolean}
  | {dataSourceId: string; kind: 'started'; startsFresh: boolean; trigger: string}

const createStateStore = (calls: StateCall[]) => {
  return {
    markRunFailed: async (input: {dataSourceId: string; error: unknown; now: Date}) => {
      calls.push({
        dataSourceId: input.dataSourceId,
        kind: 'failed',
        message: input.error instanceof Error ? input.error.message : String(input.error),
        runningInProcess: isDataSourceImportRunningInProcess(input.dataSourceId),
      })
      return null
    },
    markRunStarted: async (input: {dataSourceId: string; startsFresh: boolean; trigger: string}) => {
      calls.push({
        dataSourceId: input.dataSourceId,
        kind: 'started',
        startsFresh: input.startsFresh,
        trigger: input.trigger,
      })
    },
  }
}

afterEach(() => {
  resetServerShutdownStateForTests()
})

const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 5000

  while (!check() && Date.now() < deadline) {
    await globalThis.Bun.sleep(5)
  }

  expect(check()).toBe(true)
}

test('background datasource import returns once started and rejects a second start until it settles', async () => {
  const harvest = Promise.withResolvers<undefined>()
  const events: string[] = []
  const stateCalls: StateCall[] = []
  const stateStore = createStateStore(stateCalls)

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-success',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async (markImportStarted) => {
      await markImportStarted()
      await harvest.promise
      events.push('updated')
    },
    startsFresh: false,
    stateStore,
    trigger: 'manual',
  })

  expect(events).toEqual([])
  expect(isDataSourceImportRunningInProcess('guard-success')).toBe(true)
  const duplicate = startDataSourceImportInBackground({
    dataSourceId: 'guard-success',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async (markImportStarted) => {
      await markImportStarted()
      events.push('duplicate-ran')
    },
    startsFresh: false,
    stateStore,
    trigger: 'auto_resume',
  })

  const duplicateError = await duplicate.catch((error: unknown) => {
    return error
  })

  expect(duplicateError).toBeInstanceOf(HttpError)
  expect((duplicateError as HttpError).status).toBe(409)

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-other-source',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async (markImportStarted) => {
      await markImportStarted()
      events.push('other-source-ran')
    },
    startsFresh: true,
    stateStore,
    trigger: 'manual',
  })

  harvest.resolve(undefined)
  await waitFor(() => {
    return events.includes('updated')
  })

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-success',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async (markImportStarted) => {
      await markImportStarted()
      events.push('restarted')
    },
    startsFresh: false,
    stateStore,
    trigger: 'auto_retry',
  })

  expect(events).toEqual(['other-source-ran', 'updated', 'restarted'])
  expect(stateCalls).toEqual([
    {dataSourceId: 'guard-success', kind: 'started', startsFresh: false, trigger: 'manual'},
    {dataSourceId: 'guard-other-source', kind: 'started', startsFresh: true, trigger: 'manual'},
    {dataSourceId: 'guard-success', kind: 'started', startsFresh: false, trigger: 'auto_retry'},
  ])
})

test('background datasource import records a failure while it still holds the guard, then releases it', async () => {
  const harvest = Promise.withResolvers<undefined>()
  const runs: string[] = []
  const stateCalls: StateCall[] = []
  const stateStore = createStateStore(stateCalls)

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-failure',
    importRoute: '/api/datasources/import/medrxiv',
    runImport: async (markImportStarted) => {
      await markImportStarted()
      await harvest.promise
    },
    startsFresh: true,
    stateStore,
    trigger: 'manual',
  })

  harvest.reject(new Error('harvest failed'))
  await waitFor(() => {
    return !isDataSourceImportRunningInProcess('guard-failure')
  })

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-failure',
    importRoute: '/api/datasources/import/medrxiv',
    runImport: async (markImportStarted) => {
      await markImportStarted()
      runs.push('restarted')
    },
    startsFresh: false,
    stateStore,
    trigger: 'manual',
  })

  expect(runs).toEqual(['restarted'])
  expect(stateCalls).toEqual([
    {dataSourceId: 'guard-failure', kind: 'started', startsFresh: true, trigger: 'manual'},
    {dataSourceId: 'guard-failure', kind: 'failed', message: 'harvest failed', runningInProcess: true},
    {dataSourceId: 'guard-failure', kind: 'started', startsFresh: false, trigger: 'manual'},
  ])
})

test('background datasource import surfaces failures that happen before the import starts without recording them', async () => {
  const stateCalls: StateCall[] = []
  const stateStore = createStateStore(stateCalls)
  const start = startDataSourceImportInBackground({
    dataSourceId: 'guard-before-start',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async () => {
      throw new HttpError(409, 'Data source tracking import is already running')
    },
    startsFresh: false,
    stateStore,
    trigger: 'manual',
  })

  const startError = await start.catch((error: unknown) => {
    return error
  })

  expect(startError).toBeInstanceOf(HttpError)
  expect((startError as HttpError).message).toBe('Data source tracking import is already running')
  expect(stateCalls).toEqual([])

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-before-start',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async (markImportStarted) => {
      await markImportStarted()
    },
    startsFresh: false,
    stateStore,
    trigger: 'manual',
  })

  expect(stateCalls).toEqual([
    {dataSourceId: 'guard-before-start', kind: 'started', startsFresh: false, trigger: 'manual'},
  ])
})

test('background datasource import fails to start when the running state cannot be written', async () => {
  const start = startDataSourceImportInBackground({
    dataSourceId: 'guard-state-write',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async (markImportStarted) => {
      await markImportStarted()
    },
    startsFresh: false,
    stateStore: {
      markRunFailed: async () => {
        return null
      },
      markRunStarted: async () => {
        throw new Error('DuckDB connection not started')
      },
    },
    trigger: 'manual',
  })

  const startError = await start.catch((error: unknown) => {
    return error
  })

  expect(String(startError)).toContain('DuckDB connection not started')
  expect(isDataSourceImportRunningInProcess('guard-state-write')).toBe(false)
})

test('background datasource import stopped by the DuckDB shutdown rejection stays resumable instead of failed', async () => {
  const stateCalls: StateCall[] = []
  const stateStore = createStateStore(stateCalls)
  const shutdownError = createDuckdbShuttingDownError('transaction for import.storeArticles')

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-shutdown',
    importRoute: '/api/datasources/import/pubmed',
    runImport: async (markImportStarted) => {
      await markImportStarted()
      await globalThis.Bun.sleep(1)
      throw new Error(`${shutdownError.message} -- duckdb main query: INSERT INTO app.article`)
    },
    startsFresh: false,
    stateStore,
    trigger: 'auto_resume',
  })

  await waitFor(() => {
    return !isDataSourceImportRunningInProcess('guard-shutdown')
  })

  expect(stateCalls).toEqual([
    {dataSourceId: 'guard-shutdown', kind: 'started', startsFresh: false, trigger: 'auto_resume'},
  ])
})

test('background datasource import failures after graceful shutdown started are interruptions, not failures', async () => {
  const harvest = Promise.withResolvers<undefined>()
  const stateCalls: StateCall[] = []
  const stateStore = createStateStore(stateCalls)

  await startDataSourceImportInBackground({
    dataSourceId: 'guard-interrupted-store',
    importRoute: '/api/datasources/import/europe-pmc-ppr',
    runImport: async (markImportStarted) => {
      await markImportStarted()
      await harvest.promise
    },
    startsFresh: false,
    stateStore,
    trigger: 'manual',
  })

  markServerShutdownStarted('SIGTERM')
  harvest.reject(new Error('INTERRUPT Error: Interrupted!'))
  await waitFor(() => {
    return !isDataSourceImportRunningInProcess('guard-interrupted-store')
  })

  expect(stateCalls).toEqual([
    {dataSourceId: 'guard-interrupted-store', kind: 'started', startsFresh: false, trigger: 'manual'},
  ])
})
