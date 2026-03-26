import {afterEach, expect, mock, test} from 'bun:test'

const getModulePath = (relativePath: string) => {
  return new URL(relativePath, 'file://' + process.cwd() + '/').pathname
}

const judgmentsJobsAddToQueueModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentsJobsAddToQueue.ts')
const appDatabaseServiceModulePath = getModulePath('./src/server/services/appDatabaseService.ts')
const inferenceRuntimeConfigModulePath = getModulePath('./src/server/utils/getInferenceRuntimeConfig.ts')
const judgmentJobSqliteServiceModulePath = getModulePath('./src/server/cron/judgmentsJobs/judgmentJobSqliteService.ts')
const legacyJobCursorStoreModulePath = getModulePath('./src/server/cron/judgmentsJobs/legacyJobCursorStore.ts')
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
  exhaustedAt: Date
  lastProjectRefreshAckSeq: number | null
  scanEpoch: number
  wrapVisibilityAckSeq: number | null
}

type MockSqliteService = {
  addReadyPrompts: () => Promise<number>
  ensureOwnedLease: () => Promise<void>
  getMaxOutboxSeq: () => Promise<number | null>
  getReadyCount: () => Promise<number>
  getScanState: () => Promise<MockScanState>
  hasJob: () => boolean
  setScanState: (jobId: string, state: Record<string, unknown>) => Promise<void>
  syncOwnedLeases: () => Promise<void>
}

type MockLegacyCursorStore = {
  clearLegacyJobCursor: (jobId: string) => Promise<void>
  getLegacyJobCursor: (jobId: string) => Promise<{lastArticleId: string; lastDate: Date} | null>
  setLegacyJobCursor: (jobId: string, cursor: {lastArticleId: string; lastDate: Date}) => Promise<void>
  syncLegacyJobCursors: (jobIds: string[]) => Promise<void>
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

const getDefaultLegacyCursorStore = (): MockLegacyCursorStore => {
  return {
    clearLegacyJobCursor: async (_jobId: string) => {
      return undefined
    },
    getLegacyJobCursor: async (_jobId: string) => {
      return null
    },
    setLegacyJobCursor: async (_jobId: string, _cursor: {lastArticleId: string; lastDate: Date}) => {
      return undefined
    },
    syncLegacyJobCursors: async (_jobIds: string[]) => {
      return undefined
    },
  }
}

const registerSharedMocks = (
  sqliteService: MockSqliteService,
  getPromptsCalls: {count: number},
  {
    getPromptsImpl,
    legacyCursorStore = getDefaultLegacyCursorStore(),
  }: {
    getPromptsImpl?: (
      projectId: string,
      jobId: string,
      numberOfPromptsToGet: number,
      cursor?: {lastArticleId: string; lastDate: Date} | null,
    ) => Promise<{
      nextCursor: {lastArticleId: string; lastDate: Date} | null
      promptEntries: Array<{articleId: string; promptId: string}>
    }>
    legacyCursorStore?: MockLegacyCursorStore
  } = {},
) => {
  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async <T>(statement: string): Promise<T[]> => {
            return statement.includes('FROM app.judgment_job_prompt')
              ? ([{count: 0}] as T[])
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
  void mock.module(legacyJobCursorStoreModulePath, () => {
    return legacyCursorStore
  })
  void mock.module(judgmentsJobsCronGetPromptsModulePath, () => {
    return {
      judgmentsJobsCronGetPrompts: async (
        projectId: string,
        jobId: string,
        numberOfPromptsToGet: number,
        cursor?: {lastArticleId: string; lastDate: Date} | null,
      ) => {
        getPromptsCalls.count += 1
        return getPromptsImpl
          ? getPromptsImpl(projectId, jobId, numberOfPromptsToGet, cursor)
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

test('keeps exhausted SQLite jobs blocked when visibility watermark is behind', async () => {
  const getPromptsCalls = {count: 0}
  const setScanStateCalls: Array<{jobId: string; state: Record<string, unknown>}> = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async () => {
      return 0
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    getMaxOutboxSeq: async () => {
      return 12
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
    setScanState: async (jobId: string, state: Record<string, unknown>) => {
      setScanStateCalls.push({jobId, state})
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls)

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?blocked=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(getPromptsCalls.count).toBe(0)
  expect(setScanStateCalls).toHaveLength(0)
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
    getMaxOutboxSeq: async () => {
      return 12
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
    setScanState: async (jobId: string, state: Record<string, unknown>) => {
      setScanStateCalls.push({jobId, state})
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls)

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

test('uses local legacy cursor state for non-SQLite jobs', async () => {
  const getPromptsCalls = {count: 0}
  const startingCursor = {lastArticleId: 'article-0', lastDate: new Date('2025-01-01T00:00:00.000Z')}
  const nextCursor = {lastArticleId: 'article-1', lastDate: new Date('2025-01-02T00:00:00.000Z')}
  const receivedCursors: Array<{lastArticleId: string; lastDate: Date} | null | undefined> = []
  const setCursorCalls: Array<{cursor: {lastArticleId: string; lastDate: Date}; jobId: string}> = []
  const syncCalls: string[][] = []
  const sqliteService: MockSqliteService = {
    addReadyPrompts: async () => {
      return 0
    },
    ensureOwnedLease: async () => {
      return undefined
    },
    getMaxOutboxSeq: async () => {
      return null
    },
    getReadyCount: async () => {
      return 0
    },
    getScanState: async () => {
      return getExhaustedScanState(null, null)
    },
    hasJob: () => {
      return false
    },
    setScanState: async (_jobId: string, _state: Record<string, unknown>) => {
      return undefined
    },
    syncOwnedLeases: async () => {
      return undefined
    },
  }

  registerSharedMocks(sqliteService, getPromptsCalls, {
    getPromptsImpl: async (_projectId, _jobId, _numberOfPromptsToGet, cursor) => {
      receivedCursors.push(cursor)
      return {nextCursor, promptEntries: [{articleId: 'article-1', promptId: 'prompt-1'}]}
    },
    legacyCursorStore: {
      clearLegacyJobCursor: async (_jobId: string) => {
        return undefined
      },
      getLegacyJobCursor: async (_jobId: string) => {
        return startingCursor
      },
      setLegacyJobCursor: async (jobId: string, cursor: {lastArticleId: string; lastDate: Date}) => {
        setCursorCalls.push({cursor, jobId})
      },
      syncLegacyJobCursors: async (jobIds: string[]) => {
        syncCalls.push(jobIds)
      },
    },
  })

  const module = (await import(
    `${judgmentsJobsAddToQueueModulePath}?legacy-cursor=${Date.now()}`
  )) as JudgmentsJobsAddToQueueModule

  await module.judgmentsJobsAddToQueue('server-1')

  expect(getPromptsCalls.count).toBe(1)
  expect(syncCalls).toEqual([['job-1']])
  expect(receivedCursors).toEqual([startingCursor])
  expect(setCursorCalls).toEqual([{cursor: nextCursor, jobId: 'job-1'}])
})
