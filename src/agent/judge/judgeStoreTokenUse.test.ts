import {expect, mock, test} from 'bun:test'

const envModulePath = new URL('../../server/utils/env.ts', import.meta.url).pathname
const apiClientModulePath = new URL('../../services/apiClient.ts', import.meta.url).pathname
const judgeWorkerCompletionJournalModulePath = new URL(
  '../../server/cron/judgmentsJobs/judgeWorkerCompletionJournal.ts',
  import.meta.url,
).pathname
const judgmentRequestAttemptManifestStoreModulePath = new URL(
  '../../server/cron/judgmentsJobs/judgmentRequestAttemptManifestStore.ts',
  import.meta.url,
).pathname
const judgmentsRequestRuntimeModulePath = new URL(
  '../../server/cron/judgmentsJobs/judgmentsRequestRuntime.ts',
  import.meta.url,
).pathname
const tokenUseQueryServiceModulePath = new URL('../../server/services/tokenUseQueryService.ts', import.meta.url)
  .pathname

const markJudgmentRequestAttemptsClosed = mock(() => {
  return undefined
})
const attachTokenUseToPendingJudgeWorkerCompletion = mock(async () => {
  return true
})
const mutateAcceptedClaimRequestAttemptManifest = mock(async () => {
  return undefined
})
const compactClosedOutRequestAttemptManifestEntries = mock(async () => {
  return undefined
})
const insertTokenUse = mock(async () => {
  return {id: 'token-use-1'}
})
const recordRequestAttemptsEnteringPersistence = mock(async () => {
  return undefined
})
const recordRequestAttemptsPersistenceFailure = mock(async () => {
  return undefined
})

void mock.module(envModulePath, () => {
  const mockedEnv = {
    GPU_NNODES: 0,
    GPU_GPUS_PER_NODE: 0,
    GPU_TOTAL_GPUS: 0,
    TP_SIZE: 0,
    DP_SIZE: 0,
    GPU_SHAPE: null,
    SGLANG_MAX_RUNNING_REQUESTS: 1,
    SGLANG_MODEL: null,
  }

  return {
    env: mockedEnv,
    getEnv: () => {
      return mockedEnv
    },
    loadEnv: () => {
      return mockedEnv
    },
  }
})

void mock.module(apiClientModulePath, () => {
  return {
    apiClient: {
      api: {
        tokens: {
          usage: {
            post: async () => {
              return {data: {success: true}}
            },
          },
        },
      },
    },
  }
})

void mock.module(judgeWorkerCompletionJournalModulePath, () => {
  return {
    attachTokenUseToPendingJudgeWorkerCompletion,
    mutateAcceptedClaimRequestAttemptManifest,
    shouldUseJudgeWorkerOwnerHandoff: () => {
      return false
    },
  }
})

void mock.module(judgmentRequestAttemptManifestStoreModulePath, () => {
  return {
    compactClosedOutRequestAttemptManifestEntries,
    recordRequestAttemptsEnteringPersistence,
    recordRequestAttemptsPersistenceFailure,
  }
})

void mock.module(judgmentsRequestRuntimeModulePath, () => {
  return {markJudgmentRequestAttemptsClosed}
})

void mock.module(tokenUseQueryServiceModulePath, () => {
  return {
    getTokenUseQueryService: () => {
      return {insertTokenUse}
    },
  }
})

const buildEntry = ({
  outcome,
  error,
  baseURL = 'http://worker-a/v1',
  pendingQueueRetry = false,
  requestAttemptId = 'attempt-1',
}: {
  outcome: 'success' | 'failure'
  error: string | null
  baseURL?: string
  pendingQueueRetry?: boolean
  requestAttemptId?: string
}) => {
  return {
    articleId: 'article-1',
    promptIds: ['prompt-1'],
    modelId: 'model-1',
    modelName: 'model-name',
    baseURL,
    requestAttemptId,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    outcome,
    error,
    sanitizationAttempted: false,
    sanitizedError: null,
    sanitizedResponse: null,
    lastResponse: outcome === 'failure' ? '{bad json}' : null,
    systemPrompt: outcome === 'failure' ? 'system' : null,
    userPrompt: outcome === 'failure' ? 'user' : null,
    pendingQueueRetry,
  }
}

test('buildTokenUseTotals counts real attempts and keeps non-connection failures', () => {
  const {buildTokenUseTotals} = require('./judgeStoreTokenUse.ts') as typeof import('./judgeStoreTokenUse.ts')
  const totals = buildTokenUseTotals([
    buildEntry({outcome: 'success', error: null}),
    buildEntry({outcome: 'failure', error: 'Invalid JSON response'}),
    buildEntry({outcome: 'failure', error: 'Connection error'}),
    buildEntry({outcome: 'success', error: null, baseURL: 'http://worker-b/v1'}),
  ])

  expect(totals.totalRequests).toBe(4)
  expect(totals.successfulRequests).toBe(2)
  expect(totals.failedRequests).toBe(1)
  expect(totals.hasFailedRequests).toBe(true)
  expect(totals.failedRequestsDetails.length).toBe(1)
  expect(totals.failedRequestsDetails[0]?.error).toBe('Invalid JSON response')
  expect(totals.failedRequestsDetails[0]?.failedAttempts).toBe(2)
})

test('buildTokenUseTotals labels queue-retried recoverable failures as retry', () => {
  const {buildTokenUseTotals} = require('./judgeStoreTokenUse.ts') as typeof import('./judgeStoreTokenUse.ts')
  const totals = buildTokenUseTotals([
    buildEntry({
      outcome: 'failure',
      error:
        'Anthropic returned no text content (failure_code=anthropic_empty_response; stop_reason=refusal; content_types=none)',
      pendingQueueRetry: true,
    }),
    buildEntry({
      outcome: 'failure',
      error:
        'Anthropic returned no text content (failure_code=anthropic_empty_response; stop_reason=refusal; content_types=none)',
    }),
  ])

  expect(totals.failedRequests).toBe(2)
  expect(totals.hasFailedRequests).toBe(true)
  expect(totals.failedRequestsDetails).toHaveLength(1)
  expect(totals.failedRequestsDetails[0]?.failureType).toBe('retry')
  expect(totals.failedRequestsDetails[0]?.failedAttempts).toBe(2)
})

test('judgeStoreTokenUse journals low-memory judge-worker token use and clears pending persisted attempts', async () => {
  const previousServerRole = process.env.SERVER_ROLE
  const previousDuckdbMemoryLimit = process.env.DUCKDB_MEMORY_LIMIT

  process.env.SERVER_ROLE = 'judge-worker'
  process.env.DUCKDB_MEMORY_LIMIT = '6400MiB'
  attachTokenUseToPendingJudgeWorkerCompletion.mockClear()
  insertTokenUse.mockClear()
  markJudgmentRequestAttemptsClosed.mockClear()

  try {
    const judgeStoreTokenUseModule = (await import(
      `./judgeStoreTokenUse.ts?skip-token-use=${Date.now()}`
    )) as typeof import('./judgeStoreTokenUse.ts')

    await judgeStoreTokenUseModule.judgeStoreTokenUse(
      [
        buildEntry({outcome: 'success', error: null, requestAttemptId: 'attempt-success'}),
        buildEntry({outcome: 'failure', error: 'Invalid JSON response', requestAttemptId: 'attempt-failure'}),
      ],
      null,
      {duration: 1000, finishedAt: '2026-04-21T12:00:01.000Z', startedAt: '2026-04-21T12:00:00.000Z'},
      'job-1',
    )

    expect(insertTokenUse).not.toHaveBeenCalled()
    expect(attachTokenUseToPendingJudgeWorkerCompletion).toHaveBeenCalledWith(
      expect.objectContaining({articleId: 'article-1', jobId: 'job-1', promptIds: ['prompt-1']}),
    )
    const attachCalls = attachTokenUseToPendingJudgeWorkerCompletion.mock.calls as Array<
      [{tokenUse: {requestAttempts?: Array<{requestAttemptId: string}>; totalTokens: number}}]
    >
    expect(attachCalls[0]?.[0].tokenUse.totalTokens).toBe(30)
    expect(
      attachCalls[0]?.[0].tokenUse.requestAttempts?.map((entry) => {
        return entry.requestAttemptId
      }),
    ).toEqual(['attempt-success', 'attempt-failure'])
    expect(markJudgmentRequestAttemptsClosed).toHaveBeenCalledWith('job-1', ['attempt-success', 'attempt-failure'])
  } finally {
    if (previousServerRole === undefined) {
      delete process.env.SERVER_ROLE
    } else {
      process.env.SERVER_ROLE = previousServerRole
    }

    if (previousDuckdbMemoryLimit === undefined) {
      delete process.env.DUCKDB_MEMORY_LIMIT
    } else {
      process.env.DUCKDB_MEMORY_LIMIT = previousDuckdbMemoryLimit
    }
  }
})

test('judgeStoreTokenUse records persistence failure and leaves request attempts pending', async () => {
  const previousServerRole = process.env.SERVER_ROLE
  const previousDuckdbMemoryLimit = process.env.DUCKDB_MEMORY_LIMIT

  process.env.SERVER_ROLE = 'dev-single'
  delete process.env.DUCKDB_MEMORY_LIMIT
  insertTokenUse.mockClear()
  markJudgmentRequestAttemptsClosed.mockClear()
  recordRequestAttemptsPersistenceFailure.mockClear()
  insertTokenUse.mockImplementationOnce(async () => {
    throw new Error('duckdb down')
  })

  try {
    const judgeStoreTokenUseModule = (await import(
      `./judgeStoreTokenUse.ts?token-use-failure=${Date.now()}`
    )) as typeof import('./judgeStoreTokenUse.ts')

    const promise = judgeStoreTokenUseModule.judgeStoreTokenUse(
      [buildEntry({outcome: 'success', error: null, requestAttemptId: 'attempt-failure'})],
      null,
      {duration: 1000, finishedAt: '2026-04-21T12:00:01.000Z', startedAt: '2026-04-21T12:00:00.000Z'},
      'job-1',
    )
    const error = await promise.then(
      () => {
        return null
      },
      (thrown: unknown) => {
        return thrown
      },
    )

    expect(error).toBeInstanceOf(Error)
    expect(markJudgmentRequestAttemptsClosed).not.toHaveBeenCalled()
    const failureCalls = recordRequestAttemptsPersistenceFailure.mock.calls as Array<
      [{error: unknown; subreason: string}]
    >
    expect(failureCalls[0]?.[0].error).toBeInstanceOf(Error)
    expect(failureCalls[0]?.[0].subreason).toBe('token_use')
  } finally {
    if (previousServerRole === undefined) {
      delete process.env.SERVER_ROLE
    } else {
      process.env.SERVER_ROLE = previousServerRole
    }

    if (previousDuckdbMemoryLimit === undefined) {
      delete process.env.DUCKDB_MEMORY_LIMIT
    } else {
      process.env.DUCKDB_MEMORY_LIMIT = previousDuckdbMemoryLimit
    }
  }
})
