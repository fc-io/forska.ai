import type {JudgmentBottleneck, JudgmentBottleneckSubreason} from '../cron/judgmentsJobs/judgmentDispatchTelemetry.ts'

export const judgmentProviderTelemetryHistoryRangePresets = {
  '5m': {bucketSizeSeconds: 30, durationSeconds: 5 * 60},
  '15m': {bucketSizeSeconds: 30, durationSeconds: 15 * 60},
  '1h': {bucketSizeSeconds: 60, durationSeconds: 60 * 60},
  '24h': {bucketSizeSeconds: 15 * 60, durationSeconds: 24 * 60 * 60},
  '3d': {bucketSizeSeconds: 60 * 60, durationSeconds: 3 * 24 * 60 * 60},
} as const

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
  maxUtilization: number | null
  minUtilization: number | null
  sampleCount: number
}

type BottleneckCandidate = JudgmentProviderTelemetryBottleneckSummary & {latestSampledAtMs: number}

const getDateFlooredToMs = (date: Date, sizeMs: number) => {
  return new Date(Math.floor(date.getTime() / sizeMs) * sizeMs)
}

const getBucketSizeMs = (bucketSizeSeconds: number) => {
  return bucketSizeSeconds * 1000
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

  return {
    ...bottleneckSummary,
    ...utilizationSummary,
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
