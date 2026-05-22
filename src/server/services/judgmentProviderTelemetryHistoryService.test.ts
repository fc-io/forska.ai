import {afterAll, beforeAll, expect, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {
  deleteJudgmentProviderTelemetryHistoryForJob,
  getJudgmentProviderTelemetryAlignedRange,
  getJudgmentProviderTelemetryBottleneckSummary,
  getJudgmentProviderTelemetryBucketAdherenceState,
  getJudgmentProviderTelemetryHistoryBuckets,
  getJudgmentProviderTelemetrySampleAdherenceState,
  getJudgmentProviderTelemetryUtilization,
  insertJudgmentProviderTelemetryHistorySample,
  insertJudgmentProviderTelemetryHistorySamples,
  type JudgmentProviderTelemetryBucketedHistory,
  type JudgmentProviderTelemetryHistoryRange,
  type JudgmentProviderTelemetryHistorySample,
  type JudgmentProviderTelemetryHistorySampleInsert,
  pruneJudgmentProviderTelemetryHistorySamples,
  queryJudgmentProviderTelemetryBucketedHistory,
} from './judgmentProviderTelemetryHistoryService.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-provider-telemetry-history-service')
const tempDbPath = tempRuntimeRoot.duckdbPath

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempDbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('./appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = (statement) => {
    return database.queryJson(statement)
  }
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

const getSample = (
  values: Partial<JudgmentProviderTelemetryHistorySample> & {sampledAt: string},
): JudgmentProviderTelemetryHistorySample => {
  return {
    bottleneck: null,
    bottleneckSource: null,
    bottleneckSubreason: null,
    normalRequestCapacity: 10,
    providerLeasedLiveRequests: 5,
    providerLeasedPhysicalCalls: 5,
    providerLimit: 12,
    providerRequestFillPct: null,
    ...values,
    sampledAt: new Date(values.sampledAt),
  }
}

const getInsertSample = (
  values: Omit<Partial<JudgmentProviderTelemetryHistorySampleInsert>, 'sampledAt'> & {jobId: string; sampledAt: string},
): JudgmentProviderTelemetryHistorySampleInsert => {
  return {
    aggregateCompleteness: 'complete',
    bottleneck: null,
    bottleneckSource: null,
    bottleneckSubreason: null,
    effectiveProviderLimit: 12,
    freshWorkerCount: 1,
    normalRequestCapacity: 10,
    projectId: `${values.jobId}-project`,
    providerAllocationVersion: 'allocation-v1',
    providerAvailableRequestLeases: 5,
    providerKey: 'provider-a',
    providerLeasedLiveRequests: 5,
    providerLeasedPhysicalCalls: 5,
    providerLeasedProbeCalls: 0,
    providerLimit: 12,
    providerLimitVersion: 'limit-v1',
    providerProbeOccupancyVersion: 'probe-v1',
    providerRequestFillPct: null,
    staleWorkerCount: 0,
    targetRequestLiveCalls: 10,
    unavailableWorkerCount: 0,
    unallocatedTargetLiveCalls: 0,
    ...values,
    sampledAt: new Date(values.sampledAt),
  }
}

const getTestQueryDatabase = () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  return queryDatabase
}

const getIsoString = (value: unknown) => {
  const date = value instanceof Date ? value : new Date(String(value))

  return date.toISOString()
}

const getBucket = (history: JudgmentProviderTelemetryBucketedHistory, index: number) => {
  const bucket = history.buckets[index]

  if (!bucket) {
    throw new Error(`Missing telemetry history bucket ${index}`)
  }

  return bucket
}

test('range presets floor range end to bucket size and return complete windows', () => {
  const now = new Date('2026-05-12T15:17:44.123Z')
  const cases: Array<{
    bucketSizeSeconds: number
    bucketCount: number
    range: JudgmentProviderTelemetryHistoryRange
    rangeEnd: string
    rangeStart: string
  }> = [
    {
      bucketCount: 10,
      bucketSizeSeconds: 30,
      range: '5m',
      rangeEnd: '2026-05-12T15:17:30.000Z',
      rangeStart: '2026-05-12T15:12:30.000Z',
    },
    {
      bucketCount: 30,
      bucketSizeSeconds: 30,
      range: '15m',
      rangeEnd: '2026-05-12T15:17:30.000Z',
      rangeStart: '2026-05-12T15:02:30.000Z',
    },
    {
      bucketCount: 60,
      bucketSizeSeconds: 60,
      range: '1h',
      rangeEnd: '2026-05-12T15:17:00.000Z',
      rangeStart: '2026-05-12T14:17:00.000Z',
    },
    {
      bucketCount: 96,
      bucketSizeSeconds: 900,
      range: '24h',
      rangeEnd: '2026-05-12T15:15:00.000Z',
      rangeStart: '2026-05-11T15:15:00.000Z',
    },
    {
      bucketCount: 72,
      bucketSizeSeconds: 3600,
      range: '3d',
      rangeEnd: '2026-05-12T15:00:00.000Z',
      rangeStart: '2026-05-09T15:00:00.000Z',
    },
  ]

  cases.map((entry) => {
    const range = getJudgmentProviderTelemetryAlignedRange({now, range: entry.range})
    const buckets = getJudgmentProviderTelemetryHistoryBuckets({range, samples: []})

    expect(range.bucketSizeSeconds).toBe(entry.bucketSizeSeconds)
    expect(range.rangeEnd.toISOString()).toBe(entry.rangeEnd)
    expect(range.rangeStart.toISOString()).toBe(entry.rangeStart)
    expect(buckets).toHaveLength(entry.bucketCount)
    expect(buckets[0]?.bucketStart.toISOString()).toBe(entry.rangeStart)
    expect(buckets.at(-1)?.bucketEnd.toISOString()).toBe(entry.rangeEnd)
  })
})

test('utilization prefers stored fill percentage and recomputes from live leases when missing', () => {
  expect(
    getJudgmentProviderTelemetryUtilization({
      normalRequestCapacity: 10,
      providerLeasedLiveRequests: 2,
      providerRequestFillPct: 87,
    }),
  ).toBe(87)
  expect(
    getJudgmentProviderTelemetryUtilization({
      normalRequestCapacity: 0,
      providerLeasedLiveRequests: 8,
      providerRequestFillPct: 87,
    }),
  ).toBeNull()
  expect(
    getJudgmentProviderTelemetryUtilization({
      normalRequestCapacity: 4,
      providerLeasedLiveRequests: 5,
      providerRequestFillPct: null,
    }),
  ).toBe(125)
  expect(
    getJudgmentProviderTelemetryUtilization({
      normalRequestCapacity: 3,
      providerLeasedLiveRequests: 1,
      providerRequestFillPct: null,
    }),
  ).toBeCloseTo(100 / 3)
})

test('sample adherence derives over limit, at limit, and within limit states', () => {
  expect(
    getJudgmentProviderTelemetrySampleAdherenceState({
      normalRequestCapacity: 5,
      providerLeasedLiveRequests: 6,
      providerLeasedPhysicalCalls: 5,
      providerLimit: 10,
    }),
  ).toBe('overLimit')
  expect(
    getJudgmentProviderTelemetrySampleAdherenceState({
      normalRequestCapacity: 5,
      providerLeasedLiveRequests: 4,
      providerLeasedPhysicalCalls: 11,
      providerLimit: 10,
    }),
  ).toBe('overLimit')
  expect(
    getJudgmentProviderTelemetrySampleAdherenceState({
      normalRequestCapacity: 5,
      providerLeasedLiveRequests: 5,
      providerLeasedPhysicalCalls: 4,
      providerLimit: 10,
    }),
  ).toBe('atLimit')
  expect(
    getJudgmentProviderTelemetrySampleAdherenceState({
      normalRequestCapacity: 5,
      providerLeasedLiveRequests: 4,
      providerLeasedPhysicalCalls: 10,
      providerLimit: 10,
    }),
  ).toBe('atLimit')
  expect(
    getJudgmentProviderTelemetrySampleAdherenceState({
      normalRequestCapacity: 5,
      providerLeasedLiveRequests: 4,
      providerLeasedPhysicalCalls: 9,
      providerLimit: 10,
    }),
  ).toBe('withinLimit')
})

test('bucket adherence uses worst-state precedence and empty buckets are unknown', () => {
  expect(getJudgmentProviderTelemetryBucketAdherenceState([])).toBe('unknown')
  expect(
    getJudgmentProviderTelemetryBucketAdherenceState([
      getSample({providerLeasedLiveRequests: 4, sampledAt: '2026-05-12T15:12:31.000Z'}),
      getSample({providerLeasedLiveRequests: 10, sampledAt: '2026-05-12T15:12:32.000Z'}),
      getSample({providerLeasedLiveRequests: 11, sampledAt: '2026-05-12T15:12:33.000Z'}),
    ]),
  ).toBe('overLimit')
  expect(
    getJudgmentProviderTelemetryBucketAdherenceState([
      getSample({providerLeasedLiveRequests: 4, sampledAt: '2026-05-12T15:12:31.000Z'}),
      getSample({providerLeasedLiveRequests: 10, sampledAt: '2026-05-12T15:12:32.000Z'}),
    ]),
  ).toBe('atLimit')
  expect(
    getJudgmentProviderTelemetryBucketAdherenceState([
      getSample({providerLeasedLiveRequests: 4, sampledAt: '2026-05-12T15:12:31.000Z'}),
    ]),
  ).toBe('withinLimit')
})

test('bucket aggregation fills aligned empty buckets and ignores null utilization values', () => {
  const range = getJudgmentProviderTelemetryAlignedRange({now: new Date('2026-05-12T15:17:44.123Z'), range: '5m'})
  const buckets = getJudgmentProviderTelemetryHistoryBuckets({
    range,
    samples: [
      getSample({
        bottleneck: null,
        normalRequestCapacity: 10,
        providerLeasedLiveRequests: 5,
        sampledAt: '2026-05-12T15:12:31.000Z',
      }),
      getSample({
        bottleneck: 'providerAtTarget',
        bottleneckSource: 'provider.providerLeasedLiveRequests',
        bottleneckSubreason: 'providerTargetReached',
        normalRequestCapacity: 10,
        providerLeasedLiveRequests: 10,
        providerRequestFillPct: 100,
        sampledAt: '2026-05-12T15:12:59.000Z',
      }),
      getSample({normalRequestCapacity: 0, providerLeasedLiveRequests: 0, sampledAt: '2026-05-12T15:13:01.000Z'}),
      getSample({normalRequestCapacity: 4, providerLeasedLiveRequests: 5, sampledAt: '2026-05-12T15:13:05.000Z'}),
      getSample({normalRequestCapacity: 10, providerLeasedLiveRequests: 5, sampledAt: '2026-05-12T15:17:30.000Z'}),
    ],
  })

  expect(buckets).toHaveLength(10)
  expect(buckets[0]).toMatchObject({
    adherenceState: 'atLimit',
    avgUtilization: 75,
    bottleneck: 'providerAtTarget',
    bottleneckSampleCount: 1,
    latestNormalRequestCapacity: 10,
    latestProviderLeasedLiveRequests: 10,
    latestProviderLeasedPhysicalCalls: 5,
    latestProviderLimit: 12,
    maxUtilization: 100,
    minUtilization: 50,
    sampleCount: 2,
  })
  expect(buckets[1]).toMatchObject({
    adherenceState: 'overLimit',
    avgUtilization: 125,
    latestNormalRequestCapacity: 4,
    latestProviderLeasedLiveRequests: 5,
    latestProviderLeasedPhysicalCalls: 5,
    latestProviderLimit: 12,
    maxUtilization: 125,
    minUtilization: 125,
    sampleCount: 2,
  })
  expect(buckets[2]).toMatchObject({
    adherenceState: 'unknown',
    avgUtilization: null,
    latestNormalRequestCapacity: null,
    latestProviderLeasedLiveRequests: null,
    latestProviderLeasedPhysicalCalls: null,
    latestProviderLimit: null,
    maxUtilization: null,
    minUtilization: null,
    sampleCount: 0,
  })
  expect(buckets.at(-1)?.bucketEnd.toISOString()).toBe('2026-05-12T15:17:30.000Z')
  expect(buckets.at(-1)?.sampleCount).toBe(0)
})

test('bottleneck summary uses highest count, latest tie-break, and latest selected details', () => {
  const countWinner = getJudgmentProviderTelemetryBottleneckSummary([
    getSample({
      bottleneck: 'providerAtTarget',
      bottleneckSource: 'old-provider-source',
      bottleneckSubreason: 'providerTargetReached',
      sampledAt: '2026-05-12T15:12:31.000Z',
    }),
    getSample({
      bottleneck: 'providerAtTarget',
      bottleneckSource: 'latest-provider-source',
      bottleneckSubreason: 'providerTargetReached',
      sampledAt: '2026-05-12T15:12:35.000Z',
    }),
    getSample({
      bottleneck: 'requestSlotWait',
      bottleneckSource: 'request.requestSlotWaiters.worker',
      bottleneckSubreason: 'waiterNotWoken',
      sampledAt: '2026-05-12T15:12:40.000Z',
    }),
  ])
  const latestTieWinner = getJudgmentProviderTelemetryBottleneckSummary([
    getSample({
      bottleneck: 'providerAtTarget',
      bottleneckSource: 'latest-provider-source',
      bottleneckSubreason: 'providerTargetReached',
      sampledAt: '2026-05-12T15:12:35.000Z',
    }),
    getSample({
      bottleneck: 'providerAtTarget',
      bottleneckSource: 'latest-provider-source-2',
      bottleneckSubreason: 'providerTargetReached',
      sampledAt: '2026-05-12T15:12:36.000Z',
    }),
    getSample({
      bottleneck: 'requestSlotWait',
      bottleneckSource: 'older-request-source',
      bottleneckSubreason: 'waiterNotWoken',
      sampledAt: '2026-05-12T15:12:34.000Z',
    }),
    getSample({
      bottleneck: 'requestSlotWait',
      bottleneckSource: 'latest-request-source',
      bottleneckSubreason: 'leaseAcquireContention',
      sampledAt: '2026-05-12T15:12:40.000Z',
    }),
  ])

  expect(countWinner).toEqual({
    bottleneck: 'providerAtTarget',
    bottleneckSampleCount: 2,
    bottleneckSource: 'latest-provider-source',
    bottleneckSubreason: 'providerTargetReached',
  })
  expect(latestTieWinner).toEqual({
    bottleneck: 'requestSlotWait',
    bottleneckSampleCount: 2,
    bottleneckSource: 'latest-request-source',
    bottleneckSubreason: 'leaseAcquireContention',
  })
})

test('inserting samples normalizes cadence slot and dedupes by job provider and sampled_at', async () => {
  const query = getTestQueryDatabase()
  const createdAt = new Date('2026-05-12T16:00:00.000Z')
  const jobId = `history-insert-${Date.now()}`
  const sample = getInsertSample({jobId, providerKey: 'provider-insert', sampledAt: '2026-05-12T15:12:44.999Z'})
  const duplicate = getInsertSample({
    jobId,
    providerKey: 'provider-insert',
    providerLeasedLiveRequests: 9,
    sampledAt: '2026-05-12T15:12:35.000Z',
  })
  const firstResult = await insertJudgmentProviderTelemetryHistorySample({createdAt, sample})
  const duplicateResult = await insertJudgmentProviderTelemetryHistorySample({
    createdAt: new Date('2026-05-12T16:05:00.000Z'),
    sample: duplicate,
  })
  const rows = await query<{createdAt: unknown; liveRequests: unknown; sampledAt: unknown}>(`
    SELECT
      created_at AS createdAt,
      provider_leased_live_requests AS liveRequests,
      sampled_at AS sampledAt
    FROM app.judgment_job_provider_telemetry_sample
    WHERE job_id = '${jobId}'
    ORDER BY sampled_at ASC
  `)

  expect(firstResult).toEqual({attempted: 1, inserted: 1, skipped: 0})
  expect(duplicateResult).toEqual({attempted: 1, inserted: 0, skipped: 1})
  expect(rows).toHaveLength(1)
  expect(getIsoString(rows[0]?.sampledAt)).toBe('2026-05-12T15:12:30.000Z')
  expect(getIsoString(rows[0]?.createdAt)).toBe('2026-05-12T16:00:00.000Z')
  expect(Number(rows[0]?.liveRequests ?? 0)).toBe(5)
})

test('pruning deletes samples older than the three day sampled_at retention cutoff', async () => {
  const query = getTestQueryDatabase()
  const jobId = `history-prune-${Date.now()}`

  await insertJudgmentProviderTelemetryHistorySamples({
    samples: [
      getInsertSample({jobId, providerKey: 'provider-prune', sampledAt: '2026-05-09T11:59:45.000Z'}),
      getInsertSample({jobId, providerKey: 'provider-prune', sampledAt: '2026-05-09T12:00:05.000Z'}),
    ],
  })

  const deletedCount = await pruneJudgmentProviderTelemetryHistorySamples({now: new Date('2026-05-12T12:00:00.000Z')})
  const rows = await query<{sampledAt: unknown}>(`
    SELECT sampled_at AS sampledAt
    FROM app.judgment_job_provider_telemetry_sample
    WHERE job_id = '${jobId}'
    ORDER BY sampled_at ASC
  `)

  expect(deletedCount).toBeGreaterThanOrEqual(1)
  expect(rows).toHaveLength(1)
  expect(getIsoString(rows[0]?.sampledAt)).toBe('2026-05-09T12:00:00.000Z')
})

test('deleting telemetry history for a job preserves other jobs', async () => {
  const query = getTestQueryDatabase()
  const jobId = `history-delete-${Date.now()}`
  const otherJobId = `history-delete-other-${Date.now()}`

  await insertJudgmentProviderTelemetryHistorySamples({
    samples: [
      getInsertSample({jobId, providerKey: 'provider-delete', sampledAt: '2026-05-12T15:00:05.000Z'}),
      getInsertSample({jobId, providerKey: 'provider-delete', sampledAt: '2026-05-12T15:00:35.000Z'}),
      getInsertSample({jobId: otherJobId, providerKey: 'provider-delete', sampledAt: '2026-05-12T15:00:05.000Z'}),
    ],
  })

  const deletedCount = await deleteJudgmentProviderTelemetryHistoryForJob({jobId})
  const rows = await query<{jobId: string; total: unknown}>(`
    SELECT job_id AS jobId, COUNT(*) AS total
    FROM app.judgment_job_provider_telemetry_sample
    WHERE job_id IN ('${jobId}', '${otherJobId}')
    GROUP BY job_id
    ORDER BY job_id ASC
  `)

  expect(deletedCount).toBe(2)
  expect(rows).toEqual([{jobId: otherJobId, total: '1'}])
})

test('bucketed history query returns aligned ordered buckets with utilization adherence and bottleneck summaries', async () => {
  const jobId = `history-query-${Date.now()}`
  const providerKey = `provider-query-${Date.now()}`

  await insertJudgmentProviderTelemetryHistorySamples({
    samples: [
      getInsertSample({
        bottleneck: 'providerAtTarget',
        bottleneckSource: 'provider.providerLeasedLiveRequests',
        bottleneckSubreason: 'providerTargetReached',
        jobId,
        providerKey,
        providerLeasedLiveRequests: 5,
        sampledAt: '2026-05-12T14:17:01.000Z',
      }),
      getInsertSample({
        bottleneck: 'requestSlotWait',
        bottleneckSource: 'request.requestSlotWaiters.worker',
        bottleneckSubreason: 'waiterNotWoken',
        jobId,
        providerKey,
        providerLeasedLiveRequests: 10,
        providerRequestFillPct: 100,
        sampledAt: '2026-05-12T14:17:31.000Z',
      }),
      getInsertSample({
        jobId,
        normalRequestCapacity: 0,
        providerKey,
        providerLeasedLiveRequests: 0,
        providerLeasedPhysicalCalls: 0,
        sampledAt: '2026-05-12T14:18:01.000Z',
      }),
      getInsertSample({
        jobId,
        normalRequestCapacity: 4,
        providerKey,
        providerLeasedLiveRequests: 5,
        sampledAt: '2026-05-12T14:18:31.000Z',
      }),
      getInsertSample({
        jobId,
        normalRequestCapacity: 0,
        providerKey,
        providerLeasedLiveRequests: 0,
        providerLeasedPhysicalCalls: 0,
        sampledAt: '2026-05-12T14:19:01.000Z',
      }),
      getInsertSample({jobId, providerKey, sampledAt: '2026-05-12T15:17:05.000Z'}),
    ],
  })

  const history = await queryJudgmentProviderTelemetryBucketedHistory({
    jobId,
    now: new Date('2026-05-12T15:17:44.123Z'),
    providerKey,
    range: '1h',
  })
  const firstBucket = getBucket(history, 0)
  const secondBucket = getBucket(history, 1)
  const thirdBucket = getBucket(history, 2)

  expect(history.providerKey).toBe(providerKey)
  expect(history.bucketSizeSeconds).toBe(60)
  expect(history.rangeStart.toISOString()).toBe('2026-05-12T14:17:00.000Z')
  expect(history.rangeEnd.toISOString()).toBe('2026-05-12T15:17:00.000Z')
  expect(history.buckets).toHaveLength(60)
  expect(firstBucket).toMatchObject({
    adherenceState: 'atLimit',
    avgUtilization: 75,
    bottleneck: 'requestSlotWait',
    bottleneckSampleCount: 1,
    bottleneckSource: 'request.requestSlotWaiters.worker',
    bottleneckSubreason: 'waiterNotWoken',
    maxUtilization: 100,
    minUtilization: 50,
    sampleCount: 2,
  })
  expect(secondBucket).toMatchObject({
    adherenceState: 'overLimit',
    avgUtilization: 125,
    maxUtilization: 125,
    minUtilization: 125,
    sampleCount: 2,
  })
  expect(thirdBucket).toMatchObject({avgUtilization: null, maxUtilization: null, minUtilization: null, sampleCount: 1})
  expect(history.buckets.at(-1)?.sampleCount).toBe(0)
})
