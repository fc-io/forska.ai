import {afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, spyOn, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import type {getAppDatabaseService} from './appDatabaseService.ts'
import type {
  JudgmentJobProviderFailureKind,
  JudgmentJobProviderHealthStatus,
} from './judgmentJobProviderHealthService.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('judgment-job-provider-health-service')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type ProviderHealthService = typeof import('./judgmentJobProviderHealthService.ts')

const liveCodexUsageLimitMessage =
  'codex app-server: turn failed: You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 9:33 PM.'

let database: ReturnType<typeof getAppDatabaseService> | null = null
let providerHealthService: ProviderHealthService | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const getService = () => {
  if (providerHealthService === null) {
    throw new Error('Provider health service not initialized')
  }

  return providerHealthService
}

const getLocalDate = (...parts: [number, number, number, number, number, number?]) => {
  return new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5] ?? 0, 0)
}

const getJobId = (label: string) => {
  return `provider-health-${label}-${Math.random().toString(36).slice(2)}`
}

beforeAll(async () => {
  const [{migrateDuckdb}, appDatabaseModule, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}, service] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('./appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
      import('./judgmentJobProviderHealthService.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  await migrateDuckdb()

  database = appDatabaseModule.getAppDatabaseService()
  providerHealthService = service
})

beforeEach(() => {
  providerHealthService?.resetJudgmentJobProviderHealthCacheForTests()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test.each<
  [string, Parameters<ProviderHealthService['classifyJudgmentJobProviderFailure']>[0], JudgmentJobProviderFailureKind]
>([
  [
    'the live Codex usage-limit turn failure',
    {failureCode: 'codex_transient_turn_failure', message: liveCodexUsageLimitMessage},
    'usage_limit',
  ],
  [
    'an OpenAI quota 429',
    {message: 'You exceeded your current quota, check your plan and billing details.', statusCode: 429},
    'usage_limit',
  ],
  ['insufficient credits', {message: 'insufficient_credits: top up your account'}, 'usage_limit'],
  ['a bare 429', {message: 'Request failed', statusCode: 429}, 'rate_limited'],
  ['a 429 that also mentions an invalid key', {message: 'invalid api key', statusCode: 429}, 'rate_limited'],
  [
    'a rate_limited connection failure',
    {connectionFailureKind: 'rate_limited', message: 'Provider endpoint outage'},
    'rate_limited',
  ],
  ['a too many requests message', {message: 'HTTP error: Too Many Requests'}, 'rate_limited'],
  ['a 401', {message: 'Request failed', statusCode: 401}, 'auth'],
  [
    'an Anthropic 429 message without a status code',
    {message: 'Anthropic request failed (429): [rate_limit_error] slow down'},
    'rate_limited',
  ],
  ['an HTTP error 429 message without a status code', {message: 'HTTP error: 429'}, 'rate_limited'],
  ['an OpenAI SDK 401 message without a status code', {message: '401 Incorrect API key provided'}, 'auth'],
  [
    'a status code 503 message without a status code',
    {message: 'Request failed with status code 503'},
    'endpoint_unavailable',
  ],
  ['a Google 404 message without a status code', {message: 'Google request failed (404)'}, 'endpoint_unavailable'],
  ['a 403', {statusCode: 403}, 'auth'],
  ['an invalid api key message', {message: 'Incorrect or invalid API key provided'}, 'auth'],
  [
    'an endpoint_unavailable connection failure',
    {connectionFailureKind: 'endpoint_unavailable'},
    'endpoint_unavailable',
  ],
  [
    'an endpoint_misconfigured connection failure',
    {connectionFailureKind: 'endpoint_misconfigured'},
    'endpoint_unavailable',
  ],
  ['a 404', {message: 'Not found', statusCode: 404}, 'endpoint_unavailable'],
  ['a 503', {message: 'Service unavailable', statusCode: 503}, 'endpoint_unavailable'],
  ['a timeout message', {message: 'codex app-server: request timed out after 900000ms'}, 'timeout'],
  [
    'a network_unavailable connection failure',
    {connectionFailureKind: 'network_unavailable', message: 'socket hang up'},
    'network',
  ],
  ['an ECONNREFUSED message', {message: 'fetch failed: connect ECONNREFUSED 127.0.0.1:30001'}, 'network'],
  [
    'an Anthropic empty response',
    {failureCode: 'anthropic_refusal_empty_response', message: 'empty response'},
    'other',
  ],
  ['garbage', {message: 'qwerty 42 !!'}, 'other'],
  ['an empty input', {}, 'other'],
  ['a non-finite status code', {statusCode: Number.NaN}, 'other'],
])('classifyJudgmentJobProviderFailure maps %s', (_label, input, expectedKind) => {
  expect(getService().classifyJudgmentJobProviderFailure(input)).toBe(expectedKind)
})

test('parseProviderRetryAfterAt reads the live Codex usage-limit time as local time', () => {
  const now = getLocalDate(2026, 9, 3, 5, 17)

  expect(getService().parseProviderRetryAfterAt(liveCodexUsageLimitMessage, now)).toEqual(
    getLocalDate(2026, 9, 3, 21, 33),
  )
})

test('parseProviderRetryAfterAt reads calendar dates without a year as the next occurrence', () => {
  const {parseProviderRetryAfterAt} = getService()

  expect(parseProviderRetryAfterAt('try again at Oct 3rd 9:33 PM', getLocalDate(2026, 9, 3, 21, 40))).toEqual(
    getLocalDate(2026, 9, 3, 21, 33),
  )
  expect(parseProviderRetryAfterAt('try again at Oct 3rd 9:33 PM', getLocalDate(2026, 9, 4, 8, 0))).toEqual(
    getLocalDate(2027, 9, 3, 21, 33),
  )
  expect(parseProviderRetryAfterAt('Try again at January 2 12:05 AM.', getLocalDate(2026, 11, 31, 23, 0))).toEqual(
    getLocalDate(2027, 0, 2, 0, 5),
  )
  expect(parseProviderRetryAfterAt('try again at September 30, 2026 14:05', getLocalDate(2026, 9, 3, 8, 0))).toEqual(
    getLocalDate(2026, 8, 30, 14, 5),
  )
})

test('parseProviderRetryAfterAt reads same-day clock times as the next occurrence', () => {
  const {parseProviderRetryAfterAt} = getService()
  const message = 'You’ve hit your usage limit. Try again at 9:33 PM.'

  expect(parseProviderRetryAfterAt(message, getLocalDate(2026, 9, 3, 13, 0))).toEqual(getLocalDate(2026, 9, 3, 21, 33))
  expect(parseProviderRetryAfterAt(message, getLocalDate(2026, 9, 3, 23, 0))).toEqual(getLocalDate(2026, 9, 4, 21, 33))
  expect(parseProviderRetryAfterAt('try again at 12:00 AM', getLocalDate(2026, 9, 3, 13, 0))).toEqual(
    getLocalDate(2026, 9, 4, 0, 0),
  )
})

test('parseProviderRetryAfterAt reads relative durations and Retry-After headers', () => {
  const {parseProviderRetryAfterAt} = getService()
  const now = new Date('2026-10-03T12:00:00.000Z')

  expect(parseProviderRetryAfterAt('Rate limit reached, retry after 30 seconds', now)).toEqual(
    new Date('2026-10-03T12:00:30.000Z'),
  )
  expect(parseProviderRetryAfterAt('retry after 5 minutes', now)).toEqual(new Date('2026-10-03T12:05:00.000Z'))
  expect(parseProviderRetryAfterAt('Please try again in 1.5s.', now)).toEqual(new Date('2026-10-03T12:00:01.500Z'))
  expect(parseProviderRetryAfterAt('try again in 2 hours 13 minutes', now)).toEqual(
    new Date('2026-10-03T14:13:00.000Z'),
  )
  expect(parseProviderRetryAfterAt('HTTP error: 429 Retry-After: 120', now)).toEqual(
    new Date('2026-10-03T12:02:00.000Z'),
  )
  expect(parseProviderRetryAfterAt('retry-after-ms: 1500', now)).toEqual(new Date('2026-10-03T12:00:01.500Z'))
  expect(parseProviderRetryAfterAt('Retry-After: Sat, 03 Oct 2026 12:10:00 GMT', now)).toEqual(
    new Date('2026-10-03T12:10:00.000Z'),
  )
})

test('parseProviderRetryAfterAt returns null for garbage and invalid times without throwing', () => {
  const {parseProviderRetryAfterAt} = getService()
  const now = getLocalDate(2026, 9, 3, 13, 0)

  expect(parseProviderRetryAfterAt('Something went wrong (qwerty 42)', now)).toBeNull()
  expect(parseProviderRetryAfterAt('You’ve hit your usage limit. Try again later.', now)).toBeNull()
  expect(parseProviderRetryAfterAt('try again at Feb 30th, 2026 9:00 AM', now)).toBeNull()
  expect(parseProviderRetryAfterAt('try again at 25:99', now)).toBeNull()
  expect(parseProviderRetryAfterAt('try again at 13:05 PM', now)).toBeNull()
  expect(parseProviderRetryAfterAt('', now)).toBeNull()
  expect(parseProviderRetryAfterAt(null, now)).toBeNull()
  expect(parseProviderRetryAfterAt(undefined)).toBeNull()
  expect(parseProviderRetryAfterAt('retry after 30 seconds', new Date(Number.NaN))).toBeNull()
})

test('getProviderFailureRetryDelayMs clamps usage-limit delays to the provider retry time', () => {
  const {getProviderFailureRetryDelayMs} = getService()
  const now = new Date('2026-10-03T12:00:00.000Z')
  const getUsageLimitDelay = (retryAfterAt: Date | null) => {
    return getProviderFailureRetryDelayMs({consecutiveFailureCount: 4, failureKind: 'usage_limit', now, retryAfterAt})
  }

  expect(getUsageLimitDelay(null)).toBe(300_000)
  expect(getUsageLimitDelay(new Date('2026-10-03T12:00:10.000Z'))).toBe(60_000)
  expect(getUsageLimitDelay(new Date('2026-10-03T11:00:00.000Z'))).toBe(60_000)
  expect(getUsageLimitDelay(new Date('2026-10-03T12:10:00.000Z'))).toBe(600_000)
  expect(getUsageLimitDelay(new Date('2026-10-03T12:30:00.000Z'))).toBe(1_800_000)
  expect(getUsageLimitDelay(new Date('2026-10-03T21:33:00.000Z'))).toBe(1_800_000)
})

test('getProviderFailureRetryDelayMs uses fixed delays for rate limits and auth failures', () => {
  const {getProviderFailureRetryDelayMs} = getService()

  expect(
    getProviderFailureRetryDelayMs({consecutiveFailureCount: 1, failureKind: 'rate_limited', retryAfterAt: null}),
  ).toBe(60_000)
  expect(
    getProviderFailureRetryDelayMs({consecutiveFailureCount: 9, failureKind: 'rate_limited', retryAfterAt: null}),
  ).toBe(60_000)
  expect(getProviderFailureRetryDelayMs({consecutiveFailureCount: 1, failureKind: 'auth', retryAfterAt: null})).toBe(
    300_000,
  )
  expect(getProviderFailureRetryDelayMs({consecutiveFailureCount: 9, failureKind: 'auth', retryAfterAt: null})).toBe(
    300_000,
  )
})

test.each<[JudgmentJobProviderFailureKind, number, number | null]>([
  ['endpoint_unavailable', 1, 30_000],
  ['endpoint_unavailable', 2, 60_000],
  ['endpoint_unavailable', 3, 120_000],
  ['endpoint_unavailable', 4, 240_000],
  ['endpoint_unavailable', 5, 300_000],
  ['endpoint_unavailable', 40, 300_000],
  ['network', 1, 30_000],
  ['network', 4, 240_000],
  ['network', 6, 300_000],
  ['timeout', 1, 30_000],
  ['timeout', 3, 120_000],
  ['timeout', 5, 300_000],
  ['other', 1, null],
  ['other', 2, null],
  ['other', 3, 15_000],
  ['other', 4, 30_000],
  ['other', 5, 60_000],
  ['other', 6, 120_000],
  ['other', 7, 240_000],
  ['other', 8, 300_000],
  ['other', 2000, 300_000],
])(
  'getProviderFailureRetryDelayMs backs off %s after %i consecutive failures',
  (failureKind, count, expectedDelayMs) => {
    expect(
      getService().getProviderFailureRetryDelayMs({consecutiveFailureCount: count, failureKind, retryAfterAt: null}),
    ).toBe(expectedDelayMs)
  },
)

test('recordJudgmentJobProviderFailure starts an episode and increments consecutive failures', async () => {
  const {getJudgmentJobProviderHealth, recordJudgmentJobProviderFailure} = getService()
  const jobId = getJobId('episode')
  const firstFailedAt = getLocalDate(2026, 9, 3, 5, 17)
  const secondFailedAt = getLocalDate(2026, 9, 3, 5, 18)

  const firstRow = await recordJudgmentJobProviderFailure({
    failureCode: 'codex_transient_turn_failure',
    jobId,
    message: liveCodexUsageLimitMessage,
    modelId: 'model-gpt-6-astra',
    now: firstFailedAt,
  })

  expect(firstRow).toEqual({
    consecutiveFailureCount: 1,
    failureCode: 'codex_transient_turn_failure',
    failureKind: 'usage_limit',
    failureMessage: liveCodexUsageLimitMessage,
    firstFailedAt,
    jobId,
    lastFailedAt: firstFailedAt,
    lastSuccessAt: null,
    modelId: 'model-gpt-6-astra',
    recoveredAt: null,
    retryAfterAt: getLocalDate(2026, 9, 3, 21, 33),
    status: 'failing',
    totalFailureCount: 1,
    updatedAt: firstFailedAt,
  })

  const secondRow = await recordJudgmentJobProviderFailure({
    jobId,
    message: `  Too Many Requests, retry after 30 seconds ${'x'.repeat(1200)}  `,
    now: secondFailedAt,
    statusCode: 429,
  })

  expect(secondRow).toMatchObject({
    consecutiveFailureCount: 2,
    failureCode: null,
    failureKind: 'rate_limited',
    firstFailedAt,
    lastFailedAt: secondFailedAt,
    modelId: 'model-gpt-6-astra',
    recoveredAt: null,
    retryAfterAt: new Date(secondFailedAt.getTime() + 30_000),
    status: 'failing',
    totalFailureCount: 2,
    updatedAt: secondFailedAt,
  })
  expect(secondRow.failureMessage?.length).toBe(1000)
  expect(secondRow.failureMessage?.startsWith('Too Many Requests, retry after 30 seconds')).toBe(true)
  expect(await getJudgmentJobProviderHealth(jobId)).toEqual(secondRow)
})

test('recordJudgmentJobProviderSuccess recovers a failing job and the next failure starts a new episode', async () => {
  const {getJudgmentJobProviderHealth, recordJudgmentJobProviderFailure, recordJudgmentJobProviderSuccess} =
    getService()
  const jobId = getJobId('recovery')
  const firstFailedAt = new Date('2026-10-03T05:17:00.000Z')
  const secondFailedAt = new Date('2026-10-03T05:18:00.000Z')
  const recoveredAt = new Date('2026-10-03T21:34:00.000Z')
  const laterSuccessAt = new Date('2026-10-03T21:35:00.000Z')
  const nextFailedAt = new Date('2026-10-04T09:00:00.000Z')

  await recordJudgmentJobProviderFailure({jobId, message: 'fetch failed', modelId: 'model-1', now: firstFailedAt})
  await recordJudgmentJobProviderFailure({jobId, message: 'fetch failed', now: secondFailedAt})
  await recordJudgmentJobProviderSuccess({jobId, now: recoveredAt})

  const recoveredRow = await getJudgmentJobProviderHealth(jobId)

  expect(recoveredRow).toMatchObject({
    consecutiveFailureCount: 0,
    failureKind: 'network',
    firstFailedAt,
    lastFailedAt: secondFailedAt,
    lastSuccessAt: recoveredAt,
    recoveredAt,
    status: 'recovered',
    totalFailureCount: 2,
    updatedAt: recoveredAt,
  })

  await recordJudgmentJobProviderSuccess({jobId, now: laterSuccessAt})

  expect(await getJudgmentJobProviderHealth(jobId)).toEqual(recoveredRow)

  const nextEpisodeRow = await recordJudgmentJobProviderFailure({
    connectionFailureKind: 'endpoint_unavailable',
    jobId,
    message: 'Provider endpoint outage',
    now: nextFailedAt,
  })

  expect(nextEpisodeRow).toMatchObject({
    consecutiveFailureCount: 1,
    failureKind: 'endpoint_unavailable',
    firstFailedAt: nextFailedAt,
    lastFailedAt: nextFailedAt,
    lastSuccessAt: recoveredAt,
    modelId: 'model-1',
    recoveredAt: null,
    retryAfterAt: null,
    status: 'failing',
    totalFailureCount: 3,
  })
})

test('recordJudgmentJobProviderSuccess loads failing jobs once and skips DuckDB for healthy jobs', async () => {
  const {getJudgmentJobProviderHealth, recordJudgmentJobProviderSuccess} = getService()
  const failingJobId = getJobId('lazy-load')
  const healthyJobId = getJobId('healthy')
  const recoveredAt = new Date('2026-10-03T22:00:00.000Z')

  await getDatabase().run(`
    INSERT INTO app.judgment_job_provider_health (
      job_id, model_id, status, failure_kind, failure_code, failure_message, retry_after_at,
      first_failed_at, last_failed_at, consecutive_failure_count, total_failure_count
    ) VALUES (
      '${failingJobId}', 'model-1', 'failing', 'usage_limit', NULL, 'usage limit', NULL,
      TIMESTAMPTZ '2026-10-03T05:00:00Z', TIMESTAMPTZ '2026-10-03T21:00:00Z', 7, 7
    )
  `)

  const querySpy = spyOn(getDatabase(), 'queryJson')
  const runSpy = spyOn(getDatabase(), 'run')

  try {
    await recordJudgmentJobProviderSuccess({jobId: healthyJobId, now: recoveredAt})

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(runSpy).toHaveBeenCalledTimes(0)

    await recordJudgmentJobProviderSuccess({jobId: healthyJobId, now: recoveredAt})
    await recordJudgmentJobProviderSuccess({jobId: failingJobId, now: recoveredAt})

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(runSpy).toHaveBeenCalledTimes(1)

    await recordJudgmentJobProviderSuccess({jobId: failingJobId, now: recoveredAt})

    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(runSpy).toHaveBeenCalledTimes(1)
  } finally {
    querySpy.mockRestore()
    runSpy.mockRestore()
  }

  expect(await getJudgmentJobProviderHealth(healthyJobId)).toBeNull()
  expect(await getJudgmentJobProviderHealth(failingJobId)).toMatchObject({
    consecutiveFailureCount: 0,
    lastSuccessAt: recoveredAt,
    recoveredAt,
    status: 'recovered',
    totalFailureCount: 7,
  })
})

test('getJudgmentJobProviderHealthMap reads several jobs through the given read database', async () => {
  const {getJudgmentJobProviderHealthMap, recordJudgmentJobProviderFailure} = getService()
  const firstJobId = getJobId('map-a')
  const secondJobId = getJobId('map-b')
  const missingJobId = getJobId('map-missing')
  const statements: string[] = []
  const readDatabase = {
    queryJson: <T>(statement: string) => {
      statements.push(statement)
      return getDatabase().queryJson<T>(statement)
    },
  }

  await recordJudgmentJobProviderFailure({jobId: firstJobId, message: 'Unauthorized', statusCode: 401})
  await recordJudgmentJobProviderFailure({jobId: secondJobId, message: 'Request timed out'})

  const healthMap = await getJudgmentJobProviderHealthMap([firstJobId, missingJobId, secondJobId, firstJobId], {
    database: readDatabase,
  })

  expect(statements).toHaveLength(1)
  expect([...healthMap.keys()].sort()).toEqual([firstJobId, secondJobId].sort())
  expect(healthMap.get(firstJobId)?.failureKind).toBe('auth')
  expect(healthMap.get(secondJobId)?.failureKind).toBe('timeout')
  expect(healthMap.has(missingJobId)).toBe(false)
  expect(await getJudgmentJobProviderHealthMap([], {database: readDatabase})).toEqual(new Map())
  expect(statements).toHaveLength(1)
})

test('toJudgmentJobProviderHealthApi returns ISO strings and marks failing rows active', async () => {
  const {recordJudgmentJobProviderFailure, recordJudgmentJobProviderSuccess, toJudgmentJobProviderHealthApi} =
    getService()
  const jobId = getJobId('api')
  const failedAt = new Date('2026-10-03T19:00:00.000Z')
  const recoveredAt = new Date('2026-10-03T21:34:00.000Z')
  const failingRow = await recordJudgmentJobProviderFailure({
    jobId,
    message: 'HTTP error: 429 Retry-After: 120',
    modelId: 'model-1',
    now: failedAt,
  })

  expect(toJudgmentJobProviderHealthApi(failingRow)).toEqual({
    consecutiveFailureCount: 1,
    failureCode: null,
    failureKind: 'rate_limited',
    failureMessage: 'HTTP error: 429 Retry-After: 120',
    firstFailedAt: '2026-10-03T19:00:00.000Z',
    isActive: true,
    jobId,
    lastFailedAt: '2026-10-03T19:00:00.000Z',
    lastSuccessAt: null,
    modelId: 'model-1',
    recoveredAt: null,
    retryAfterAt: '2026-10-03T19:02:00.000Z',
    status: 'failing',
    totalFailureCount: 1,
    updatedAt: '2026-10-03T19:00:00.000Z',
  })

  await recordJudgmentJobProviderSuccess({jobId, now: recoveredAt})

  const recoveredRow = await getService().getJudgmentJobProviderHealth(jobId)

  expect(recoveredRow && toJudgmentJobProviderHealthApi(recoveredRow)).toMatchObject({
    isActive: false,
    lastSuccessAt: '2026-10-03T21:34:00.000Z',
    recoveredAt: '2026-10-03T21:34:00.000Z',
    status: 'recovered',
  })
})

test.each<[JudgmentJobProviderHealthStatus, JudgmentJobProviderFailureKind, number, boolean]>([
  ['failing', 'usage_limit', 1, true],
  ['failing', 'rate_limited', 1, true],
  ['failing', 'auth', 1, true],
  ['failing', 'endpoint_unavailable', 1, true],
  ['failing', 'network', 1, true],
  ['failing', 'timeout', 1, true],
  ['failing', 'other', 1, false],
  ['failing', 'other', 2, false],
  ['failing', 'other', 3, true],
  ['failing', 'other', 4, true],
  ['recovered', 'usage_limit', 0, false],
  ['recovered', 'other', 5, false],
])(
  'isJudgmentJobProviderHealthActive is %s/%s after %i consecutive failures: %p',
  (status, failureKind, count, active) => {
    expect(getService().isJudgmentJobProviderHealthActive({consecutiveFailureCount: count, failureKind, status})).toBe(
      active,
    )
  },
)

test('toJudgmentJobProviderHealthApi keeps a kind-other failure inactive until the third consecutive failure', async () => {
  const {recordJudgmentJobProviderFailure, toJudgmentJobProviderHealthApi} = getService()
  const jobId = getJobId('api-other')
  const firstFailedAt = new Date('2026-10-03T10:00:00.000Z')

  const firstRow = await recordJudgmentJobProviderFailure({jobId, message: 'empty response', now: firstFailedAt})
  const secondRow = await recordJudgmentJobProviderFailure({
    jobId,
    message: 'empty response',
    now: new Date('2026-10-03T10:00:01.000Z'),
  })
  const thirdRow = await recordJudgmentJobProviderFailure({
    jobId,
    message: 'empty response',
    now: new Date('2026-10-03T10:00:02.000Z'),
  })

  expect(firstRow.failureKind).toBe('other')
  expect(toJudgmentJobProviderHealthApi(firstRow)).toMatchObject({isActive: false, status: 'failing'})
  expect(toJudgmentJobProviderHealthApi(secondRow)).toMatchObject({isActive: false, status: 'failing'})
  expect(toJudgmentJobProviderHealthApi(thirdRow)).toMatchObject({
    consecutiveFailureCount: 3,
    isActive: true,
    status: 'failing',
  })
})

test('getJudgmentJobProviderClaimGate leaves healthy jobs ungated without querying DuckDB after the first load', async () => {
  const {getJudgmentJobProviderClaimGate} = getService()
  const jobId = getJobId('gate-healthy')
  const querySpy = spyOn(getDatabase(), 'queryJson')

  try {
    expect(await getJudgmentJobProviderClaimGate(jobId)).toEqual({
      backoffUntil: null,
      claimsAllowed: true,
      maxClaims: null,
    })
    expect(await getJudgmentJobProviderClaimGate(jobId)).toEqual({
      backoffUntil: null,
      claimsAllowed: true,
      maxClaims: null,
    })
    expect(querySpy).toHaveBeenCalledTimes(1)
  } finally {
    querySpy.mockRestore()
  }
})

test('getJudgmentJobProviderClaimGate blocks claims inside the backoff window, allows one probe after it and lifts on success', async () => {
  const {getJudgmentJobProviderClaimGate, recordJudgmentJobProviderFailure, recordJudgmentJobProviderSuccess} =
    getService()
  const jobId = getJobId('gate-usage-limit')
  const firstFailedAt = getLocalDate(2026, 9, 3, 21, 0)
  const firstBackoffUntil = getLocalDate(2026, 9, 3, 21, 30)
  const secondFailedAt = getLocalDate(2026, 9, 3, 21, 31)
  const secondBackoffUntil = getLocalDate(2026, 9, 3, 21, 33)

  await recordJudgmentJobProviderFailure({jobId, message: liveCodexUsageLimitMessage, now: firstFailedAt})

  expect(await getJudgmentJobProviderClaimGate(jobId, getLocalDate(2026, 9, 3, 21, 1))).toEqual({
    backoffUntil: firstBackoffUntil,
    claimsAllowed: false,
    maxClaims: 0,
  })
  expect(await getJudgmentJobProviderClaimGate(jobId, getLocalDate(2026, 9, 3, 21, 29, 59))).toEqual({
    backoffUntil: firstBackoffUntil,
    claimsAllowed: false,
    maxClaims: 0,
  })
  expect(await getJudgmentJobProviderClaimGate(jobId, firstBackoffUntil)).toEqual({
    backoffUntil: firstBackoffUntil,
    claimsAllowed: true,
    maxClaims: 1,
  })

  await recordJudgmentJobProviderFailure({jobId, message: liveCodexUsageLimitMessage, now: secondFailedAt})

  expect(await getJudgmentJobProviderClaimGate(jobId, getLocalDate(2026, 9, 3, 21, 32, 59))).toEqual({
    backoffUntil: secondBackoffUntil,
    claimsAllowed: false,
    maxClaims: 0,
  })
  expect(await getJudgmentJobProviderClaimGate(jobId, secondBackoffUntil)).toEqual({
    backoffUntil: secondBackoffUntil,
    claimsAllowed: true,
    maxClaims: 1,
  })

  await recordJudgmentJobProviderSuccess({jobId, now: getLocalDate(2026, 9, 3, 21, 34)})

  expect(await getJudgmentJobProviderClaimGate(jobId, getLocalDate(2026, 9, 3, 21, 34))).toEqual({
    backoffUntil: null,
    claimsAllowed: true,
    maxClaims: null,
  })
})

test('getJudgmentJobProviderClaimGate lazily loads a failing row written before the cache reset', async () => {
  const {getJudgmentJobProviderClaimGate, recordJudgmentJobProviderSuccess} = getService()
  const jobId = getJobId('gate-lazy-load')

  await getDatabase().run(`
    INSERT INTO app.judgment_job_provider_health (
      job_id, model_id, status, failure_kind, failure_code, failure_message, retry_after_at,
      first_failed_at, last_failed_at, consecutive_failure_count, total_failure_count
    ) VALUES (
      '${jobId}', 'model-1', 'failing', 'network', NULL, 'fetch failed', NULL,
      TIMESTAMPTZ '2026-10-03T09:00:00Z', TIMESTAMPTZ '2026-10-03T10:00:00Z', 2, 2
    )
  `)
  getService().resetJudgmentJobProviderHealthCacheForTests()

  expect(await getJudgmentJobProviderClaimGate(jobId, new Date('2026-10-03T10:00:30.000Z'))).toEqual({
    backoffUntil: new Date('2026-10-03T10:01:00.000Z'),
    claimsAllowed: false,
    maxClaims: 0,
  })
  expect(await getJudgmentJobProviderClaimGate(jobId, new Date('2026-10-03T10:01:00.000Z'))).toEqual({
    backoffUntil: new Date('2026-10-03T10:01:00.000Z'),
    claimsAllowed: true,
    maxClaims: 1,
  })

  await recordJudgmentJobProviderSuccess({jobId, now: new Date('2026-10-03T10:01:05.000Z')})

  expect(await getJudgmentJobProviderClaimGate(jobId, new Date('2026-10-03T10:01:06.000Z'))).toEqual({
    backoffUntil: null,
    claimsAllowed: true,
    maxClaims: null,
  })
})

test('getJudgmentJobProviderClaimGate does not gate kind-other failures until the third consecutive failure', async () => {
  const {getJudgmentJobProviderClaimGate, recordJudgmentJobProviderFailure} = getService()
  const jobId = getJobId('gate-other')

  await recordJudgmentJobProviderFailure({jobId, message: 'empty response', now: new Date('2026-10-03T10:00:00.000Z')})

  expect(await getJudgmentJobProviderClaimGate(jobId, new Date('2026-10-03T10:00:01.000Z'))).toEqual({
    backoffUntil: null,
    claimsAllowed: true,
    maxClaims: null,
  })

  await recordJudgmentJobProviderFailure({jobId, message: 'empty response', now: new Date('2026-10-03T10:00:02.000Z')})

  expect(await getJudgmentJobProviderClaimGate(jobId, new Date('2026-10-03T10:00:03.000Z'))).toEqual({
    backoffUntil: null,
    claimsAllowed: true,
    maxClaims: null,
  })

  await recordJudgmentJobProviderFailure({jobId, message: 'empty response', now: new Date('2026-10-03T10:00:04.000Z')})

  expect(await getJudgmentJobProviderClaimGate(jobId, new Date('2026-10-03T10:00:05.000Z'))).toEqual({
    backoffUntil: new Date('2026-10-03T10:00:19.000Z'),
    claimsAllowed: false,
    maxClaims: 0,
  })
})

test('markJudgmentJobProviderProbeClaimed blocks further claims while the probe is outstanding for up to 15 minutes', async () => {
  const {getJudgmentJobProviderClaimGate, markJudgmentJobProviderProbeClaimed, recordJudgmentJobProviderFailure} =
    getService()
  const jobId = getJobId('probe-outstanding')
  const backoffUntil = new Date('2026-10-03T10:00:30.000Z')

  await recordJudgmentJobProviderFailure({jobId, message: 'fetch failed', now: new Date('2026-10-03T10:00:00.000Z')})

  expect(await getJudgmentJobProviderClaimGate(jobId, backoffUntil)).toEqual({
    backoffUntil,
    claimsAllowed: true,
    maxClaims: 1,
  })

  markJudgmentJobProviderProbeClaimed(jobId, new Date('2026-10-03T10:00:31.000Z'))

  expect(await getJudgmentJobProviderClaimGate(jobId, new Date('2026-10-03T10:00:32.000Z'))).toEqual({
    backoffUntil,
    claimsAllowed: false,
    maxClaims: 0,
  })
  expect(await getJudgmentJobProviderClaimGate(jobId, new Date('2026-10-03T10:15:30.999Z'))).toEqual({
    backoffUntil,
    claimsAllowed: false,
    maxClaims: 0,
  })
  expect(await getJudgmentJobProviderClaimGate(jobId, new Date('2026-10-03T10:15:31.000Z'))).toEqual({
    backoffUntil,
    claimsAllowed: true,
    maxClaims: 1,
  })
})

test('a failure after the probe claim starts a new window and clears the probe marker', async () => {
  const {getJudgmentJobProviderClaimGate, markJudgmentJobProviderProbeClaimed, recordJudgmentJobProviderFailure} =
    getService()
  const jobId = getJobId('probe-failed')
  const secondBackoffUntil = new Date('2026-10-03T10:01:40.000Z')

  await recordJudgmentJobProviderFailure({jobId, message: 'fetch failed', now: new Date('2026-10-03T10:00:00.000Z')})
  markJudgmentJobProviderProbeClaimed(jobId, new Date('2026-10-03T10:00:31.000Z'))
  await recordJudgmentJobProviderFailure({jobId, message: 'fetch failed', now: new Date('2026-10-03T10:00:40.000Z')})

  expect(await getJudgmentJobProviderClaimGate(jobId, new Date('2026-10-03T10:00:41.000Z'))).toEqual({
    backoffUntil: secondBackoffUntil,
    claimsAllowed: false,
    maxClaims: 0,
  })
  expect(await getJudgmentJobProviderClaimGate(jobId, secondBackoffUntil)).toEqual({
    backoffUntil: secondBackoffUntil,
    claimsAllowed: true,
    maxClaims: 1,
  })
})

test('a success after the probe claim lifts the gate and marking a healthy job is a no-op', async () => {
  const {
    getJudgmentJobProviderClaimGate,
    markJudgmentJobProviderProbeClaimed,
    recordJudgmentJobProviderFailure,
    recordJudgmentJobProviderSuccess,
  } = getService()
  const jobId = getJobId('probe-succeeded')
  const healthyJobId = getJobId('probe-healthy')

  await recordJudgmentJobProviderFailure({jobId, message: 'fetch failed', now: new Date('2026-10-03T10:00:00.000Z')})
  markJudgmentJobProviderProbeClaimed(jobId, new Date('2026-10-03T10:00:31.000Z'))
  await recordJudgmentJobProviderSuccess({jobId, now: new Date('2026-10-03T10:00:35.000Z')})
  markJudgmentJobProviderProbeClaimed(healthyJobId, new Date('2026-10-03T10:00:36.000Z'))

  expect(await getJudgmentJobProviderClaimGate(jobId, new Date('2026-10-03T10:00:36.000Z'))).toEqual({
    backoffUntil: null,
    claimsAllowed: true,
    maxClaims: null,
  })
  expect(await getJudgmentJobProviderClaimGate(healthyJobId, new Date('2026-10-03T10:00:36.000Z'))).toEqual({
    backoffUntil: null,
    claimsAllowed: true,
    maxClaims: null,
  })
})
