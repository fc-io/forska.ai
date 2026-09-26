import {afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('data-source-import-state')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

type AppDatabase = ReturnType<(typeof import('./appDatabaseService.ts'))['getAppDatabaseService']>
type StateRow = {
  consecutiveFailureCount: number
  lastError: string | null
  lastProgressAtMs: number | null
  nextRetryAtMs: number | null
  runTrigger: string
  startedAtMs: number
  status: string
}

let database: AppDatabase | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const importRoute = '/api/datasources/import/pubmed'
const baseTime = new Date('2026-09-26T10:00:00.000Z')
const minutesAfterBase = (minutes: number) => {
  return new Date(baseTime.getTime() + minutes * 60_000)
}

const insertDataSource = async (input: {archived?: boolean; cursor?: string | null; id: string}) => {
  await getDatabase().run(`
    INSERT INTO app.data_source (id, title, import_route, cursor, archived)
    VALUES (
      '${input.id}',
      'Import ${input.id}',
      '${importRoute}',
      ${input.cursor ? `'${input.cursor}'` : 'NULL'},
      ${input.archived ? 'TRUE' : 'FALSE'}
    )
  `)
}

const getStateRow = async (dataSourceId: string) => {
  const [row] = await getDatabase().queryJson<StateRow>(`
    SELECT
      status,
      run_trigger AS runTrigger,
      consecutive_failure_count AS consecutiveFailureCount,
      last_error AS lastError,
      epoch_ms(started_at)::DOUBLE AS startedAtMs,
      epoch_ms(last_progress_at)::DOUBLE AS lastProgressAtMs,
      epoch_ms(next_retry_at)::DOUBLE AS nextRetryAtMs
    FROM app.data_source_import_state
    WHERE data_source_id = '${dataSourceId}'
  `)

  return row ?? null
}

const getCursor = async (dataSourceId: string) => {
  const [row] = await getDatabase().queryJson<{cursor: string | null}>(`
    SELECT cursor FROM app.data_source WHERE id = '${dataSourceId}'
  `)

  return row?.cursor ?? null
}

const loadModules = async () => {
  const [repositoryModule, queryServiceModule] = await Promise.all([
    import('./dataSourceImportStateRepository.ts'),
    import('./dataSourceQueryService.ts'),
  ])

  return {
    repository: repositoryModule.createDataSourceImportStateRepository(getDatabase()),
    updateDataSourceAfterImport: queryServiceModule.dataSourceQueryService.updateDataSourceAfterImport,
    updateDataSourceCursor: queryServiceModule.updateDataSourceCursor,
  }
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('./appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  database = getAppDatabaseService()
})

beforeEach(async () => {
  await getDatabase().run('DELETE FROM app.data_source_import_state')
  await getDatabase().run('DELETE FROM app.data_source')
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('a manual import creates the state row, each saved page records progress, and completion clears the cursor with it', async () => {
  const {repository, updateDataSourceAfterImport, updateDataSourceCursor} = await loadModules()

  await insertDataSource({id: 'source-1'})
  await repository.markRunStarted({
    dataSourceId: 'source-1',
    importRoute,
    now: baseTime,
    startsFresh: true,
    trigger: 'manual',
  })

  expect(await getStateRow('source-1')).toEqual({
    consecutiveFailureCount: 0,
    lastError: null,
    lastProgressAtMs: null,
    nextRetryAtMs: null,
    runTrigger: 'manual',
    startedAtMs: baseTime.getTime(),
    status: 'running',
  })

  await updateDataSourceCursor('source-1', 'cursor-1')
  const afterPage = await getStateRow('source-1')

  expect(await getCursor('source-1')).toBe('cursor-1')
  expect(afterPage?.status).toBe('running')
  expect(afterPage?.lastProgressAtMs).toBeGreaterThan(baseTime.getTime())

  await updateDataSourceAfterImport({cursor: null, id: 'source-1', importedCount: 3})

  expect(await getCursor('source-1')).toBeNull()
  expect((await getStateRow('source-1'))?.status).toBe('completed')
})

test('a cursor save for a missing data source rolls back and reports it', async () => {
  const {updateDataSourceCursor} = await loadModules()

  const error = await updateDataSourceCursor('source-missing', 'cursor-1').then(
    () => {
      return null
    },
    (caught: unknown) => {
      return caught
    },
  )

  expect(String(error)).toContain('Data source not found')
})

test('the last page keeps the saved cursor until completion clears it, so a retry never restarts the harvest', async () => {
  const {repository, updateDataSourceAfterImport, updateDataSourceCursor} = await loadModules()

  await insertDataSource({id: 'source-last-page'})
  await repository.markRunStarted({
    dataSourceId: 'source-last-page',
    importRoute,
    now: baseTime,
    startsFresh: true,
    trigger: 'manual',
  })
  await updateDataSourceCursor('source-last-page', 'cursor-before-last-page')
  await updateDataSourceCursor('source-last-page', null)

  expect(await getCursor('source-last-page')).toBe('cursor-before-last-page')
  expect((await getStateRow('source-last-page'))?.status).toBe('running')

  await updateDataSourceAfterImport({cursor: null, id: 'source-last-page', importedCount: 2})

  expect(await getCursor('source-last-page')).toBeNull()
  expect((await getStateRow('source-last-page'))?.status).toBe('completed')
})

test('transient failures back off until the fifth failure, and a saved page resets the count', async () => {
  const {repository, updateDataSourceCursor} = await loadModules()
  const transientError = new Error('DuckDB workload budget exceeded for import.storeArticles')

  await insertDataSource({cursor: 'cursor-1', id: 'source-2'})
  await repository.markRunStarted({
    dataSourceId: 'source-2',
    importRoute,
    now: baseTime,
    startsFresh: false,
    trigger: 'manual',
  })

  const failures = await [1, 2, 3, 4, 5].reduce<Promise<Array<number | null>>>(async (previous, minute) => {
    const results = await previous
    const failure = await repository.markRunFailed({
      dataSourceId: 'source-2',
      error: transientError,
      now: minutesAfterBase(minute),
    })

    return [
      ...results,
      failure?.nextRetryAt ? (failure.nextRetryAt.getTime() - minutesAfterBase(minute).getTime()) / 1000 : null,
    ]
  }, Promise.resolve([]))

  expect(failures).toEqual([60, 300, 900, 1800, null])
  expect(await getStateRow('source-2')).toMatchObject({
    consecutiveFailureCount: 5,
    lastError: 'DuckDB workload budget exceeded for import.storeArticles',
    nextRetryAtMs: null,
    status: 'failed',
  })

  await repository.markRunStarted({
    dataSourceId: 'source-2',
    importRoute,
    now: minutesAfterBase(10),
    startsFresh: false,
    trigger: 'auto_retry',
  })
  expect(await getStateRow('source-2')).toMatchObject({consecutiveFailureCount: 5, runTrigger: 'auto_retry'})

  await updateDataSourceCursor('source-2', 'cursor-2')
  expect(await getStateRow('source-2')).toMatchObject({consecutiveFailureCount: 0, status: 'running'})
})

test('a non-transient failure is kept for the UI without an automatic retry', async () => {
  const {repository} = await loadModules()

  await insertDataSource({cursor: 'cursor-1', id: 'source-3'})
  await repository.markRunStarted({
    dataSourceId: 'source-3',
    importRoute,
    now: baseTime,
    startsFresh: false,
    trigger: 'manual',
  })

  const failure = await repository.markRunFailed({
    dataSourceId: 'source-3',
    error: new Error('Data source import lease was lost'),
    now: minutesAfterBase(1),
  })

  expect(failure).toEqual({consecutiveFailureCount: 1, nextRetryAt: null, transient: false})
  expect(await getStateRow('source-3')).toMatchObject({
    lastError: 'Data source import lease was lost',
    nextRetryAtMs: null,
    status: 'failed',
  })
})

test('an automatic resume counts as a failure without progress and a manual start resets the count and error', async () => {
  const {repository} = await loadModules()

  await insertDataSource({cursor: 'cursor-1', id: 'source-4'})
  await repository.markRunStarted({
    dataSourceId: 'source-4',
    importRoute,
    now: baseTime,
    startsFresh: false,
    trigger: 'manual',
  })
  await repository.markRunFailed({
    dataSourceId: 'source-4',
    error: new Error('The operation timed out.'),
    now: minutesAfterBase(1),
  })
  await repository.markRunStarted({
    dataSourceId: 'source-4',
    importRoute,
    now: minutesAfterBase(2),
    startsFresh: false,
    trigger: 'auto_resume',
  })

  expect(await getStateRow('source-4')).toMatchObject({
    consecutiveFailureCount: 2,
    lastError: 'The operation timed out.',
    runTrigger: 'auto_resume',
    startedAtMs: baseTime.getTime(),
    status: 'running',
  })

  await repository.markRunStarted({
    dataSourceId: 'source-4',
    importRoute,
    now: minutesAfterBase(3),
    startsFresh: false,
    trigger: 'manual',
  })

  expect(await getStateRow('source-4')).toMatchObject({
    consecutiveFailureCount: 0,
    lastError: null,
    runTrigger: 'manual',
    status: 'running',
  })
})

test('resume candidates are running imports and due failed imports of data sources that are not archived', async () => {
  const {repository} = await loadModules()
  const transientError = new Error('fetch failed')
  const startRun = async (dataSourceId: string) => {
    await repository.markRunStarted({dataSourceId, importRoute, now: baseTime, startsFresh: false, trigger: 'manual'})
  }

  await insertDataSource({cursor: 'c', id: 'source-running'})
  await insertDataSource({archived: true, cursor: 'c', id: 'source-archived'})
  await insertDataSource({cursor: 'c', id: 'source-due'})
  await insertDataSource({cursor: 'c', id: 'source-not-due'})
  await insertDataSource({cursor: 'c', id: 'source-permanent'})
  await insertDataSource({cursor: 'c', id: 'source-completed'})
  await Promise.all(
    [
      'source-running',
      'source-archived',
      'source-due',
      'source-not-due',
      'source-permanent',
      'source-completed',
      'source-deleted',
    ].map(startRun),
  )
  await repository.markRunFailed({dataSourceId: 'source-due', error: transientError, now: minutesAfterBase(0)})
  await repository.markRunFailed({dataSourceId: 'source-not-due', error: transientError, now: minutesAfterBase(5)})
  await repository.markRunFailed({
    dataSourceId: 'source-permanent',
    error: new Error('Validation failed for PubMed entry 1'),
    now: minutesAfterBase(0),
  })
  await getDatabase().run(`
    UPDATE app.data_source_import_state SET status = 'completed' WHERE data_source_id = 'source-completed'
  `)

  const candidates = await repository.listResumeCandidates({now: minutesAfterBase(2)})

  expect(
    candidates
      .map((candidate) => {
        return `${candidate.dataSourceId}:${candidate.status}`
      })
      .sort(),
  ).toEqual(['source-due:failed', 'source-running:running'])
})

test('after a restart the resumer resumes a running import once through the in-process guard', async () => {
  const {repository} = await loadModules()
  const [{runDataSourceImportResumerWake}, {isDataSourceImportRunningInProcess, startDataSourceImportInBackground}] =
    await Promise.all([
      import('../routes/DataSourcesImportRoutes/dataSourceImportResumer.ts'),
      import('../routes/DataSourcesImportRoutes/startDataSourceImportInBackground.ts'),
    ])
  const harvest = Promise.withResolvers<undefined>()
  const startedRuns: string[] = []

  await insertDataSource({cursor: 'cursor-7', id: 'source-restart'})
  await repository.markRunStarted({
    dataSourceId: 'source-restart',
    importRoute,
    now: baseTime,
    startsFresh: false,
    trigger: 'manual',
  })

  const startImport = async (
    candidate: {dataSourceId: string; importRoute: string},
    trigger: 'auto_resume' | 'auto_retry' | 'manual',
  ) => {
    await startDataSourceImportInBackground({
      dataSourceId: candidate.dataSourceId,
      importRoute: candidate.importRoute,
      runImport: async (markImportStarted) => {
        await markImportStarted()
        startedRuns.push(trigger)
        await harvest.promise
      },
      startsFresh: false,
      stateStore: repository,
      trigger,
    })
  }

  const first = await runDataSourceImportResumerWake({now: minutesAfterBase(1), repository, startImport})
  const second = await runDataSourceImportResumerWake({now: minutesAfterBase(2), repository, startImport})

  expect(first.attempts).toEqual([{dataSourceId: 'source-restart', outcome: 'started', trigger: 'auto_resume'}])
  expect(second.attempts).toEqual([])
  expect(startedRuns).toEqual(['auto_resume'])
  expect(await getStateRow('source-restart')).toMatchObject({
    consecutiveFailureCount: 1,
    runTrigger: 'auto_resume',
    status: 'running',
  })

  harvest.resolve(undefined)
  const deadline = Date.now() + 5000
  const waitForRelease = async (): Promise<void> => {
    if (isDataSourceImportRunningInProcess('source-restart') && Date.now() < deadline) {
      await globalThis.Bun.sleep(5)
      return waitForRelease()
    }
  }
  await waitForRelease()

  expect(isDataSourceImportRunningInProcess('source-restart')).toBe(false)
})

type ProgressRow = {
  fetchedCount: number
  progressFromStart: boolean
  runStartFetchedCount: number
  runStartStoredCount: number
  storedCount: number
  totalCount: number | null
}

const getProgressRow = async (dataSourceId: string) => {
  const [row] = await getDatabase().queryJson<ProgressRow>(`
    SELECT
      fetched_count::DOUBLE AS fetchedCount,
      stored_count::DOUBLE AS storedCount,
      total_count::DOUBLE AS totalCount,
      run_start_fetched_count::DOUBLE AS runStartFetchedCount,
      run_start_stored_count::DOUBLE AS runStartStoredCount,
      progress_from_start AS progressFromStart
    FROM app.data_source_import_state
    WHERE data_source_id = '${dataSourceId}'
  `)

  return row ?? null
}

test('progress adds up across a resume, a retried page counts once, and a fresh start resets it', async () => {
  const {repository} = await loadModules()
  const {createDataSourceCursorUpdater} = await import('./dataSourceQueryService.ts')
  const startRun = async (input: {startsFresh: boolean; trigger: 'auto_resume' | 'manual'}) => {
    await repository.markRunStarted({dataSourceId: 'source-progress', importRoute, now: baseTime, ...input})
  }

  await insertDataSource({id: 'source-progress'})
  await startRun({startsFresh: true, trigger: 'manual'})
  const firstRun = createDataSourceCursorUpdater('source-progress')

  await firstRun('cursor-1', {fetchedCount: 1000, pageKey: '*', storedCount: 998, totalCount: 5000})
  await firstRun('cursor-2', {fetchedCount: 1000, pageKey: 'cursor-1', storedCount: 1000, totalCount: 5000})
  await firstRun('cursor-2', {fetchedCount: 1000, pageKey: 'cursor-1', storedCount: 1000, totalCount: 5000})

  expect(await getProgressRow('source-progress')).toEqual({
    fetchedCount: 2000,
    progressFromStart: true,
    runStartFetchedCount: 0,
    runStartStoredCount: 0,
    storedCount: 1998,
    totalCount: 5000,
  })

  await startRun({startsFresh: false, trigger: 'auto_resume'})
  const resumedRun = createDataSourceCursorUpdater('source-progress')

  await resumedRun('cursor-3', {fetchedCount: 1000, pageKey: 'cursor-2', storedCount: 1000, totalCount: 5000})

  expect(await getProgressRow('source-progress')).toEqual({
    fetchedCount: 3000,
    progressFromStart: true,
    runStartFetchedCount: 2000,
    runStartStoredCount: 1998,
    storedCount: 2998,
    totalCount: 5000,
  })
  expect(await getCursor('source-progress')).toBe('cursor-3')

  await startRun({startsFresh: true, trigger: 'manual'})

  expect(await getProgressRow('source-progress')).toEqual({
    fetchedCount: 0,
    progressFromStart: true,
    runStartFetchedCount: 0,
    runStartStoredCount: 0,
    storedCount: 0,
    totalCount: null,
  })
})

test('a resume without an earlier state row counts from zero and is marked as not from the start', async () => {
  const {repository} = await loadModules()
  const {createDataSourceCursorUpdater} = await import('./dataSourceQueryService.ts')

  await insertDataSource({cursor: 'legacy-cursor', id: 'source-legacy'})
  await repository.markRunStarted({
    dataSourceId: 'source-legacy',
    importRoute,
    now: baseTime,
    startsFresh: false,
    trigger: 'manual',
  })
  await createDataSourceCursorUpdater('source-legacy')('cursor-next', {
    fetchedCount: 1000,
    pageKey: 'legacy-cursor',
    storedCount: 1000,
    totalCount: 588062,
  })

  expect(await getProgressRow('source-legacy')).toEqual({
    fetchedCount: 1000,
    progressFromStart: false,
    runStartFetchedCount: 0,
    runStartStoredCount: 0,
    storedCount: 1000,
    totalCount: 588062,
  })
})

test('an offset harvest keeps its counts when the last empty page saves the same cursor again', async () => {
  const {repository} = await loadModules()
  const {createDataSourceCursorUpdater} = await import('./dataSourceQueryService.ts')

  await insertDataSource({id: 'source-offset'})
  await repository.markRunStarted({
    dataSourceId: 'source-offset',
    importRoute: '/api/datasources/import/medrxiv',
    now: baseTime,
    startsFresh: true,
    trigger: 'manual',
  })
  const saveCursor = createDataSourceCursorUpdater('source-offset')

  await saveCursor('100', {fetchedCount: 100, pageKey: '0', storedCount: 100, totalCount: null})
  await saveCursor('100', {fetchedCount: 0, pageKey: '100', storedCount: 0, totalCount: null})

  expect(await getProgressRow('source-offset')).toMatchObject({fetchedCount: 100, storedCount: 100, totalCount: null})
})
