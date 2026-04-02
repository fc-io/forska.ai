import {afterEach, expect, mock, test} from 'bun:test'

const getModulePath = (relativePath: string) => {
  return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
}

const judgmentsJobsAddToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
const appDatabaseServiceModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
const inferenceRuntimeConfigModulePath = getModulePath('./src/server/utils/getInferenceRuntimeConfig.ts')
const judgmentJobSqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
const judgmentsJobsCronGetPromptsModulePath = getModulePath(
  './src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts',
)
const judgmentsJobsGetRunningJobsModulePath = getModulePath(
  './src/server/cron/judgmentsJobs/judgmentsJobsGetRunningJobs.ts',
)
const getJudgmentsCapacityModulePath = getModulePath('./src/server/cron/judgmentsJobs/getJudgmentsCapacity.ts')
type JudgmentsJobsAddToQueueModule = typeof import('./judgmentsJobsAddToQueue.ts')

type MockScanState = {
  cursor: null
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
  getReadyCount: () => Promise<number>
  getScanState: () => Promise<MockScanState>
  hasJob: () => boolean
  initializeJob: () => Promise<void>
  setScanState: (jobId: string, state: Record<string, unknown>) => Promise<void>
  syncOwnedLeases: () => Promise<void>
}

const getRunningJob = () => {
  return {id: 'job-1', modelProvider: 'openai', projectId: 'project-1'}
}

const getJobConfigRow = () => {
  return {modelId: 'model-1', useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true}
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
    getPromptsImpl,
    projectDirtyToken = null,
  }: {
    getPromptsImpl?: (
      projectId: string,
      jobId: string,
      numberOfPromptsToGet: number,
      cursor?: {lastArticleId: string; lastDate: Date} | null,
      preferRawFallback?: boolean,
    ) => Promise<{
      nextCursor: {lastArticleId: string; lastDate: Date} | null
      promptEntries: Array<{articleId: string; promptId: string}>
    }>
    projectDirtyToken?: number | null
  } = {},
) => {
  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async <T>(statement: string): Promise<T[]> => {
            return statement.includes('FROM app.project_mart_refresh_state pmrs')
              ? [{dirtyToken: projectDirtyToken} as T]
              : statement.includes('FROM app.judgment_job jj')
                ? [getJobConfigRow() as T]
                : []
          },
          run: async (_statement: string): Promise<void> => {
            return undefined
          },
        }
      },
    }
  })
  void mock.module(inferenceRuntimeConfigModulePath, () => {
    return {inferenceRuntimeConfig: {judgmentsAddToQueueMaxBatchSize: 1, judgmentsReadyTargetMultiplier: 1}}
  })
  void mock.module(judgmentJobSqliteServiceModulePath, () => {
    return {
      JudgmentJobLeaseError: class JudgmentJobLeaseError extends Error {},
      getJudgmentJobSqliteService: () => {
        return sqliteService
      },
    }
  })
  void mock.module(judgmentsJobsCronGetPromptsModulePath, () => {
    return {
      judgmentsJobsCronGetPrompts: async (
        projectId: string,
        jobId: string,
        numberOfPromptsToGet: number,
        cursor?: {lastArticleId: string; lastDate: Date} | null,
        preferRawFallback?: boolean,
      ) => {
        getPromptsCalls.count += 1
        return getPromptsImpl
          ? getPromptsImpl(projectId, jobId, numberOfPromptsToGet, cursor, preferRawFallback)
          : {nextCursor: null, promptEntries: []}
      },
    }
  })
  void mock.module(judgmentsJobsGetRunningJobsModulePath, () => {
    return {
      judgmentsJobsGetRunningJobs: async () => {
        return [getRunningJob()]
      },
    }
  })
  void mock.module(getJudgmentsCapacityModulePath, () => {
    return {
      getJudgmentsCapacity: () => {
        return {addToQueueMaxBatchSize: 1, readyTargetPerJob: 1}
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
