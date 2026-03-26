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

const registerSharedMocks = (sqliteService: MockSqliteService, getPromptsCalls: {count: number}) => {
  void mock.module(appDatabaseServiceModulePath, () => {
    return {
      getAppDatabaseService: () => {
        return {
          queryJson: async <T>(statement: string): Promise<T[]> => {
            return statement.includes('FROM app.judgment_job') ? [getJobConfigRow() as T] : []
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
      judgmentsJobsCronGetPrompts: async () => {
        getPromptsCalls.count += 1
        return {nextCursor: null, promptEntries: []}
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
