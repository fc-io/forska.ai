import {expect, mock, test} from 'bun:test'

const envModulePath = new URL('../../server/utils/env.ts', import.meta.url).pathname
const apiClientModulePath = new URL('../../services/apiClient.ts', import.meta.url).pathname
const judgeWorkerCompletionJournalModulePath = new URL(
  '../../server/cron/judgmentsJobs/judgeWorkerCompletionJournal.ts',
  import.meta.url,
).pathname
const judgmentsRequestRuntimeModulePath = new URL(
  '../../server/cron/judgmentsJobs/judgmentsRequestRuntime.ts',
  import.meta.url,
).pathname
const tokenUseQueryServiceModulePath = new URL('../../server/services/tokenUseQueryService.ts', import.meta.url)
  .pathname

const markJudgmentRequestsPersisted = mock(() => {})
const attachTokenUseToPendingJudgeWorkerCompletion = mock(async () => true)
const insertTokenUse = mock(async () => {
  return {id: 'token-use-1'}
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
  return {attachTokenUseToPendingJudgeWorkerCompletion}
})

void mock.module(judgmentsRequestRuntimeModulePath, () => {
  return {markJudgmentRequestsPersisted}
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
}: {
  outcome: 'success' | 'failure'
  error: string | null
  baseURL?: string
  pendingQueueRetry?: boolean
}) => {
  return {
    articleId: 'article-1',
    promptIds: ['prompt-1'],
    modelId: 'model-1',
    modelName: 'model-name',
    baseURL,
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
  markJudgmentRequestsPersisted.mockClear()

  try {
    const {judgeStoreTokenUse} = (await import(
      `./judgeStoreTokenUse.ts?skip-token-use=${Date.now()}`
    )) as typeof import('./judgeStoreTokenUse.ts')

    await judgeStoreTokenUse(
      [buildEntry({outcome: 'success', error: null})],
      null,
      {duration: 1000, finishedAt: '2026-04-21T12:00:01.000Z', startedAt: '2026-04-21T12:00:00.000Z'},
      'job-1',
    )

    expect(insertTokenUse).not.toHaveBeenCalled()
    expect(attachTokenUseToPendingJudgeWorkerCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        articleId: 'article-1',
        jobId: 'job-1',
        promptIds: ['prompt-1'],
        tokenUse: expect.objectContaining({totalTokens: 15}),
      }),
    )
    expect(markJudgmentRequestsPersisted).toHaveBeenCalledWith('job-1', 1)
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
