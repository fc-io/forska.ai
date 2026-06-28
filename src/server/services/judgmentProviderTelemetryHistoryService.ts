import {randomUUID} from 'node:crypto'

import type {
  JudgmentBottleneck,
  JudgmentBottleneckSubreason,
  JudgmentDispatchTelemetrySnapshot,
  JudgmentTelemetryAggregateCompleteness,
} from '../cron/judgmentsJobs/judgmentDispatchTelemetry.ts'
import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getDateValue, getSqlLiteral, getTimestampLiteral} from './appQueryHelpers.ts'

export const judgmentProviderTelemetryHistoryRangePresets = {
  '5m': {bucketSizeSeconds: 30, durationSeconds: 5 * 60},
  '15m': {bucketSizeSeconds: 30, durationSeconds: 15 * 60},
  '1h': {bucketSizeSeconds: 60, durationSeconds: 60 * 60},
  '24h': {bucketSizeSeconds: 15 * 60, durationSeconds: 24 * 60 * 60},
  '3d': {bucketSizeSeconds: 60 * 60, durationSeconds: 3 * 24 * 60 * 60},
} as const

export const judgmentProviderTelemetrySampleCadenceSeconds = 30
export const judgmentProviderTelemetryHistoryRetentionMs = 3 * 24 * 60 * 60 * 1000

export type JudgmentProviderTelemetryHistoryRange = keyof typeof judgmentProviderTelemetryHistoryRangePresets
export type JudgmentProviderTelemetryAdherenceState = 'overLimit' | 'atLimit' | 'withinLimit' | 'unknown'
export type JudgmentProviderTelemetryHistorySample = {
  bottleneck: JudgmentBottleneck | null
  bottleneckSource: string | null
  bottleneckSubreason: JudgmentBottleneckSubreason | null
  normalRequestCapacity: number
  providerLeasedLiveRequests: number
  providerLeasedPhysicalCalls: number
  providerLimit: number
  providerRequestFillPct: number | null
  sampledAt: Date
}
export type JudgmentProviderTelemetryAlignedRange = {bucketSizeSeconds: number; rangeEnd: Date; rangeStart: Date}
export type JudgmentProviderTelemetryBottleneckSummary = {
  bottleneck: JudgmentBottleneck | null
  bottleneckSampleCount: number
  bottleneckSource: string | null
  bottleneckSubreason: JudgmentBottleneckSubreason | null
}
export type JudgmentProviderTelemetryHistoryBucket = JudgmentProviderTelemetryBottleneckSummary & {
  adherenceState: JudgmentProviderTelemetryAdherenceState
  avgUtilization: number | null
  bucketEnd: Date
  bucketStart: Date
  latestNormalRequestCapacity: number | null
  latestProviderLeasedLiveRequests: number | null
  latestProviderLeasedPhysicalCalls: number | null
  latestProviderLimit: number | null
  maxUtilization: number | null
  minUtilization: number | null
  sampleCount: number
}
export type JudgmentProviderTelemetryHistorySampleInsert = {
  aggregateCompleteness: JudgmentTelemetryAggregateCompleteness
  bottleneck: JudgmentBottleneck | null
  bottleneckSource: string | null
  bottleneckSubreason: JudgmentBottleneckSubreason | null
  effectiveProviderLimit: number
  freshWorkerCount: number
  jobId: string
  normalRequestCapacity: number
  projectId: string
  providerAllocationVersion: string
  providerAvailableRequestLeases: number
  providerKey: string
  providerLeasedLiveRequests: number
  providerLeasedPhysicalCalls: number
  providerLeasedProbeCalls: number
  providerLimit: number
  providerLimitVersion: string
  providerProbeOccupancyVersion: string
  providerRequestFillPct: number | null
  sampledAt: Date
  snapshotJson?: unknown
  staleWorkerCount: number
  targetRequestLiveCalls: number
  unavailableWorkerCount: number
  unallocatedTargetLiveCalls: number
}
export type JudgmentProviderTelemetryHistoryInsertResult = {attempted: number; inserted: number; skipped: number}
export type JudgmentProviderTelemetryBucketedHistory = {
  bucketSizeSeconds: number
  buckets: JudgmentProviderTelemetryHistoryBucket[]
  providerKey: string
  rangeEnd: Date
  rangeStart: Date
}
export type JudgmentProviderTelemetryHistoryRunner = {
  queryJson: <T>(statement: string, workloadContext?: DuckdbWorkloadContext) => Promise<T[]>
}

type BottleneckCandidate = JudgmentProviderTelemetryBottleneckSummary & {latestSampledAtMs: number}
type JudgmentProviderTelemetryHistoryRow = {
  bottleneck: string | null
  bottleneckSource: string | null
  bottleneckSubreason: string | null
  normalRequestCapacity: unknown
  providerLeasedLiveRequests: unknown
  providerLeasedPhysicalCalls: unknown
  providerLimit: unknown
  providerRequestFillPct: unknown
  sampledAt: unknown
}

const getDateFlooredToMs = (date: Date, sizeMs: number) => {
  return new Date(Math.floor(date.getTime() / sizeMs) * sizeMs)
}

const getJudgmentProviderTelemetryWorkloadContext = (routeOrJobKey: string): DuckdbWorkloadContext => {
  return {fallbackIntent: 'reject', routeOrJobKey, workloadClass: 'admin.telemetry'}
}

const judgmentProviderTelemetryInsertWorkloadContext = getJudgmentProviderTelemetryWorkloadContext(
  'judgmentProviderTelemetry.history.insert',
)
const judgmentProviderTelemetryPruneWorkloadContext = getJudgmentProviderTelemetryWorkloadContext(
  'judgmentProviderTelemetry.history.prune',
)
const judgmentProviderTelemetryDeleteJobWorkloadContext = getJudgmentProviderTelemetryWorkloadContext(
  'judgmentProviderTelemetry.history.deleteJob',
)
const judgmentProviderTelemetryBucketedHistoryWorkloadContext = getJudgmentProviderTelemetryWorkloadContext(
  'judgmentProviderTelemetry.history.bucketed',
)

const getBucketSizeMs = (bucketSizeSeconds: number) => {
  return bucketSizeSeconds * 1000
}

const getHistoryRunner = (runner?: JudgmentProviderTelemetryHistoryRunner) => {
  return runner ?? getAppDatabaseService()
}

const getRequiredNumber = (value: unknown, fieldName: string) => {
  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint' || typeof value === 'string'
        ? Number(value)
        : Number.NaN

  if (!Number.isFinite(numericValue)) {
    throw new Error(`Invalid telemetry history ${fieldName}`)
  }

  return numericValue
}

const getNullableNumber = (value: unknown) => {
  const numericValue =
    value === null || value === undefined
      ? null
      : typeof value === 'number'
        ? value
        : typeof value === 'bigint' || typeof value === 'string'
          ? Number(value)
          : Number.NaN

  return numericValue === null ? null : Number.isFinite(numericValue) ? numericValue : null
}

const getRequiredDate = (value: unknown, fieldName: string) => {
  const date = getDateValue(value)

  if (!date) {
    throw new Error(`Invalid telemetry history ${fieldName}`)
  }

  return date
}

const getOptionalSnapshotJsonLiteral = (sample: JudgmentProviderTelemetryHistorySampleInsert) => {
  return `${getSqlLiteral(sample.snapshotJson ?? null)}::JSON`
}

const getSampleInsertValueSql = (params: {createdAt: Date; sample: JudgmentProviderTelemetryHistorySampleInsert}) => {
  const sampledAt = getJudgmentProviderTelemetryCadenceSlotStart(params.sample.sampledAt)

  return `(
    ${getSqlLiteral(randomUUID())},
    ${getTimestampLiteral(params.createdAt)},
    ${getSqlLiteral(params.sample.jobId)},
    ${getSqlLiteral(params.sample.projectId)},
    ${getSqlLiteral(params.sample.providerKey)},
    ${getTimestampLiteral(sampledAt)},
    ${getSqlLiteral(params.sample.providerLimit)},
    ${getSqlLiteral(params.sample.effectiveProviderLimit)},
    ${getSqlLiteral(params.sample.normalRequestCapacity)},
    ${getSqlLiteral(params.sample.targetRequestLiveCalls)},
    ${getSqlLiteral(params.sample.unallocatedTargetLiveCalls)},
    ${getSqlLiteral(params.sample.providerAvailableRequestLeases)},
    ${getSqlLiteral(params.sample.providerLeasedLiveRequests)},
    ${getSqlLiteral(params.sample.providerLeasedPhysicalCalls)},
    ${getSqlLiteral(params.sample.providerLeasedProbeCalls)},
    ${getSqlLiteral(params.sample.providerRequestFillPct)},
    ${getSqlLiteral(params.sample.providerLimitVersion)},
    ${getSqlLiteral(params.sample.providerProbeOccupancyVersion)},
    ${getSqlLiteral(params.sample.providerAllocationVersion)},
    ${getSqlLiteral(params.sample.bottleneck)},
    ${getSqlLiteral(params.sample.bottleneckSource)},
    ${getSqlLiteral(params.sample.bottleneckSubreason)},
    ${getSqlLiteral(params.sample.freshWorkerCount)},
    ${getSqlLiteral(params.sample.staleWorkerCount)},
    ${getSqlLiteral(params.sample.unavailableWorkerCount)},
    ${getSqlLiteral(params.sample.aggregateCompleteness)},
    ${getOptionalSnapshotJsonLiteral(params.sample)}
  )`
}

const getSampleInsertSql = (params: {createdAt: Date; samples: JudgmentProviderTelemetryHistorySampleInsert[]}) => {
  return `
    INSERT INTO app.judgment_job_provider_telemetry_sample (
      id,
      created_at,
      job_id,
      project_id,
      provider_key,
      sampled_at,
      provider_limit,
      effective_provider_limit,
      normal_request_capacity,
      target_request_live_calls,
      unallocated_target_live_calls,
      provider_available_request_leases,
      provider_leased_live_requests,
      provider_leased_physical_calls,
      provider_leased_probe_calls,
      provider_request_fill_pct,
      provider_limit_version,
      provider_probe_occupancy_version,
      provider_allocation_version,
      bottleneck,
      bottleneck_source,
      bottleneck_subreason,
      fresh_worker_count,
      stale_worker_count,
      unavailable_worker_count,
      aggregate_completeness,
      snapshot_json
    ) VALUES ${params.samples
      .map((sample) => {
        return getSampleInsertValueSql({createdAt: params.createdAt, sample})
      })
      .join(', ')}
    ON CONFLICT(job_id, provider_key, sampled_at) DO NOTHING
    RETURNING id
  `
}

const getHistorySampleFromRow = (row: JudgmentProviderTelemetryHistoryRow): JudgmentProviderTelemetryHistorySample => {
  return {
    bottleneck: row.bottleneck as JudgmentBottleneck | null,
    bottleneckSource: row.bottleneckSource,
    bottleneckSubreason: row.bottleneckSubreason as JudgmentBottleneckSubreason | null,
    normalRequestCapacity: getRequiredNumber(row.normalRequestCapacity, 'normalRequestCapacity'),
    providerLeasedLiveRequests: getRequiredNumber(row.providerLeasedLiveRequests, 'providerLeasedLiveRequests'),
    providerLeasedPhysicalCalls: getRequiredNumber(row.providerLeasedPhysicalCalls, 'providerLeasedPhysicalCalls'),
    providerLimit: getRequiredNumber(row.providerLimit, 'providerLimit'),
    providerRequestFillPct: getNullableNumber(row.providerRequestFillPct),
    sampledAt: getRequiredDate(row.sampledAt, 'sampledAt'),
  }
}

const getBucketStartDates = (params: {bucketSizeMs: number; rangeEndMs: number; rangeStartMs: number}): Date[] => {
  const getStarts = (cursorMs: number, starts: Date[]): Date[] => {
    return cursorMs >= params.rangeEndMs
      ? starts
      : getStarts(cursorMs + params.bucketSizeMs, [...starts, new Date(cursorMs)])
  }

  return getStarts(params.rangeStartMs, [])
}

const getSampleBucketIndex = (params: {
  bucketSizeMs: number
  rangeEndMs: number
  rangeStartMs: number
  sample: JudgmentProviderTelemetryHistorySample
}) => {
  const sampledAtMs = params.sample.sampledAt.getTime()
  const inRange = sampledAtMs >= params.rangeStartMs && sampledAtMs < params.rangeEndMs

  return inRange ? Math.floor((sampledAtMs - params.rangeStartMs) / params.bucketSizeMs) : null
}

const isFiniteNumber = (value: number | null): value is number => {
  return typeof value === 'number' && Number.isFinite(value)
}

const getUtilizationSummary = (samples: JudgmentProviderTelemetryHistorySample[]) => {
  const utilizationValues = samples.map(getJudgmentProviderTelemetryUtilization).filter(isFiniteNumber)
  const utilizationSum = utilizationValues.reduce((sum, value) => {
    return sum + value
  }, 0)

  return utilizationValues.length === 0
    ? {avgUtilization: null, maxUtilization: null, minUtilization: null}
    : {
        avgUtilization: utilizationSum / utilizationValues.length,
        maxUtilization: Math.max(...utilizationValues),
        minUtilization: Math.min(...utilizationValues),
      }
}

const getLatestHistorySample = (
  samples: JudgmentProviderTelemetryHistorySample[],
): JudgmentProviderTelemetryHistorySample | null => {
  return samples.reduce<JudgmentProviderTelemetryHistorySample | null>((latestSample, sample) => {
    return latestSample === null || sample.sampledAt.getTime() >= latestSample.sampledAt.getTime()
      ? sample
      : latestSample
  }, null)
}

const getRequestLimitSummary = (samples: JudgmentProviderTelemetryHistorySample[]) => {
  const latestSample = getLatestHistorySample(samples)

  return latestSample === null
    ? {
        latestNormalRequestCapacity: null,
        latestProviderLeasedLiveRequests: null,
        latestProviderLeasedPhysicalCalls: null,
        latestProviderLimit: null,
      }
    : {
        latestNormalRequestCapacity: latestSample.normalRequestCapacity,
        latestProviderLeasedLiveRequests: latestSample.providerLeasedLiveRequests,
        latestProviderLeasedPhysicalCalls: latestSample.providerLeasedPhysicalCalls,
        latestProviderLimit: latestSample.providerLimit,
      }
}

const getBetterBottleneckCandidate = (
  current: BottleneckCandidate | null,
  candidate: BottleneckCandidate,
): BottleneckCandidate => {
  const candidateWins =
    current === null
    || candidate.bottleneckSampleCount > current.bottleneckSampleCount
    || (candidate.bottleneckSampleCount === current.bottleneckSampleCount
      && candidate.latestSampledAtMs > current.latestSampledAtMs)
    || (candidate.bottleneckSampleCount === current.bottleneckSampleCount
      && candidate.latestSampledAtMs === current.latestSampledAtMs
      && String(candidate.bottleneck) < String(current.bottleneck))

  return candidateWins ? candidate : current
}

const getEmptyBottleneckSummary = (): JudgmentProviderTelemetryBottleneckSummary => {
  return {bottleneck: null, bottleneckSampleCount: 0, bottleneckSource: null, bottleneckSubreason: null}
}

const getBucketSamples = (params: {
  bucketSizeMs: number
  rangeEndMs: number
  rangeStartMs: number
  samples: JudgmentProviderTelemetryHistorySample[]
}) => {
  return params.samples.reduce<Map<number, JudgmentProviderTelemetryHistorySample[]>>((bucketSamples, sample) => {
    const bucketIndex = getSampleBucketIndex({...params, sample})

    if (bucketIndex === null) {
      return bucketSamples
    }

    bucketSamples.set(bucketIndex, [...(bucketSamples.get(bucketIndex) ?? []), sample])

    return bucketSamples
  }, new Map<number, JudgmentProviderTelemetryHistorySample[]>())
}

const getHistoryBucket = (params: {
  bucketSizeMs: number
  bucketStart: Date
  samples: JudgmentProviderTelemetryHistorySample[]
}): JudgmentProviderTelemetryHistoryBucket => {
  const utilizationSummary = getUtilizationSummary(params.samples)
  const bottleneckSummary = getJudgmentProviderTelemetryBottleneckSummary(params.samples)
  const requestLimitSummary = getRequestLimitSummary(params.samples)

  return {
    ...bottleneckSummary,
    ...utilizationSummary,
    ...requestLimitSummary,
    adherenceState: getJudgmentProviderTelemetryBucketAdherenceState(params.samples),
    bucketEnd: new Date(params.bucketStart.getTime() + params.bucketSizeMs),
    bucketStart: params.bucketStart,
    sampleCount: params.samples.length,
  }
}

export const isJudgmentProviderTelemetryHistoryRange = (
  value: string,
): value is JudgmentProviderTelemetryHistoryRange => {
  return value in judgmentProviderTelemetryHistoryRangePresets
}

export const getJudgmentProviderTelemetryCadenceSlotStart = (sampledAt: Date): Date => {
  return getDateFlooredToMs(sampledAt, getBucketSizeMs(judgmentProviderTelemetrySampleCadenceSeconds))
}

export const getJudgmentProviderTelemetryAlignedRange = (params: {
  now?: Date
  range: JudgmentProviderTelemetryHistoryRange
}): JudgmentProviderTelemetryAlignedRange => {
  const preset = judgmentProviderTelemetryHistoryRangePresets[params.range]
  const bucketSizeMs = getBucketSizeMs(preset.bucketSizeSeconds)
  const rangeEnd = getDateFlooredToMs(params.now ?? new Date(), bucketSizeMs)
  const rangeStart = new Date(rangeEnd.getTime() - preset.durationSeconds * 1000)

  return {bucketSizeSeconds: preset.bucketSizeSeconds, rangeEnd, rangeStart}
}

export const getJudgmentProviderTelemetryEmptyBuckets = (
  range: JudgmentProviderTelemetryAlignedRange,
): JudgmentProviderTelemetryHistoryBucket[] => {
  const bucketSizeMs = getBucketSizeMs(range.bucketSizeSeconds)
  const bucketStarts = getBucketStartDates({
    bucketSizeMs,
    rangeEndMs: range.rangeEnd.getTime(),
    rangeStartMs: range.rangeStart.getTime(),
  })

  return bucketStarts.map((bucketStart) => {
    return getHistoryBucket({bucketSizeMs, bucketStart, samples: []})
  })
}

export const getJudgmentProviderTelemetryUtilization = (
  sample: Pick<
    JudgmentProviderTelemetryHistorySample,
    'normalRequestCapacity' | 'providerLeasedLiveRequests' | 'providerRequestFillPct'
  >,
): number | null => {
  return sample.normalRequestCapacity <= 0
    ? null
    : (sample.providerRequestFillPct ?? (sample.providerLeasedLiveRequests / sample.normalRequestCapacity) * 100)
}

export const getJudgmentProviderTelemetrySampleAdherenceState = (
  sample: Pick<
    JudgmentProviderTelemetryHistorySample,
    'normalRequestCapacity' | 'providerLeasedLiveRequests' | 'providerLeasedPhysicalCalls' | 'providerLimit'
  >,
): JudgmentProviderTelemetryAdherenceState => {
  const overNormalRequestCapacity = sample.providerLeasedLiveRequests > sample.normalRequestCapacity
  const overProviderLimit = sample.providerLeasedPhysicalCalls > sample.providerLimit
  const atNormalRequestCapacity = sample.providerLeasedLiveRequests === sample.normalRequestCapacity
  const atProviderLimit = sample.providerLeasedPhysicalCalls === sample.providerLimit

  return overNormalRequestCapacity || overProviderLimit
    ? 'overLimit'
    : atNormalRequestCapacity || atProviderLimit
      ? 'atLimit'
      : 'withinLimit'
}

export const getJudgmentProviderTelemetryBucketAdherenceState = (
  samples: JudgmentProviderTelemetryHistorySample[],
): JudgmentProviderTelemetryAdherenceState => {
  const sampleStates = samples.map(getJudgmentProviderTelemetrySampleAdherenceState)

  return sampleStates.includes('overLimit')
    ? 'overLimit'
    : sampleStates.includes('atLimit')
      ? 'atLimit'
      : sampleStates.includes('withinLimit')
        ? 'withinLimit'
        : 'unknown'
}

export const getJudgmentProviderTelemetryBottleneckSummary = (
  samples: JudgmentProviderTelemetryHistorySample[],
): JudgmentProviderTelemetryBottleneckSummary => {
  const candidates = samples.reduce<Map<JudgmentBottleneck, BottleneckCandidate>>((summaryByBottleneck, sample) => {
    if (sample.bottleneck === null) {
      return summaryByBottleneck
    }

    const existing = summaryByBottleneck.get(sample.bottleneck)
    const sampledAtMs = sample.sampledAt.getTime()
    const latestSample =
      existing === undefined || sampledAtMs >= existing.latestSampledAtMs
        ? {
            bottleneckSource: sample.bottleneckSource,
            bottleneckSubreason: sample.bottleneckSubreason,
            latestSampledAtMs: sampledAtMs,
          }
        : {
            bottleneckSource: existing.bottleneckSource,
            bottleneckSubreason: existing.bottleneckSubreason,
            latestSampledAtMs: existing.latestSampledAtMs,
          }

    summaryByBottleneck.set(sample.bottleneck, {
      bottleneck: sample.bottleneck,
      bottleneckSampleCount: (existing?.bottleneckSampleCount ?? 0) + 1,
      bottleneckSource: latestSample.bottleneckSource,
      bottleneckSubreason: latestSample.bottleneckSubreason,
      latestSampledAtMs: latestSample.latestSampledAtMs,
    })

    return summaryByBottleneck
  }, new Map<JudgmentBottleneck, BottleneckCandidate>())
  const selected = Array.from(candidates.values()).reduce<BottleneckCandidate | null>(
    getBetterBottleneckCandidate,
    null,
  )

  return selected === null
    ? getEmptyBottleneckSummary()
    : {
        bottleneck: selected.bottleneck,
        bottleneckSampleCount: selected.bottleneckSampleCount,
        bottleneckSource: selected.bottleneckSource,
        bottleneckSubreason: selected.bottleneckSubreason,
      }
}

export const getJudgmentProviderTelemetryHistoryBuckets = (params: {
  range: JudgmentProviderTelemetryAlignedRange
  samples: JudgmentProviderTelemetryHistorySample[]
}): JudgmentProviderTelemetryHistoryBucket[] => {
  const bucketSizeMs = getBucketSizeMs(params.range.bucketSizeSeconds)
  const rangeEndMs = params.range.rangeEnd.getTime()
  const rangeStartMs = params.range.rangeStart.getTime()
  const bucketSamples = getBucketSamples({...params, bucketSizeMs, rangeEndMs, rangeStartMs})
  const bucketStarts = getBucketStartDates({bucketSizeMs, rangeEndMs, rangeStartMs})

  return bucketStarts.map((bucketStart, index) => {
    return getHistoryBucket({bucketSizeMs, bucketStart, samples: bucketSamples.get(index) ?? []})
  })
}

export const insertJudgmentProviderTelemetryHistorySamples = async (params: {
  createdAt?: Date
  runner?: JudgmentProviderTelemetryHistoryRunner
  samples: JudgmentProviderTelemetryHistorySampleInsert[]
}): Promise<JudgmentProviderTelemetryHistoryInsertResult> => {
  if (params.samples.length === 0) {
    return {attempted: 0, inserted: 0, skipped: 0}
  }

  const createdAt = params.createdAt ?? new Date()
  const rows = await getHistoryRunner(params.runner).queryJson<{id: string}>(
    getSampleInsertSql({createdAt, samples: params.samples}),
    judgmentProviderTelemetryInsertWorkloadContext,
  )
  const inserted = rows.length

  return {attempted: params.samples.length, inserted, skipped: params.samples.length - inserted}
}

export const getJudgmentProviderTelemetryHistorySampleInsertFromSnapshot = (params: {
  jobId: string
  projectId: string
  sampledAt: Date
  snapshot: JudgmentDispatchTelemetrySnapshot
}): JudgmentProviderTelemetryHistorySampleInsert => {
  const provider = params.snapshot.provider
  const source = params.snapshot.source

  return {
    aggregateCompleteness: source.aggregateCompleteness,
    bottleneck: provider.bottleneck,
    bottleneckSource: provider.bottleneckSource,
    bottleneckSubreason: provider.bottleneckSubreason,
    effectiveProviderLimit: provider.effectiveProviderLimit,
    freshWorkerCount: source.freshWorkerCount,
    jobId: params.jobId,
    normalRequestCapacity: provider.normalRequestCapacity,
    projectId: params.projectId,
    providerAllocationVersion: provider.providerAllocationVersion,
    providerAvailableRequestLeases: provider.providerAvailableRequestLeases,
    providerKey: provider.providerKey,
    providerLeasedLiveRequests: provider.providerLeasedLiveRequests,
    providerLeasedPhysicalCalls: provider.providerLeasedPhysicalCalls,
    providerLeasedProbeCalls: provider.providerLeasedProbeCalls,
    providerLimit: provider.providerLimit,
    providerLimitVersion: provider.providerLimitVersion,
    providerProbeOccupancyVersion: provider.providerProbeOccupancyVersion,
    providerRequestFillPct: provider.providerRequestFillPct,
    sampledAt: params.sampledAt,
    snapshotJson: {dispatch: params.snapshot.dispatch, provider, request: params.snapshot.request, source},
    staleWorkerCount: source.staleWorkerCount,
    targetRequestLiveCalls: provider.targetRequestLiveCalls,
    unavailableWorkerCount: source.unavailableWorkerCount,
    unallocatedTargetLiveCalls: provider.unallocatedTargetLiveCalls,
  }
}

export const insertJudgmentProviderTelemetryHistorySample = async (params: {
  createdAt?: Date
  runner?: JudgmentProviderTelemetryHistoryRunner
  sample: JudgmentProviderTelemetryHistorySampleInsert
}): Promise<JudgmentProviderTelemetryHistoryInsertResult> => {
  return insertJudgmentProviderTelemetryHistorySamples({
    createdAt: params.createdAt,
    runner: params.runner,
    samples: [params.sample],
  })
}

export const pruneJudgmentProviderTelemetryHistorySamples = async (
  params: {now?: Date; runner?: JudgmentProviderTelemetryHistoryRunner} = {},
): Promise<number> => {
  const cutoff = new Date((params.now ?? new Date()).getTime() - judgmentProviderTelemetryHistoryRetentionMs)
  const rows = await getHistoryRunner(params.runner).queryJson<{id: string}>(
    `
    DELETE FROM app.judgment_job_provider_telemetry_sample
    WHERE sampled_at < ${getTimestampLiteral(cutoff)}
    RETURNING id
  `,
    judgmentProviderTelemetryPruneWorkloadContext,
  )

  return rows.length
}

export const deleteJudgmentProviderTelemetryHistoryForJob = async (params: {
  jobId: string
  runner?: JudgmentProviderTelemetryHistoryRunner
}): Promise<number> => {
  const rows = await getHistoryRunner(params.runner).queryJson<{id: string}>(
    `
    DELETE FROM app.judgment_job_provider_telemetry_sample
    WHERE job_id = ${getSqlLiteral(params.jobId)}
    RETURNING id
  `,
    judgmentProviderTelemetryDeleteJobWorkloadContext,
  )

  return rows.length
}

export const queryJudgmentProviderTelemetryBucketedHistory = async (params: {
  jobId: string
  now?: Date
  providerKey: string
  range: JudgmentProviderTelemetryHistoryRange
  runner?: JudgmentProviderTelemetryHistoryRunner
}): Promise<JudgmentProviderTelemetryBucketedHistory> => {
  const range = getJudgmentProviderTelemetryAlignedRange({now: params.now, range: params.range})
  const rows = await getHistoryRunner(params.runner).queryJson<JudgmentProviderTelemetryHistoryRow>(
    `
    SELECT
      sampled_at AS sampledAt,
      normal_request_capacity AS normalRequestCapacity,
      provider_leased_live_requests AS providerLeasedLiveRequests,
      provider_leased_physical_calls AS providerLeasedPhysicalCalls,
      provider_limit AS providerLimit,
      provider_request_fill_pct AS providerRequestFillPct,
      bottleneck,
      bottleneck_source AS bottleneckSource,
      bottleneck_subreason AS bottleneckSubreason
    FROM app.judgment_job_provider_telemetry_sample
    WHERE job_id = ${getSqlLiteral(params.jobId)}
      AND provider_key = ${getSqlLiteral(params.providerKey)}
      AND sampled_at >= ${getTimestampLiteral(range.rangeStart)}
      AND sampled_at < ${getTimestampLiteral(range.rangeEnd)}
    ORDER BY sampled_at ASC
  `,
    judgmentProviderTelemetryBucketedHistoryWorkloadContext,
  )
  const samples = rows.map(getHistorySampleFromRow)

  return {
    bucketSizeSeconds: range.bucketSizeSeconds,
    buckets: getJudgmentProviderTelemetryHistoryBuckets({range, samples}),
    providerKey: params.providerKey,
    rangeEnd: range.rangeEnd,
    rangeStart: range.rangeStart,
  }
}
