import {afterAll, beforeAll, expect, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-token-use-query-service')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let tokenUseQueryService: Awaited<typeof import('./tokenUseQueryService.ts')>['tokenUseQueryService'] | null = null
let TokenUseIdempotencyConflictErrorClass:
  | typeof import('./tokenUseQueryService.ts').TokenUseIdempotencyConflictError
  | null = null

const buildFailedRequestDetail = (promptIds: string[]) => {
  return {
    articleId: 'article-1',
    promptIds,
    modelId: 'model-1',
    modelName: 'model-name',
    baseURL: 'http://worker-a/v1',
    failureType: 'retry',
    attempts: 2,
    failedAttempts: 1,
    failedPromptTokens: 10,
    failedCompletionTokens: 5,
    failedTotalTokens: 15,
    error: 'Invalid JSON response',
    sanitizationAttempted: false,
    sanitizedError: null,
    sanitizedResponse: null,
    lastResponse: '{bad json}',
    systemPrompt: 'system',
    userPrompt: 'user',
  }
}

const getStoredFailedRequestDetails = async (failedRequestsDetails: unknown[]) => {
  if (!tokenUseQueryService) {
    throw new Error('Token use query service not initialized')
  }

  const row = await tokenUseQueryService.insertTokenUse({
    judgment_job_id: null,
    requests: 1,
    total_prompt_tokens: 10,
    total_completion_tokens: 5,
    total_tokens: 15,
    failed_requests: 1,
    has_failed_requests: true,
    failed_requests_details: failedRequestsDetails,
  })

  if (!row) {
    throw new Error('Failed to store token use row')
  }

  return await tokenUseQueryService.getFailedRequestById(row.id)
}

const getRequestAttemptCloseoutRows = async (requestAttemptId: string) => {
  const {getAppDatabaseService} = await import('./appDatabaseService.ts')

  return getAppDatabaseService().queryJson<{
    durableCloseoutId: string | null
    providerKey: string
    requestAttemptId: string
    tokenUseId: string
  }>(`
    SELECT
      durable_closeout_id AS durableCloseoutId,
      provider_key AS providerKey,
      request_attempt_id AS requestAttemptId,
      token_use_id AS tokenUseId
    FROM app.request_attempt_closeout
    WHERE request_attempt_id = '${requestAttemptId}'
    ORDER BY provider_key
  `)
}

beforeAll(async () => {
  const [
    {migrateDuckdb},
    {getAppDatabaseService},
    {resetDuckdbServiceForTests},
    {resetServerRuntimeRoleForTests},
    tokenUseQueryServiceModule,
  ] = await Promise.all([
    import('../../db/migrateDuckdb.ts'),
    import('./appDatabaseService.ts'),
    import('../utils/duckdbService.ts'),
    import('../utils/serverRuntimeRole.ts'),
    import('./tokenUseQueryService.ts'),
  ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  tokenUseQueryService = tokenUseQueryServiceModule.tokenUseQueryService
  TokenUseIdempotencyConflictErrorClass = tokenUseQueryServiceModule.TokenUseIdempotencyConflictError
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('insertTokenUse generates an id when one is not provided', async () => {
  if (!tokenUseQueryService) {
    throw new Error('Token use query service not initialized')
  }

  const row = await tokenUseQueryService.insertTokenUse({
    judgment_job_id: null,
    requests: 1,
    total_prompt_tokens: 10,
    total_completion_tokens: 5,
    total_tokens: 15,
  })

  expect(row).not.toBeNull()
  expect(row?.id.length ?? 0).toBeGreaterThan(0)
  expect(row?.requests).toBe(1)
  expect(Number(row?.totalTokens ?? 0)).toBe(15)
})

test('insertTokenUseOnce reloads matching conflicts and rejects durable mismatches', async () => {
  if (!tokenUseQueryService || !TokenUseIdempotencyConflictErrorClass) {
    throw new Error('Token use query service not initialized')
  }

  const values = {
    id: 'idempotent-token-use-1',
    judgment_job_id: null,
    requests: 1,
    total_prompt_tokens: 10,
    total_completion_tokens: 5,
    total_tokens: 15,
    request_attempts_json: JSON.stringify([{requestAttemptId: 'attempt-a', providerKey: 'provider-a'}]),
    started_at: new Date('2026-05-03T12:00:00.000Z'),
    finished_at: new Date('2026-05-03T12:00:01.000Z'),
    duration: 1000,
  }

  const inserted = await tokenUseQueryService.insertTokenUseOnce(values)
  const replayed = await tokenUseQueryService.insertTokenUseOnce(values)

  expect(inserted?.id).toBe('idempotent-token-use-1')
  expect(replayed?.id).toBe('idempotent-token-use-1')
  const mismatchError = await tokenUseQueryService.insertTokenUseOnce({...values, total_tokens: 16}).then(
    () => {
      return null
    },
    (error: unknown) => {
      return error
    },
  )

  expect(mismatchError).toBeInstanceOf(Error)
  expect(mismatchError).toBeInstanceOf(TokenUseIdempotencyConflictErrorClass)
  expect(mismatchError instanceof Error ? mismatchError.message : '').toBe(
    'token use idempotency conflict for idempotent-token-use-1: total_tokens mismatch',
  )
})

test('insertTokenUseOnce repairs missing closeout projections from canonical stored request attempts on replay', async () => {
  if (!tokenUseQueryService) {
    throw new Error('Token use query service not initialized')
  }

  const {getAppDatabaseService} = await import('./appDatabaseService.ts')
  const database = getAppDatabaseService()
  const requestAttemptId = 'attempt-replay-repair'
  const providerKey = 'provider-replay-repair'
  const replayValues = {
    id: 'idempotent-token-use-replay-repair',
    judgment_job_id: null,
    requests: 1,
    total_prompt_tokens: 11,
    total_completion_tokens: 7,
    total_tokens: 18,
    started_at: new Date('2026-05-03T13:00:00.000Z'),
    finished_at: new Date('2026-05-03T13:00:02.000Z'),
    duration: 2000,
  }
  const canonicalRequestAttempts = [
    {
      closeoutKind: 'token_use',
      durableCloseoutRef: {id: 'closeout-replay-repair', kind: 'token_use', jobId: 'job-replay-repair'},
      finishedAt: '2026-05-03T13:00:02.000Z',
      lifecycleState: 'completedRequest',
      outcome: 'success',
      providerKey,
      requestAttemptId,
    },
  ]

  await tokenUseQueryService.insertTokenUseOnce({
    ...replayValues,
    request_attempts_json: JSON.stringify(canonicalRequestAttempts),
  })
  expect(await getRequestAttemptCloseoutRows(requestAttemptId)).toHaveLength(1)

  await database.run(`DELETE FROM app.request_attempt_closeout WHERE request_attempt_id = '${requestAttemptId}'`)
  expect(await getRequestAttemptCloseoutRows(requestAttemptId)).toHaveLength(0)

  await tokenUseQueryService.insertTokenUseOnce(replayValues)
  const repairedRows = await getRequestAttemptCloseoutRows(requestAttemptId)

  expect(repairedRows).toEqual([
    {
      durableCloseoutId: 'closeout-replay-repair',
      providerKey,
      requestAttemptId,
      tokenUseId: 'idempotent-token-use-replay-repair',
    },
  ])
})

test('getFailedRequestById keeps failed request detail objects readable', async () => {
  const failedRequest = await getStoredFailedRequestDetails([buildFailedRequestDetail(['prompt-1'])])
  const firstDetail = Array.isArray(failedRequest?.failedRequestsDetails)
    ? (failedRequest.failedRequestsDetails[0] as {error?: string; promptIds?: string[]})
    : null

  expect(firstDetail?.promptIds).toEqual(['prompt-1'])
  expect(firstDetail?.error).toBe('Invalid JSON response')
})

test('getFailedRequestById normalizes legacy failed request detail strings', async () => {
  const failedRequest = await getStoredFailedRequestDetails([
    JSON.stringify(buildFailedRequestDetail(['prompt-legacy'])),
  ])
  const firstDetail = Array.isArray(failedRequest?.failedRequestsDetails)
    ? (failedRequest.failedRequestsDetails[0] as {error?: string; promptIds?: string[]})
    : null

  expect(firstDetail?.promptIds).toEqual(['prompt-legacy'])
  expect(firstDetail?.error).toBe('Invalid JSON response')
})

test('getTimelineBucketRowsAllJobs aggregates token rows before returning them', async () => {
  if (!tokenUseQueryService) {
    throw new Error('Token use query service not initialized')
  }

  const service = tokenUseQueryService
  const startDate = new Date('2030-01-01T00:00:00.000Z')
  const endDate = new Date('2030-01-01T00:10:00.000Z')
  const rows = [
    {id: 'bucket-row-1', createdAt: '2030-01-01T00:01:00.000Z', jobId: 'job-bucket', requests: 1, tokens: 12},
    {id: 'bucket-row-2', createdAt: '2030-01-01T00:04:00.000Z', jobId: 'job-bucket', requests: 2, tokens: 20},
    {id: 'bucket-row-3', createdAt: '2030-01-01T00:06:00.000Z', jobId: 'job-bucket', requests: 1, tokens: 7},
    {id: 'bucket-row-ignored', createdAt: '2030-01-01T00:02:00.000Z', jobId: null, requests: 1, tokens: 999},
  ]

  await Promise.all(
    rows.map((row) => {
      return service.insertTokenUse({
        id: row.id,
        judgment_job_id: row.jobId,
        requests: row.requests,
        total_prompt_tokens: row.tokens,
        total_completion_tokens: 0,
        total_tokens: row.tokens,
        created_at: new Date(row.createdAt),
        updated_at: new Date(row.createdAt),
      })
    }),
  )

  const buckets = await service.getTimelineBucketRowsAllJobs({interval: '5min', startDate, endDate})

  expect(
    buckets.map((row) => {
      return {
        requests: Number(row.requests ?? 0),
        timestamp: row.createdAt.toISOString(),
        tokens: Number(row.totalTokens),
      }
    }),
  ).toEqual([
    {requests: 3, timestamp: '2030-01-01T00:00:00.000Z', tokens: 32},
    {requests: 1, timestamp: '2030-01-01T00:05:00.000Z', tokens: 7},
  ])
})
