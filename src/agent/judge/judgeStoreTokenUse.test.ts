import {expect, mock, test} from 'bun:test'

const envModulePath = new URL('../../server/utils/env.ts', import.meta.url).pathname
const apiClientModulePath = new URL('../../services/apiClient.ts', import.meta.url).pathname

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
