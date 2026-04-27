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
      return tokenUseQueryService.insertTokenUse({
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

  const buckets = await tokenUseQueryService.getTimelineBucketRowsAllJobs({interval: '5min', startDate, endDate})

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
