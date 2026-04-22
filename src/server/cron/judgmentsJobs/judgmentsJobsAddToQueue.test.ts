import {rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

import {afterAll, afterEach, beforeAll, expect, mock, test} from 'bun:test'

const tempDbPath = `/tmp/f1-judgments-jobs-add-to-queue-${process.pid}-${Date.now()}.duckdb`
const tempJobDir = join(dirname(tempDbPath), 'judgment-jobs')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

const getModulePath = (relativePath: string) => {
  return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
}

const judgmentsJobsAddToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
const judgmentsJobsAddToQueueDependenciesModulePath = getModulePath(
  './src/server/cron/judgmentsJobs/judgmentsJobsAddToQueueDependencies.ts',
)
type JudgmentsJobsAddToQueueModule = typeof import('./judgmentsJobsAddToQueue.ts')

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null
let getRealSqliteService:
  | Awaited<typeof import('./judgmentJobSqliteService.ts')>['getJudgmentJobSqliteService']
  | null = null

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    sqliteModule,
  ] = await Promise.all([
    import('../../../db/migrateDuckdb.ts'),
    import('../../services/appDatabaseService.ts'),
    import('../../utils/duckdbService.ts'),
    import('../../utils/serverRuntimeRole.ts'),
    import('./judgmentJobSqliteService.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = <T>(statement: string) => {
    return database.queryJson<T>(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
  getRealSqliteService = sqliteModule.getJudgmentJobSqliteService
})

afterAll(async () => {
  await getRealSqliteService?.().closeAll()
  await closeDatabase?.()
  rmSync(tempDbPath, {force: true})
  rmSync(`${tempDbPath}.duckdb-owner.history.json`, {force: true})
  rmSync(`${tempDbPath}.duckdb-owner.lock`, {force: true})
  rmSync(tempJobDir, {force: true, recursive: true})
})

type MockCursor = {lastArticleId: string; lastDate: Date; priorityBucket: number}

type MockScanState = {
  cursor: MockCursor | null
  exhaustedAt: Date | null
  lastProjectRefreshAckSeq: number | null
  scanEpoch: number
  wrapVisibilityAckSeq: number | null
}

type MockSqliteService = {
  addReadyPrompts: (
    jobId: string,
    entries: Array<{articleId: string; promptId: string}>,
    serverJobId: string,
    readyDeficit: number,
  ) => Promise<number>
  ensureOwnedLease: () => Promise<void>
  filterOutLocallyJudgedPrompts: (
    jobId: string,
    entries: Array<{articleId: string; promptId: string}>,
  ) => Promise<Array<{articleId: string; promptId: string}>>
  filterOutExistingQueuedPrompts: (
    jobId: string,
    entries: Array<{articleId: string; promptId: string}>,
  ) => Promise<Array<{articleId: string; promptId: string}>>
  getReadyCount: () => Promise<number>
  getScanState: () => Promise<MockScanState>
  hasJob: () => boolean
  initializeJob: () => Promise<void>
  setScanState: (jobId: string, state: Record<string, unknown>) => Promise<void>
  syncOwnedLeases: () => Promise<void>
}

type MockRunningJob = {
  id: string
  maxInflightRequests: number | null
  modelProvider: string
  projectId: string
  providerConnectionId: string | null
}

const getRunningJob = (overrides: Partial<MockRunningJob> = {}): MockRunningJob => {
  return {
    id: 'job-1',
    maxInflightRequests: null,
    modelProvider: 'openai',
    projectId: 'project-1',
    providerConnectionId: 'connection-1',
    ...overrides,
  }
}

type MockJobConfigRow = {
  humanJudgmentMode: 'prompt' | 'summary' | null
  modelId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

const getJobConfigRow = (): MockJobConfigRow => {
  return {
    humanJudgmentMode: 'prompt',
    modelId: 'model-1',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

const getExhaustedScanState = (
  lastProjectRefreshAckSeq: number | null,
  wrapVisibilityAckSeq: number | null,
): MockScanState => {
  return {
    cursor: null,
    exhaustedAt: new Date(Date.now() - 61_000),
    lastProjectRefreshAckSeq,
    scanEpoch: 3,
    wrapVisibilityAckSeq,
  }
}

const registerSharedMocks = (
  sqliteService: MockSqliteService,
  getPromptsCalls: {count: number},
  {
    jobConfigRow = getJobConfigRow(),
    getPromptsImpl,
    answeredHumanRows = [],
    answeredHumanSummaryRows = [],
    answeredHumanSummaryTableRows,
    existingJudgmentRows = [],
    inferenceConfig = {codexMaxInflight: 1, judgmentsAddToQueueMaxBatchSize: 1, judgmentsReadyTargetMultiplier: 1},
    projectDirtyToken = null,
    runningJobs = [getRunningJob()],
  }: {
    jobConfigRow?: MockJobConfigRow
    getPromptsImpl?: (
      projectId: string,
      jobId: string,
      numberOfPromptsToGet: number,
      cursor?: MockCursor | null,
      preferRawFallback?: boolean,
    ) => Promise<{nextCursor: MockCursor | null; promptEntries: Array<{articleId: string; promptId: string}>}>
    answeredHumanRows?: Array<{articleId: string; promptId: string}>
    answeredHumanSummaryRows?: Array<{articleId: string}>
    answeredHumanSummaryTableRows?: Array<{answer: string | null; articleId: string; projectId: string}>
    existingJudgmentRows?: Array<{articleId: string; promptId: string}>
    inferenceConfig?: {
      codexMaxInflight: number
      judgmentsAddToQueueMaxBatchSize: number
      judgmentsReadyTargetMultiplier: number
    }
    projectDirtyToken?: number | null
    runningJobs?: MockRunningJob[]
  } = {},
) => {
  void mock.module(judgmentsJobsAddToQueueDependenciesModulePath, () => {
    const runtimeConfig = inferenceConfig

    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async <T>(statement: string): Promise<T[]> => {
            return statement.includes('FROM app.project_mart_refresh_state pmrs')
              ? [{dirtyToken: projectDirtyToken} as T]
              : statement.includes('FROM app.judgment_human_summary')
                ? ((answeredHumanSummaryTableRows
                    ? answeredHumanSummaryTableRows
                        .filter((row) => {
                          return (
                            statement.includes(`project_id = '${row.projectId}'`)
                            && statement.includes(`'${row.articleId}'`)
                            && row.answer?.trim()
                          )
                        })
                        .map((row) => {
                          return {articleId: row.articleId}
                        })
                    : answeredHumanSummaryRows) as T[])
                : statement.includes('FROM app.judgment_human jh')
                  ? (answeredHumanRows as T[])
                  : statement.includes('app.judgment j')
                    ? (existingJudgmentRows as T[])
                    : statement.includes('FROM app.judgment_job jj')
                      ? [jobConfigRow as T]
                      : []
          },
          run: async (_statement: string): Promise<void> => {
            return undefined
          },
        }
      },
      getJudgmentJobSqliteService: () => {
        return sqliteService
      },
      getJudgmentsCapacity: () => {
        return {addToQueueMaxBatchSize: 1, maxInflight: 1, readyTargetPerJob: 1}
      },
      inferenceRuntimeConfig: runtimeConfig,
      JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
      judgmentsJobsCronGetPrompts: async (
        projectId: string,
        jobId: string,
        numberOfPromptsToGet: number,
        cursor?: MockCursor | null,
        preferRawFallback?: boolean,
      ) => {
        getPromptsCalls.count += 1
        return getPromptsImpl
          ? getPromptsImpl(projectId, jobId, numberOfPromptsToGet, cursor, preferRawFallback)
          : {nextCursor: null, promptEntries: []}
      },
      judgmentsJobsGetRunningJobs: async () => {
        return runningJobs
      },
    }
  })
}

afterEach(() => {
  mock.restore()
})

test('uses raw OLAP fallback when exhausted SQLite jobs are waiting on mart visibility', async () => {
  const getPromptsCalls = {count: 0}
  const preferRawFallbackValues: boolean[] = []
  const setScanStateCalls: Array<{jobId: string; state: Record<string, unknown>}> = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async () => {
      return 0
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return getExhaustedScanState(11, 12)
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async (jobId: string, state: Record<string, unknown>) => {
      setScanStateCalls.push({jobId, state})
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls, {
    getPromptsImpl: async (_projectId, _jobId, _numberOfPromptsToGet, _cursor, preferRawFallback) => {
      preferRawFallbackValues.push(Boolean(preferRawFallback))
      return {nextCursor: null, promptEntries: []}
    },
    projectDirtyToken: 12,
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?blocked=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(getPromptsCalls.count).toBe(1)
  expect(preferRawFallbackValues).toEqual([true])
  expect(setScanStateCalls).toHaveLength(2)
  expect(setScanStateCalls[0]).toEqual({
    jobId: 'job-1',
    state: {cursor: null, exhaustedAt: null, scanEpoch: 4, wrapVisibilityAckSeq: 12},
  })
})

test('uses saved codex provider caps for per-connection ready targets', async () => {
  const getPromptsCalls = {count: 0}
  const readyDeficits: number[] = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async (_jobId, _entries, _serverJobId, readyDeficit) => {
      readyDeficits.push(readyDeficit)
      return 1
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async () => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls, {
    getPromptsImpl: async () => {
      return {nextCursor: null, promptEntries: [{articleId: 'article-1', promptId: 'prompt-1'}]}
    },
    inferenceConfig: {codexMaxInflight: 1, judgmentsAddToQueueMaxBatchSize: 100, judgmentsReadyTargetMultiplier: 1},
    runningJobs: [
      getRunningJob({
        id: 'job-codex-1',
        maxInflightRequests: 20,
        modelProvider: 'codex',
        projectId: 'project-codex-1',
        providerConnectionId: 'connection-codex-1',
      }),
    ],
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?codex-override-ready-target=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(getPromptsCalls.count).toBe(1)
  expect(readyDeficits).toEqual([20])
})

test('splits saved codex provider caps across jobs on the same connection', async () => {
  const getPromptsCalls = {count: 0}
  const readyDeficits: Array<{jobId: string; readyDeficit: number}> = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async (jobId, _entries, _serverJobId, readyDeficit) => {
      readyDeficits.push({jobId, readyDeficit})
      return 1
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async () => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls, {
    getPromptsImpl: async () => {
      return {nextCursor: null, promptEntries: [{articleId: 'article-1', promptId: 'prompt-1'}]}
    },
    inferenceConfig: {codexMaxInflight: 1, judgmentsAddToQueueMaxBatchSize: 100, judgmentsReadyTargetMultiplier: 1},
    runningJobs: [
      getRunningJob({
        id: 'job-codex-a',
        maxInflightRequests: 20,
        modelProvider: 'codex',
        projectId: 'project-codex-a',
        providerConnectionId: 'connection-codex-shared',
      }),
      getRunningJob({
        id: 'job-codex-b',
        maxInflightRequests: 20,
        modelProvider: 'codex',
        projectId: 'project-codex-b',
        providerConnectionId: 'connection-codex-shared',
      }),
    ],
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?codex-shared-ready-target=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(getPromptsCalls.count).toBe(2)
  expect(readyDeficits).toEqual([
    {jobId: 'job-codex-a', readyDeficit: 10},
    {jobId: 'job-codex-b', readyDeficit: 10},
  ])
})

test('wraps exhausted SQLite jobs once visibility catches up and increments scan epoch once', async () => {
  const getPromptsCalls = {count: 0}
  const setScanStateCalls: Array<{jobId: string; state: Record<string, unknown>}> = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async () => {
      return 0
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return getExhaustedScanState(12, 12)
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async (jobId: string, state: Record<string, unknown>) => {
      setScanStateCalls.push({jobId, state})
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls, {projectDirtyToken: 12})

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?wrapped=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(getPromptsCalls.count).toBe(1)
  expect(setScanStateCalls).toHaveLength(2)
  expect(setScanStateCalls[0]).toEqual({
    jobId: 'job-1',
    state: {cursor: null, exhaustedAt: null, scanEpoch: 4, wrapVisibilityAckSeq: null},
  })
  expect(setScanStateCalls[1]?.jobId).toBe('job-1')
  expect(setScanStateCalls[1]?.state.scanEpoch).toBeUndefined()
  expect(setScanStateCalls[1]?.state.wrapVisibilityAckSeq).toBe(12)
  expect(setScanStateCalls[1]?.state.cursor).toBeNull()
  expect(setScanStateCalls[1]?.state.exhaustedAt).toBeInstanceOf(Date)
})

test('round-trips priority-aware SQLite cursors through prompt fetching and scan state', async () => {
  const getPromptsCalls = {count: 0}
  const cursorValues: Array<MockCursor | null | undefined> = []
  const setScanStateCalls: Array<{jobId: string; state: Record<string, unknown>}> = []
  const savedCursorDate = new Date('2025-03-01T00:00:00.000Z')
  const nextCursorDate = new Date('2025-02-28T00:00:00.000Z')
  const savedCursor = {lastArticleId: 'saved-article', lastDate: savedCursorDate, priorityBucket: 1}
  const nextCursor = {lastArticleId: 'next-article', lastDate: nextCursorDate, priorityBucket: 0}
  let readyCountCalls = 0
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async () => {
      return 0
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      readyCountCalls += 1
      return readyCountCalls === 1 ? 0 : 1
    },
    getScanState: async () => {
      return {
        cursor: savedCursor,
        exhaustedAt: null,
        lastProjectRefreshAckSeq: 12,
        scanEpoch: 3,
        wrapVisibilityAckSeq: 12,
      }
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async (jobId: string, state: Record<string, unknown>) => {
      setScanStateCalls.push({jobId, state})
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls, {
    getPromptsImpl: async (_projectId, _jobId, _numberOfPromptsToGet, cursor) => {
      cursorValues.push(cursor)
      return {nextCursor, promptEntries: []}
    },
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?priorityCursor=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(cursorValues).toEqual([savedCursor])
  expect(setScanStateCalls).toEqual([
    {jobId: 'job-1', state: {cursor: nextCursor, exhaustedAt: null, wrapVisibilityAckSeq: null}},
  ])
})

test('initializes missing SQLite job state before topping up the queue', async () => {
  const getPromptsCalls = {count: 0}
  const initializedJobIds: string[] = []
  let hasJob = false
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async () => {
      return 0
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    },
    hasJob: () => {
      return hasJob
    },
    initializeJob: async () => {
      hasJob = true
      initializedJobIds.push('job-1')
    },
    setScanState: async (_jobId: string, _state: Record<string, unknown>) => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls)

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?initialize-sqlite=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(initializedJobIds).toEqual(['job-1'])
  expect(getPromptsCalls.count).toBe(1)
})

test('filters out locally judged SQLite prompt pairs before adding ready prompts', async () => {
  const getPromptsCalls = {count: 0}
  const addReadyPromptsCalls: Array<Array<{articleId: string; promptId: string}>> = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async (...args) => {
      addReadyPromptsCalls.push(args[1] as Array<{articleId: string; promptId: string}>)
      return 1
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries.filter((entry) => {
        return entry.articleId !== 'article-local'
      })
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async () => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls, {
    getPromptsImpl: async () => {
      return {
        nextCursor: null,
        promptEntries: [
          {articleId: 'article-local', promptId: 'prompt-1'},
          {articleId: 'article-new', promptId: 'prompt-1'},
        ],
      }
    },
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?filter-local-judged=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(getPromptsCalls.count).toBe(1)
  expect(addReadyPromptsCalls).toEqual([[{articleId: 'article-new', promptId: 'prompt-1'}]])
})

test('prioritizes answered human pairs within the fetched window and logs inserted prioritized entries', async () => {
  const getPromptsCalls = {count: 0}
  const addReadyPromptsCalls: Array<Array<{articleId: string; promptId: string}>> = []
  const loggedMessages: string[] = []
  const originalConsoleLog = console.log
  console.log = (...args: unknown[]) => {
    loggedMessages.push(args.join(' '))
  }

  const sqliteService: MockSqliteService = {
    addReadyPrompts: async (...args) => {
      addReadyPromptsCalls.push(args[1] as Array<{articleId: string; promptId: string}>)
      return 1
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries.filter((entry) => {
        return entry.articleId !== 'article-human-ignored'
      })
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async () => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls, {
    answeredHumanRows: [
      {articleId: 'article-human', promptId: 'prompt-1'},
      {articleId: 'article-human-ignored', promptId: 'prompt-2'},
    ],
    getPromptsImpl: async () => {
      return {
        nextCursor: null,
        promptEntries: [
          {articleId: 'article-rest', promptId: 'prompt-0'},
          {articleId: 'article-human', promptId: 'prompt-1'},
          {articleId: 'article-human-ignored', promptId: 'prompt-2'},
        ],
      }
    },
  })

  try {
    const module = (await import(
      `${judgmentsJobsAddToQueueModulePath}?prioritize-human-first=${Date.now()}`
    )) as JudgmentsJobsAddToQueueModule

    await module.judgmentsJobsAddToQueue('server-1')
  } finally {
    console.log = originalConsoleLog
  }

  expect(getPromptsCalls.count).toBe(1)
  expect(addReadyPromptsCalls).toEqual([
    [
      {articleId: 'article-human', promptId: 'prompt-1'},
      {articleId: 'article-human-ignored', promptId: 'prompt-2'},
      {articleId: 'article-rest', promptId: 'prompt-0'},
    ],
  ])
  expect(
    loggedMessages.some((message) => {
      return message.includes('[addToQueue] prioritized human entries')
    }),
  ).toBe(true)
})

test('claims promoted human pairs first when ready deficit is smaller than the fetched window', async () => {
  if (!queryDatabase || !runDatabase || !getRealSqliteService) {
    throw new Error('Test database not initialized')
  }

  const sqliteService = getRealSqliteService()
  const dbQuery = queryDatabase
  const dbRun = runDatabase
  const connectionId = `connection-human-window-${Date.now()}`
  const modelId = `model-human-window-${Date.now()}`
  const projectId = `project-human-window-${Date.now()}`
  const jobId = `job-human-window-${Date.now()}`

  await dbRun(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await dbRun(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await dbRun(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Human Window Priority Test', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await dbRun(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  void mock.module(judgmentsJobsAddToQueueDependenciesModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async <T>(statement: string): Promise<T[]> => {
            return statement.includes('FROM app.judgment_human jh')
              ? ([{articleId: 'article-human-late', promptId: 'prompt-human-late'}] as T[])
              : dbQuery<T>(statement)
          },
          run: async (statement: string): Promise<void> => {
            return dbRun(statement)
          },
        }
      },
      JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
      getJudgmentJobSqliteService: () => {
        return sqliteService
      },
      getJudgmentsCapacity: () => {
        return {addToQueueMaxBatchSize: 1, maxInflight: 1, readyTargetPerJob: 1}
      },
      inferenceRuntimeConfig: {
        codexMaxInflight: 1,
        judgmentsAddToQueueMaxBatchSize: 1,
        judgmentsReadyTargetMultiplier: 1,
      },
      judgmentsJobsCronGetPrompts: async () => {
        return {
          nextCursor: null,
          promptEntries: [
            {articleId: 'article-rest-first', promptId: 'prompt-rest-first'},
            {articleId: 'article-human-late', promptId: 'prompt-human-late'},
            {articleId: 'article-rest-second', promptId: 'prompt-rest-second'},
          ],
        }
      },
      judgmentsJobsGetRunningJobs: async () => {
        return [{id: jobId, modelProvider: 'openai', projectId}]
      },
    }
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?human-window=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(
    (await sqliteService.claimReadyPrompts(jobId, 'server-claim', 1)).map((prompt) => {
      return `${prompt.articleId}:${prompt.promptId}`
    }),
  ).toEqual(['article-human-late:prompt-human-late'])

  await sqliteService.closeAll()
})

test('top-up inserts later summary-backed rows ahead of new window peers without reshuffling existing ready rows', async () => {
  if (!queryDatabase || !runDatabase || !getRealSqliteService) {
    throw new Error('Test database not initialized')
  }

  const sqliteService = getRealSqliteService()
  const dbQuery = queryDatabase
  const dbRun = runDatabase
  const connectionId = `connection-summary-window-${Date.now()}`
  const modelId = `model-summary-window-${Date.now()}`
  const projectId = `project-summary-window-${Date.now()}`
  const jobId = `job-summary-window-${Date.now()}`
  const existingArticleId = `article-existing-ready-${Date.now()}`
  const existingPromptId = `prompt-existing-ready-${Date.now()}`
  const summaryArticleId = `article-summary-late-${Date.now()}`
  const summaryPromptId = `prompt-summary-late-${Date.now()}`

  await dbRun(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await dbRun(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
  `)
  await dbRun(`
    INSERT INTO app.project (
      id,
      name,
      model_id,
      human_judgment_mode,
      use_title,
      use_abstract,
      use_fulltext,
      use_fulltext_no_images
    )
    VALUES ('${projectId}', 'Summary Window Priority Test', '${modelId}', 'summary', TRUE, TRUE, FALSE, FALSE)
  `)
  await dbRun(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  await sqliteService.initializeJob(jobId)
  await sqliteService.releaseOwnedLease(jobId)
  await sqliteService.addReadyPrompts(
    jobId,
    [{articleId: existingArticleId, promptId: existingPromptId}],
    'server-existing-ready',
  )
  await sqliteService.releaseOwnedLease(jobId)

  void mock.module(judgmentsJobsAddToQueueDependenciesModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async <T>(statement: string): Promise<T[]> => {
            return statement.includes('FROM app.judgment_human_summary')
              ? ([{articleId: summaryArticleId}] as T[])
              : dbQuery<T>(statement)
          },
          run: async (statement: string): Promise<void> => {
            return dbRun(statement)
          },
        }
      },
      JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
      getJudgmentJobSqliteService: () => {
        return sqliteService
      },
      getJudgmentsCapacity: () => {
        return {addToQueueMaxBatchSize: 1, maxInflight: 2, readyTargetPerJob: 2}
      },
      inferenceRuntimeConfig: {
        codexMaxInflight: 1,
        judgmentsAddToQueueMaxBatchSize: 1,
        judgmentsReadyTargetMultiplier: 1,
      },
      judgmentsJobsCronGetPrompts: async () => {
        return {
          nextCursor: null,
          promptEntries: [
            {articleId: 'article-rest-first', promptId: 'prompt-rest-first'},
            {articleId: summaryArticleId, promptId: summaryPromptId},
            {articleId: 'article-rest-second', promptId: 'prompt-rest-second'},
          ],
        }
      },
      judgmentsJobsGetRunningJobs: async () => {
        return [{id: jobId, modelProvider: 'openai', projectId}]
      },
    }
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?summary-top-up-window=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(
    (await sqliteService.claimReadyPrompts(jobId, 'server-claim', 2)).map((prompt) => {
      return `${prompt.articleId}:${prompt.promptId}`
    }),
  ).toEqual([`${existingArticleId}:${existingPromptId}`, `${summaryArticleId}:${summaryPromptId}`])

  await sqliteService.closeAll()
})

test('preserves relative order for multiple promoted human pairs and does not prioritize excluded rows', async () => {
  const getPromptsCalls = {count: 0}
  const addReadyPromptsCalls: Array<Array<{articleId: string; promptId: string}>> = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async (...args) => {
      addReadyPromptsCalls.push(args[1] as Array<{articleId: string; promptId: string}>)
      return 5
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries.filter((entry) => {
        return entry.articleId !== 'article-local-judged'
      })
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async () => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls, {
    answeredHumanRows: [
      {articleId: 'article-human-late-1', promptId: 'prompt-human-late-1'},
      {articleId: 'article-human-late-2', promptId: 'prompt-human-late-2'},
    ],
    existingJudgmentRows: [{articleId: 'article-already-judged', promptId: 'prompt-already-judged'}],
    getPromptsImpl: async () => {
      return {
        nextCursor: null,
        promptEntries: [
          {articleId: 'article-rest-first', promptId: 'prompt-rest-first'},
          {articleId: 'article-human-late-1', promptId: 'prompt-human-late-1'},
          {articleId: 'article-unanswered-human', promptId: 'prompt-unanswered-human'},
          {articleId: 'article-cross-project-human', promptId: 'prompt-cross-project-human'},
          {articleId: 'article-already-judged', promptId: 'prompt-already-judged'},
          {articleId: 'article-human-late-2', promptId: 'prompt-human-late-2'},
          {articleId: 'article-local-judged', promptId: 'prompt-local-judged'},
        ],
      }
    },
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?multiple-human-window=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(getPromptsCalls.count).toBe(1)
  expect(addReadyPromptsCalls).toEqual([
    [
      {articleId: 'article-human-late-1', promptId: 'prompt-human-late-1'},
      {articleId: 'article-human-late-2', promptId: 'prompt-human-late-2'},
      {articleId: 'article-rest-first', promptId: 'prompt-rest-first'},
      {articleId: 'article-unanswered-human', promptId: 'prompt-unanswered-human'},
      {articleId: 'article-cross-project-human', promptId: 'prompt-cross-project-human'},
    ],
  ])
})

test('prioritizes every fetched prompt row for articles with answered human summaries', async () => {
  const getPromptsCalls = {count: 0}
  const addReadyPromptsCalls: Array<Array<{articleId: string; promptId: string}>> = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async (...args) => {
      addReadyPromptsCalls.push(args[1] as Array<{articleId: string; promptId: string}>)
      return 4
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async () => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls, {
    answeredHumanRows: [{articleId: 'article-prompt-only', promptId: 'prompt-prompt-only'}],
    answeredHumanSummaryRows: [{articleId: 'article-summary'}],
    getPromptsImpl: async () => {
      return {
        nextCursor: null,
        promptEntries: [
          {articleId: 'article-rest', promptId: 'prompt-rest'},
          {articleId: 'article-summary', promptId: 'prompt-summary-1'},
          {articleId: 'article-prompt-only', promptId: 'prompt-prompt-only'},
          {articleId: 'article-summary', promptId: 'prompt-summary-2'},
        ],
      }
    },
    jobConfigRow: {...getJobConfigRow(), humanJudgmentMode: 'summary'},
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?summary-human-window=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(getPromptsCalls.count).toBe(1)
  expect(addReadyPromptsCalls).toEqual([
    [
      {articleId: 'article-summary', promptId: 'prompt-summary-1'},
      {articleId: 'article-summary', promptId: 'prompt-summary-2'},
      {articleId: 'article-rest', promptId: 'prompt-rest'},
      {articleId: 'article-prompt-only', promptId: 'prompt-prompt-only'},
    ],
  ])
})

test('summary prioritization ignores blank answers and other projects while preserving stable article order after filters', async () => {
  const getPromptsCalls = {count: 0}
  const addReadyPromptsCalls: Array<Array<{articleId: string; promptId: string}>> = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async (...args) => {
      addReadyPromptsCalls.push(args[1] as Array<{articleId: string; promptId: string}>)
      return 5
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries.filter((entry) => {
        return entry.promptId !== 'prompt-summary-local-judged'
      })
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async () => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls, {
    answeredHumanSummaryTableRows: [
      {answer: 'Has summary', articleId: 'article-summary-second', projectId: 'project-1'},
      {answer: 'Also answered', articleId: 'article-summary-first', projectId: 'project-1'},
      {answer: null, articleId: 'article-summary-null', projectId: 'project-1'},
      {answer: '   ', articleId: 'article-summary-blank', projectId: 'project-1'},
      {answer: 'Other project answered', articleId: 'article-summary-other-project', projectId: 'project-2'},
      {answer: 'Filtered by app judgment', articleId: 'article-summary-already-judged', projectId: 'project-1'},
      {answer: 'Filtered by local judgment', articleId: 'article-summary-local', projectId: 'project-1'},
    ],
    existingJudgmentRows: [{articleId: 'article-summary-already-judged', promptId: 'prompt-summary-already-judged'}],
    getPromptsImpl: async () => {
      return {
        nextCursor: null,
        promptEntries: [
          {articleId: 'article-rest-first', promptId: 'prompt-rest-first'},
          {articleId: 'article-summary-second', promptId: 'prompt-summary-second-a'},
          {articleId: 'article-summary-null', promptId: 'prompt-summary-null'},
          {articleId: 'article-summary-first', promptId: 'prompt-summary-first-a'},
          {articleId: 'article-summary-already-judged', promptId: 'prompt-summary-already-judged'},
          {articleId: 'article-summary-blank', promptId: 'prompt-summary-blank'},
          {articleId: 'article-summary-second', promptId: 'prompt-summary-second-b'},
          {articleId: 'article-summary-local', promptId: 'prompt-summary-local-judged'},
          {articleId: 'article-summary-other-project', promptId: 'prompt-summary-other-project'},
          {articleId: 'article-summary-first', promptId: 'prompt-summary-first-b'},
          {articleId: 'article-rest-second', promptId: 'prompt-rest-second'},
        ],
      }
    },
    jobConfigRow: {...getJobConfigRow(), humanJudgmentMode: 'summary'},
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?summary-priority-edge-cases=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(getPromptsCalls.count).toBe(1)
  expect(addReadyPromptsCalls).toEqual([
    [
      {articleId: 'article-summary-second', promptId: 'prompt-summary-second-a'},
      {articleId: 'article-summary-first', promptId: 'prompt-summary-first-a'},
      {articleId: 'article-summary-second', promptId: 'prompt-summary-second-b'},
      {articleId: 'article-summary-first', promptId: 'prompt-summary-first-b'},
      {articleId: 'article-rest-first', promptId: 'prompt-rest-first'},
      {articleId: 'article-summary-null', promptId: 'prompt-summary-null'},
      {articleId: 'article-summary-blank', promptId: 'prompt-summary-blank'},
      {articleId: 'article-summary-other-project', promptId: 'prompt-summary-other-project'},
      {articleId: 'article-rest-second', promptId: 'prompt-rest-second'},
    ],
  ])
})

test('treats null human judgment mode as prompt mode', async () => {
  const getPromptsCalls = {count: 0}
  const addReadyPromptsCalls: Array<Array<{articleId: string; promptId: string}>> = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async (...args) => {
      addReadyPromptsCalls.push(args[1] as Array<{articleId: string; promptId: string}>)
      return 3
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async () => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls, {
    answeredHumanRows: [{articleId: 'article-prompt-priority', promptId: 'prompt-priority'}],
    answeredHumanSummaryRows: [{articleId: 'article-summary'}],
    getPromptsImpl: async () => {
      return {
        nextCursor: null,
        promptEntries: [
          {articleId: 'article-rest', promptId: 'prompt-rest'},
          {articleId: 'article-prompt-priority', promptId: 'prompt-priority'},
          {articleId: 'article-summary', promptId: 'prompt-summary'},
        ],
      }
    },
    jobConfigRow: {...getJobConfigRow(), humanJudgmentMode: null},
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?null-human-mode=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(getPromptsCalls.count).toBe(1)
  expect(addReadyPromptsCalls).toEqual([
    [
      {articleId: 'article-prompt-priority', promptId: 'prompt-priority'},
      {articleId: 'article-rest', promptId: 'prompt-rest'},
      {articleId: 'article-summary', promptId: 'prompt-summary'},
    ],
  ])
})

test('queue reuse skips unchanged scoped clone judgments and keeps changed settings queued', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const dbQuery = queryDatabase
  const dbRun = runDatabase
  const suffix = `queue-reuse-${Date.now()}`
  const connectionId = `${suffix}-connection`
  const modelId = `${suffix}-model`
  const changedModelId = `${suffix}-changed-model`
  const projectId = `${suffix}-project`
  const jobId = `${suffix}-job`
  const promptId = `${suffix}-prompt`
  const unchangedArticleId = `${suffix}-article-unchanged`
  const changedModelArticleId = `${suffix}-article-changed-model`
  const changedFulltextArticleId = `${suffix}-article-changed-fulltext`
  const addReadyPromptsCalls: Array<Array<{articleId: string; promptId: string}>> = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async (_jobId, entries) => {
      addReadyPromptsCalls.push(entries)
      return entries.length
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async () => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  await dbRun(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await dbRun(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES
      ('${modelId}', '${connectionId}', 'Queue reuse model', 'queue-reuse-model', 'Queue reuse model', 'manual', TRUE),
      ('${changedModelId}', '${connectionId}', 'Queue reuse changed model', 'queue-reuse-changed-model', 'Queue reuse changed model', 'manual', TRUE)
  `)
  await dbRun(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Queue Reuse Project', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await dbRun(`
    INSERT INTO app.prompt (id, original_text)
    VALUES ('${promptId}', 'Queue reuse prompt')
  `)
  await dbRun(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('${suffix}-project-prompt', '${projectId}', '${promptId}', 1, TRUE)
  `)
  await dbRun(`
    INSERT INTO app.article (id, article_id, article_title)
    VALUES
      ('${unchangedArticleId}', '${unchangedArticleId}-external', 'Unchanged article'),
      ('${changedModelArticleId}', '${changedModelArticleId}-external', 'Changed model article'),
      ('${changedFulltextArticleId}', '${changedFulltextArticleId}-external', 'Changed fulltext article')
  `)
  await dbRun(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('${suffix}-project-article-unchanged', '${projectId}', '${unchangedArticleId}'),
      ('${suffix}-project-article-changed-model', '${projectId}', '${changedModelArticleId}'),
      ('${suffix}-project-article-changed-fulltext', '${projectId}', '${changedFulltextArticleId}')
  `)
  await dbRun(`
    INSERT INTO app.judgment (id, article_id, prompt_id, model_id, project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES
      ('${suffix}-judgment-unchanged', '${unchangedArticleId}', '${promptId}', '${modelId}', '${projectId}', TRUE, TRUE, FALSE, FALSE),
      ('${suffix}-judgment-changed-model', '${changedModelArticleId}', '${promptId}', '${changedModelId}', '${projectId}', TRUE, TRUE, FALSE, FALSE),
      ('${suffix}-judgment-changed-fulltext', '${changedFulltextArticleId}', '${promptId}', '${modelId}', '${projectId}', TRUE, TRUE, TRUE, FALSE)
  `)
  await dbRun(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  void mock.module(judgmentsJobsAddToQueueDependenciesModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {queryJson: dbQuery, run: dbRun}
      },
      getJudgmentJobSqliteService: () => {
        return sqliteService
      },
      getJudgmentsCapacity: () => {
        return {addToQueueMaxBatchSize: 10, maxInflight: 10, readyTargetPerJob: 10}
      },
      inferenceRuntimeConfig: {
        codexMaxInflight: 1,
        judgmentsAddToQueueMaxBatchSize: 10,
        judgmentsReadyTargetMultiplier: 1,
      },
      JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
      judgmentsJobsCronGetPrompts: async () => {
        return {
          nextCursor: null,
          promptEntries: [
            {articleId: unchangedArticleId, promptId},
            {articleId: changedModelArticleId, promptId},
            {articleId: changedFulltextArticleId, promptId},
          ],
        }
      },
      judgmentsJobsGetRunningJobs: async () => {
        return [{id: jobId, maxInflightRequests: null, modelProvider: 'openai', projectId, providerConnectionId: null}]
      },
    }
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?queue-reuse-config=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(addReadyPromptsCalls).toEqual([
    [
      {articleId: changedModelArticleId, promptId},
      {articleId: changedFulltextArticleId, promptId},
    ],
  ])
})

test('queue reuse keeps cloned prompt edits queued when source judgments stay on the old prompt id', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const dbQuery = queryDatabase
  const dbRun = runDatabase
  const suffix = `queue-prompt-edit-${Date.now()}`
  const connectionId = `${suffix}-connection`
  const modelId = `${suffix}-model`
  const sourceProjectId = `${suffix}-source-project`
  const clonedProjectId = `${suffix}-cloned-project`
  const jobId = `${suffix}-job`
  const sourcePromptId = `${suffix}-source-prompt`
  const editedClonePromptId = `${suffix}-edited-clone-prompt`
  const articleId = `${suffix}-article`
  const addReadyPromptsCalls: Array<Array<{articleId: string; promptId: string}>> = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async (_jobId, entries) => {
      addReadyPromptsCalls.push(entries)
      return entries.length
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async () => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  await dbRun(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await dbRun(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Queue prompt edit model', 'queue-prompt-edit-model', 'Queue prompt edit model', 'manual', TRUE)
  `)
  await dbRun(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES
      ('${sourceProjectId}', 'Queue Prompt Edit Source', '${modelId}', TRUE, TRUE, FALSE, FALSE),
      ('${clonedProjectId}', 'Queue Prompt Edit Clone', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await dbRun(`
    INSERT INTO app.prompt (id, original_text)
    VALUES
      ('${sourcePromptId}', 'Queue prompt edit source prompt'),
      ('${editedClonePromptId}', 'Queue prompt edit clone prompt')
  `)
  await dbRun(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES
      ('${suffix}-source-project-prompt', '${sourceProjectId}', '${sourcePromptId}', 1, TRUE),
      ('${suffix}-clone-project-prompt', '${clonedProjectId}', '${editedClonePromptId}', 1, TRUE)
  `)
  await dbRun(`
    INSERT INTO app.article (id, article_id, article_title)
    VALUES ('${articleId}', '${articleId}-external', 'Queue prompt edit article')
  `)
  await dbRun(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES
      ('${suffix}-source-project-article', '${sourceProjectId}', '${articleId}'),
      ('${suffix}-clone-project-article', '${clonedProjectId}', '${articleId}')
  `)
  await dbRun(`
    INSERT INTO app.judgment (id, article_id, prompt_id, model_id, project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${suffix}-source-judgment', '${articleId}', '${sourcePromptId}', '${modelId}', '${sourceProjectId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await dbRun(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${clonedProjectId}', 'running')
  `)

  void mock.module(judgmentsJobsAddToQueueDependenciesModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {queryJson: dbQuery, run: dbRun}
      },
      getJudgmentJobSqliteService: () => {
        return sqliteService
      },
      getJudgmentsCapacity: () => {
        return {addToQueueMaxBatchSize: 10, maxInflight: 10, readyTargetPerJob: 10}
      },
      inferenceRuntimeConfig: {
        codexMaxInflight: 1,
        judgmentsAddToQueueMaxBatchSize: 10,
        judgmentsReadyTargetMultiplier: 1,
      },
      JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
      judgmentsJobsCronGetPrompts: async () => {
        return {nextCursor: null, promptEntries: [{articleId, promptId: editedClonePromptId}]}
      },
      judgmentsJobsGetRunningJobs: async () => {
        return [
          {
            id: jobId,
            maxInflightRequests: null,
            modelProvider: 'openai',
            projectId: clonedProjectId,
            providerConnectionId: null,
          },
        ]
      },
    }
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?queue-reuse-prompt-edit=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(addReadyPromptsCalls).toEqual([[{articleId, promptId: editedClonePromptId}]])
})

test('queue reuse does not skip matching judgments outside the target project scope', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const dbQuery = queryDatabase
  const dbRun = runDatabase
  const suffix = `queue-scope-${Date.now()}`
  const connectionId = `${suffix}-connection`
  const modelId = `${suffix}-model`
  const projectId = `${suffix}-project`
  const jobId = `${suffix}-job`
  const promptId = `${suffix}-prompt`
  const scopedArticleId = `${suffix}-article-scoped`
  const outOfScopeArticleId = `${suffix}-article-out-of-scope`
  const addReadyPromptsCalls: Array<Array<{articleId: string; promptId: string}>> = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async (_jobId, entries) => {
      addReadyPromptsCalls.push(entries)
      return entries.length
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    filterOutLocallyJudgedPrompts: async (_jobId, entries) => {
      return entries
    },
    filterOutExistingQueuedPrompts: async (_jobId, entries) => {
      return entries
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return {cursor: null, exhaustedAt: null, lastProjectRefreshAckSeq: null, scanEpoch: 0, wrapVisibilityAckSeq: null}
    },
    hasJob: () => {
      return true
    },
    initializeJob: async () => {
      return undefined
    },
    setScanState: async () => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  await dbRun(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('${connectionId}', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
  `)
  await dbRun(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('${modelId}', '${connectionId}', 'Queue scope model', 'queue-scope-model', 'Queue scope model', 'manual', TRUE)
  `)
  await dbRun(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', 'Queue Scope Project', '${modelId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await dbRun(`
    INSERT INTO app.prompt (id, original_text)
    VALUES ('${promptId}', 'Queue scope prompt')
  `)
  await dbRun(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
    VALUES ('${suffix}-project-prompt', '${projectId}', '${promptId}', 1, TRUE)
  `)
  await dbRun(`
    INSERT INTO app.article (id, article_id, article_title)
    VALUES
      ('${scopedArticleId}', '${scopedArticleId}-external', 'Scoped article'),
      ('${outOfScopeArticleId}', '${outOfScopeArticleId}-external', 'Out of scope article')
  `)
  await dbRun(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('${suffix}-project-article-scoped', '${projectId}', '${scopedArticleId}')
  `)
  await dbRun(`
    INSERT INTO app.judgment (id, article_id, prompt_id, model_id, project_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES
      ('${suffix}-judgment-scoped', '${scopedArticleId}', '${promptId}', '${modelId}', '${projectId}', TRUE, TRUE, FALSE, FALSE),
      ('${suffix}-judgment-out-of-scope', '${outOfScopeArticleId}', '${promptId}', '${modelId}', '${projectId}', TRUE, TRUE, FALSE, FALSE)
  `)
  await dbRun(`
    INSERT INTO app.judgment_job (id, project_id, status)
    VALUES ('${jobId}', '${projectId}', 'running')
  `)

  void mock.module(judgmentsJobsAddToQueueDependenciesModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {queryJson: dbQuery, run: dbRun}
      },
      getJudgmentJobSqliteService: () => {
        return sqliteService
      },
      getJudgmentsCapacity: () => {
        return {addToQueueMaxBatchSize: 10, maxInflight: 10, readyTargetPerJob: 10}
      },
      inferenceRuntimeConfig: {
        codexMaxInflight: 1,
        judgmentsAddToQueueMaxBatchSize: 10,
        judgmentsReadyTargetMultiplier: 1,
      },
      JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
      judgmentsJobsCronGetPrompts: async () => {
        return {
          nextCursor: null,
          promptEntries: [
            {articleId: scopedArticleId, promptId},
            {articleId: outOfScopeArticleId, promptId},
          ],
        }
      },
      judgmentsJobsGetRunningJobs: async () => {
        return [{id: jobId, maxInflightRequests: null, modelProvider: 'openai', projectId, providerConnectionId: null}]
      },
    }
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?queue-reuse-scope=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(addReadyPromptsCalls).toEqual([[{articleId: outOfScopeArticleId, promptId}]])
})
