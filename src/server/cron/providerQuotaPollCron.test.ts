import {beforeAll, beforeEach, describe, expect, test} from 'bun:test'

import type {ProviderQuotaFetchResult} from '../providers/quota/claudeCodeUsageQuota.ts'
import type {ProviderQuotaReadingInsert} from '../services/providerQuotaReadingService.ts'
import {
  getCodexQuotaFailureResult,
  getProviderQuotaPollStateForTests,
  type PolledProviderQuotaKind,
  type ProviderQuotaPollConnection,
  providerQuotaPollConnectionsSql,
  providerQuotaPollCron,
  type ProviderQuotaPollDeps,
  type ProviderQuotaPollWakeResult,
  resetProviderQuotaPollStateForTests,
  runProviderQuotaPollWake,
} from './providerQuotaPollCron.ts'

const startMs = Date.parse('2026-11-06T12:00:00.000Z')

const claudeUsageBody = {
  five_hour: null,
  limits: [
    {
      group: 'weekly',
      is_active: true,
      kind: 'weekly_all',
      percent: 34,
      resets_at: '2026-11-13T20:00:00+00:00',
      scope: null,
      severity: 'normal',
    },
  ],
  seven_day: {resets_at: '2026-11-13T20:00:00+00:00', utilization: 34},
  seven_day_breakdown: null,
}

const codexRateLimitsBody = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    planType: 'pro',
    primary: {resetsAt: 1_762_444_800, usedPercent: 42, windowDurationMins: 300},
    rateLimitReachedType: null,
    secondary: {resetsAt: 1_762_963_200, usedPercent: 7, windowDurationMins: 10_080},
  },
  rateLimitsByLimitId: null,
}

type Harness = {
  connections: ProviderQuotaPollConnection[]
  fetchCalls: PolledProviderQuotaKind[]
  fetchResults: Record<PolledProviderQuotaKind, ProviderQuotaFetchResult>
  insertCalls: ProviderQuotaReadingInsert[][]
  nowMs: number
  readConnectionsCount: number
  shouldRun: boolean
}

const createHarness = (connections: ProviderQuotaPollConnection[]): Harness => {
  return {
    connections,
    fetchCalls: [],
    fetchResults: {'claude-code': {body: claudeUsageBody, kind: 'ok'}, codex: {body: codexRateLimitsBody, kind: 'ok'}},
    insertCalls: [],
    nowMs: startMs,
    readConnectionsCount: 0,
    shouldRun: true,
  }
}

const createFetchQuota = (harness: Harness, kind: PolledProviderQuotaKind) => {
  return async (): Promise<ProviderQuotaFetchResult> => {
    harness.fetchCalls.push(kind)
    return harness.fetchResults[kind]
  }
}

const createDeps = (harness: Harness): ProviderQuotaPollDeps => {
  return {
    fetchQuota: {'claude-code': createFetchQuota(harness, 'claude-code'), codex: createFetchQuota(harness, 'codex')},
    insertReadings: async (readings) => {
      harness.insertCalls.push(readings)
      return readings.length
    },
    now: () => {
      return harness.nowMs
    },
    readConnections: async () => {
      harness.readConnectionsCount += 1
      return harness.connections
    },
    shouldRun: () => {
      return harness.shouldRun
    },
  }
}

const wakeAt = async (harness: Harness, offsetMs: number) => {
  harness.nowMs = startMs + offsetMs
  return runProviderQuotaPollWake(createDeps(harness))
}

const claudeConnection = (hasRunningJob: boolean, providerConnectionId = 'connection-claude') => {
  return {hasRunningJob, providerConnectionId, providerKind: 'claude-code' as const}
}

const codexConnection = (hasRunningJob: boolean, providerConnectionId = 'connection-codex') => {
  return {hasRunningJob, providerConnectionId, providerKind: 'codex' as const}
}

const notDue: ProviderQuotaPollWakeResult = {reason: 'not-due', status: 'skipped'}
const noConnectionDue: ProviderQuotaPollWakeResult = {reason: 'no-connection-due', status: 'skipped'}

beforeAll(() => {
  providerQuotaPollCron.store.cron['provider-quota-poll'].stop()
})

beforeEach(() => {
  resetProviderQuotaPollStateForTests()
})

describe('runProviderQuotaPollWake', () => {
  test('skips on a server without the maintenance role without reading connections', async () => {
    const harness = createHarness([claudeConnection(true)])
    harness.shouldRun = false

    expect(await wakeAt(harness, 0)).toEqual({reason: 'maintenance-role', status: 'skipped'})
    expect(harness.readConnectionsCount).toBe(0)
    expect(harness.fetchCalls).toEqual([])
    expect(harness.insertCalls).toEqual([])
  })

  test('polls a claude-code connection with a running job and inserts its readings in one call', async () => {
    const harness = createHarness([claudeConnection(true)])

    expect(await wakeAt(harness, 0)).toEqual({inserted: 2, outcomes: {'claude-code': 'ok'}, status: 'ran'})
    expect(harness.readConnectionsCount).toBe(1)
    expect(harness.fetchCalls).toEqual(['claude-code'])
    expect(harness.insertCalls).toHaveLength(1)
    expect(
      harness.insertCalls[0]?.map((reading) => {
        return [reading.providerConnectionId, reading.providerKind, reading.limitKind, reading.utilizationPercent]
      }),
    ).toEqual([
      ['connection-claude', 'claude-code', 'seven_day', 34],
      ['connection-claude', 'claude-code', 'weekly_all', 34],
    ])
    expect(getProviderQuotaPollStateForTests('claude-code')).toEqual({
      backoffMs: 0,
      lastAttemptAtMs: startMs,
      lastOutcome: 'ok',
      retryAfterUntilMs: null,
    })
  })

  test('skips a wake 30 s later as not due without reading connections', async () => {
    const harness = createHarness([claudeConnection(true)])

    await wakeAt(harness, 0)

    expect(await wakeAt(harness, 30_000)).toEqual(notDue)
    expect(await wakeAt(harness, 59_999)).toEqual(notDue)
    expect(harness.readConnectionsCount).toBe(1)
    expect(harness.fetchCalls).toEqual(['claude-code'])
  })

  test('polls again exactly 60 s later while a job is running', async () => {
    const harness = createHarness([claudeConnection(true)])

    await wakeAt(harness, 0)

    expect(await wakeAt(harness, 60_000)).toEqual({inserted: 2, outcomes: {'claude-code': 'ok'}, status: 'ran'})
    expect(harness.fetchCalls).toEqual(['claude-code', 'claude-code'])
    expect(harness.insertCalls).toHaveLength(2)
  })

  test('waits 600 s for the next poll without a running job', async () => {
    const harness = createHarness([claudeConnection(false)])

    await wakeAt(harness, 0)

    expect(await wakeAt(harness, 60_000)).toEqual(noConnectionDue)
    expect(await wakeAt(harness, 599_999)).toEqual(noConnectionDue)
    expect(harness.fetchCalls).toEqual(['claude-code'])
    expect(await wakeAt(harness, 600_000)).toEqual({inserted: 2, outcomes: {'claude-code': 'ok'}, status: 'ran'})
    expect(harness.fetchCalls).toEqual(['claude-code', 'claude-code'])
  })

  test('polls 60 s after ok once a job starts running', async () => {
    const harness = createHarness([claudeConnection(false)])

    await wakeAt(harness, 0)
    harness.connections = [claudeConnection(true)]

    expect(await wakeAt(harness, 60_000)).toEqual({inserted: 2, outcomes: {'claude-code': 'ok'}, status: 'ran'})
  })

  test('backs off 120 s and then 240 s after transient 429 responses', async () => {
    const harness = createHarness([claudeConnection(true)])
    harness.fetchResults['claude-code'] = {kind: 'transient', reason: 'usage endpoint returned 429', retryAfterMs: null}

    expect(await wakeAt(harness, 0)).toEqual({inserted: 0, outcomes: {'claude-code': 'transient'}, status: 'ran'})
    expect(await wakeAt(harness, 60_000)).toEqual(noConnectionDue)
    expect(await wakeAt(harness, 119_999)).toEqual(notDue)
    expect(await wakeAt(harness, 120_000)).toEqual({inserted: 0, outcomes: {'claude-code': 'transient'}, status: 'ran'})
    expect(getProviderQuotaPollStateForTests('claude-code').backoffMs).toBe(240_000)
    expect(await wakeAt(harness, 359_999)).toEqual(noConnectionDue)
    expect(await wakeAt(harness, 360_000)).toEqual({inserted: 0, outcomes: {'claude-code': 'transient'}, status: 'ran'})
    expect(harness.fetchCalls).toEqual(['claude-code', 'claude-code', 'claude-code'])
  })

  test('waits for a retry-after longer than the back-off', async () => {
    const harness = createHarness([claudeConnection(true)])
    harness.fetchResults['claude-code'] = {
      kind: 'transient',
      reason: 'usage endpoint returned 429',
      retryAfterMs: 300_000,
    }

    await wakeAt(harness, 0)

    expect(await wakeAt(harness, 299_999)).toEqual(noConnectionDue)
    expect(harness.fetchCalls).toEqual(['claude-code'])

    harness.fetchResults['claude-code'] = {body: claudeUsageBody, kind: 'ok'}

    expect(await wakeAt(harness, 300_000)).toEqual({inserted: 2, outcomes: {'claude-code': 'ok'}, status: 'ran'})
    expect(getProviderQuotaPollStateForTests('claude-code')).toEqual({
      backoffMs: 0,
      lastAttemptAtMs: startMs + 300_000,
      lastOutcome: 'ok',
      retryAfterUntilMs: null,
    })
  })

  test('inserts no readings after an auth failure and retries only after 600 s', async () => {
    const harness = createHarness([claudeConnection(true)])
    harness.fetchResults['claude-code'] = {kind: 'auth', reason: 'usage endpoint returned 401'}

    expect(await wakeAt(harness, 0)).toEqual({inserted: 0, outcomes: {'claude-code': 'auth'}, status: 'ran'})
    expect(
      harness.insertCalls.flatMap((readings) => {
        return readings
      }),
    ).toEqual([])
    expect(await wakeAt(harness, 60_000)).toEqual(noConnectionDue)
    expect(await wakeAt(harness, 599_999)).toEqual(noConnectionDue)
    expect(harness.fetchCalls).toEqual(['claude-code'])
    expect(await wakeAt(harness, 600_000)).toEqual({inserted: 0, outcomes: {'claude-code': 'auth'}, status: 'ran'})
    expect(harness.fetchCalls).toEqual(['claude-code', 'claude-code'])
  })

  test('fetches claude-code and codex in the same wake and inserts all rows in one call', async () => {
    const harness = createHarness([claudeConnection(true), codexConnection(true)])

    expect(await wakeAt(harness, 0)).toEqual({inserted: 4, outcomes: {'claude-code': 'ok', codex: 'ok'}, status: 'ran'})
    expect([...harness.fetchCalls].sort()).toEqual(['claude-code', 'codex'])
    expect(harness.insertCalls).toHaveLength(1)
    expect(
      harness.insertCalls[0]?.map((reading) => {
        return `${reading.providerKind}/${reading.limitKind}`
      }),
    ).toEqual(['claude-code/seven_day', 'claude-code/weekly_all', 'codex/codex:primary', 'codex/codex:secondary'])
  })

  test('never fetches a kind without an enabled connection', async () => {
    const harness = createHarness([codexConnection(true)])

    expect(await wakeAt(harness, 0)).toEqual({inserted: 2, outcomes: {codex: 'ok'}, status: 'ran'})
    expect(await wakeAt(harness, 60_000)).toEqual({inserted: 2, outcomes: {codex: 'ok'}, status: 'ran'})
    expect(await wakeAt(harness, 660_000)).toEqual({inserted: 2, outcomes: {codex: 'ok'}, status: 'ran'})
    expect(harness.fetchCalls).toEqual(['codex', 'codex', 'codex'])
  })

  test('reads connections again only every 600 s when no connection is enabled', async () => {
    const harness = createHarness([])

    expect(await wakeAt(harness, 0)).toEqual(noConnectionDue)
    expect(await wakeAt(harness, 20_000)).toEqual(notDue)
    expect(await wakeAt(harness, 599_999)).toEqual(notDue)
    expect(harness.readConnectionsCount).toBe(1)
    expect(await wakeAt(harness, 600_000)).toEqual(noConnectionDue)
    expect(harness.readConnectionsCount).toBe(2)
    expect(harness.fetchCalls).toEqual([])
  })

  test('polls a newly enabled kind at the next connections read', async () => {
    const harness = createHarness([claudeConnection(true)])

    await wakeAt(harness, 0)
    harness.connections = [claudeConnection(true), codexConnection(false)]

    expect(await wakeAt(harness, 60_000)).toEqual({
      inserted: 4,
      outcomes: {'claude-code': 'ok', codex: 'ok'},
      status: 'ran',
    })
  })

  test('parses one response into rows for every connection of the kind with one observedAt', async () => {
    const harness = createHarness([claudeConnection(true, 'connection-a'), claudeConnection(false, 'connection-b')])

    expect(await wakeAt(harness, 0)).toEqual({inserted: 4, outcomes: {'claude-code': 'ok'}, status: 'ran'})
    expect(harness.fetchCalls).toEqual(['claude-code'])
    expect(
      harness.insertCalls[0]?.map((reading) => {
        return `${reading.providerConnectionId}/${reading.limitKind}`
      }),
    ).toEqual([
      'connection-a/seven_day',
      'connection-a/weekly_all',
      'connection-b/seven_day',
      'connection-b/weekly_all',
    ])
    expect(
      harness.insertCalls[0]?.map((reading) => {
        return reading.observedAt.getTime()
      }),
    ).toEqual([startMs, startMs, startMs, startMs])
  })

  test('records unreadable when a 200 response has no readable limits', async () => {
    const harness = createHarness([claudeConnection(true)])
    harness.fetchResults['claude-code'] = {body: {five_hour: null, limits: [], seven_day: null}, kind: 'ok'}

    expect(await wakeAt(harness, 0)).toEqual({inserted: 0, outcomes: {'claude-code': 'unreadable'}, status: 'ran'})
    expect(getProviderQuotaPollStateForTests('claude-code').lastOutcome).toBe('unreadable')
    expect(await wakeAt(harness, 60_000)).toEqual(noConnectionDue)
    expect(harness.fetchCalls).toEqual(['claude-code'])
  })

  test('reads connections at most once a minute while a polled connection exists, to notice a job start', async () => {
    const harness = createHarness([claudeConnection(false)])

    expect(await wakeAt(harness, 0)).toEqual({inserted: 2, outcomes: {'claude-code': 'ok'}, status: 'ran'})
    expect(await wakeAt(harness, 20_000)).toEqual(notDue)
    expect(await wakeAt(harness, 40_000)).toEqual(notDue)
    expect(harness.readConnectionsCount).toBe(1)
    expect(await wakeAt(harness, 60_000)).toEqual(noConnectionDue)
    expect(await wakeAt(harness, 80_000)).toEqual(notDue)
    expect(harness.readConnectionsCount).toBe(2)

    harness.connections = [claudeConnection(true)]

    expect(await wakeAt(harness, 120_000)).toEqual({inserted: 2, outcomes: {'claude-code': 'ok'}, status: 'ran'})
    expect(harness.readConnectionsCount).toBe(3)
    expect(harness.fetchCalls).toEqual(['claude-code', 'claude-code'])
  })
})

describe('getCodexQuotaFailureResult', () => {
  test('classifies login failures as auth', () => {
    expect(getCodexQuotaFailureResult(new Error('codex app-server: request failed with 401'))).toEqual({
      kind: 'auth',
      reason: 'codex app-server: request failed with 401',
    })
    expect(getCodexQuotaFailureResult(new Error('Unauthorized'))).toEqual({kind: 'auth', reason: 'Unauthorized'})
    expect(getCodexQuotaFailureResult('codex: not logged in')).toEqual({kind: 'auth', reason: 'codex: not logged in'})
  })

  test('classifies other failures as transient without retry-after', () => {
    expect(getCodexQuotaFailureResult(new Error('account/rateLimits/read timeout after 15000ms'))).toEqual({
      kind: 'transient',
      reason: 'account/rateLimits/read timeout after 15000ms',
      retryAfterMs: null,
    })
    expect(getCodexQuotaFailureResult(new Error('status 4010 from proxy')).kind).toBe('transient')
  })
})

describe('providerQuotaPollConnectionsSql', () => {
  test('reads enabled connections with running jobs and has no SQL line comments', () => {
    expect(providerQuotaPollConnectionsSql).toContain('pc.enabled = TRUE')
    expect(providerQuotaPollConnectionsSql).toContain("jj.status = 'running'")
    expect(providerQuotaPollConnectionsSql).not.toContain('--')
  })
})
