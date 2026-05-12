import {expect, test} from 'bun:test'

import {
  getJudgmentProviderTelemetryAlignedRange,
  getJudgmentProviderTelemetryBottleneckSummary,
  getJudgmentProviderTelemetryBucketAdherenceState,
  getJudgmentProviderTelemetryHistoryBuckets,
  getJudgmentProviderTelemetrySampleAdherenceState,
  getJudgmentProviderTelemetryUtilization,
  type JudgmentProviderTelemetryHistoryRange,
  type JudgmentProviderTelemetryHistorySample,
} from './judgmentProviderTelemetryHistoryService.ts'

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
    maxUtilization: 100,
    minUtilization: 50,
    sampleCount: 2,
  })
  expect(buckets[1]).toMatchObject({
    adherenceState: 'overLimit',
    avgUtilization: 125,
    maxUtilization: 125,
    minUtilization: 125,
    sampleCount: 2,
  })
  expect(buckets[2]).toMatchObject({
    adherenceState: 'unknown',
    avgUtilization: null,
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
