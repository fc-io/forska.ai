import type {ProjectTransferPayloadByKey} from './projectTransferPayloadSchemas.ts'
import {
  type ProjectTransferPackageWarning,
  type ProjectTransferPayloadKey,
  projectTransferPayloadKeys,
} from './projectTransferSchemas.ts'

export const projectTransferMetricUnavailable = 'unavailable' as const

export const projectTransferPerformancePhases = [
  'upload',
  'zipScan',
  'payloadParse',
  'stagingLoad',
  'targetAnalysis',
  'dependencyResolution',
  'revalidation',
  'assetPromotion',
  'appTableWrites',
  'historyWrite',
  'cleanup',
  'exportAssembly',
  'exportPackageWrite',
] as const

export type ProjectTransferMetricValue = number | typeof projectTransferMetricUnavailable
export type ProjectTransferPerformancePhase = (typeof projectTransferPerformancePhases)[number]
export type ProjectTransferPerformanceOperation = 'export' | 'import'
export type ProjectTransferPerformanceRowCounterKey = ProjectTransferPayloadKey | 'assetEntries' | 'assetReferences'

export type ProjectTransferPerformancePhaseTiming = {
  durationMs: ProjectTransferMetricValue
  endedAt: string
  sampledPeakMemoryBytes: ProjectTransferMetricValue
  startedAt: string
}

export type ProjectTransferPerformanceWarningDetail = {code: string; count: number; scope: string; severity: string}

export type ProjectTransferPerformanceMetrics = {
  benchmark: {
    bytesPerSecond: ProjectTransferMetricValue
    conflictShape: unknown
    correctnessChecks: unknown
    dependencyExecutionSignature: unknown
    duckdbSpillBytes: ProjectTransferMetricValue
    finalAssetBytes: ProjectTransferMetricValue
    packageFingerprint: string
    peakMemoryBytes: ProjectTransferMetricValue
    rawArticleProvenanceMode: string
    revalidationOutcome: unknown
    rowsPerSecond: ProjectTransferMetricValue
    schemaVersion: ProjectTransferMetricValue
    temporaryDiskBytes: ProjectTransferMetricValue
    wallTimeMs: ProjectTransferMetricValue
    warningDetails: ProjectTransferPerformanceWarningDetail[]
    writerTransactionMs: ProjectTransferMetricValue
  }
  bytes: Record<string, ProjectTransferMetricValue>
  duckdb: {spillBytes: ProjectTransferMetricValue; writerTransactionMs: ProjectTransferMetricValue}
  memory: {sampledPeakBytes: ProjectTransferMetricValue}
  operation: ProjectTransferPerformanceOperation
  parser: {usesStreamingParser: false}
  phases: Record<ProjectTransferPerformancePhase, ProjectTransferPerformancePhaseTiming>
  rows: Record<ProjectTransferPerformanceRowCounterKey, ProjectTransferMetricValue>
  version: 1
  warnings: {
    byCode: Record<string, number>
    byScope: Record<string, number>
    bySeverity: Record<string, number>
    details: ProjectTransferPerformanceWarningDetail[]
    total: number
  }
}

type ProjectTransferPerformanceMetricInput = {
  benchmark?: Partial<ProjectTransferPerformanceMetrics['benchmark']>
  bytes?: Record<string, ProjectTransferMetricValue | null | undefined>
  duckdbSpillBytes?: ProjectTransferMetricValue | null
  operation: ProjectTransferPerformanceOperation
  phases?: Partial<Record<ProjectTransferPerformancePhase, ProjectTransferPerformancePhaseTiming>>
  rows?: Partial<Record<ProjectTransferPerformanceRowCounterKey, ProjectTransferMetricValue | null | undefined>>
  sampledPeakMemoryBytes?: ProjectTransferMetricValue | null
  warnings?: readonly ProjectTransferPackageWarning[]
  writerTransactionMs?: ProjectTransferMetricValue | null
}

type MeasureProjectTransferPhaseResult<TValue> = {timing: ProjectTransferPerformancePhaseTiming; value: TValue}

const getUnavailableMetric = () => {
  return projectTransferMetricUnavailable
}

const isKnownMetric = (value: ProjectTransferMetricValue | null | undefined): value is number => {
  return typeof value === 'number' && Number.isFinite(value)
}

const getMetricValue = (value: ProjectTransferMetricValue | null | undefined): ProjectTransferMetricValue => {
  return isKnownMetric(value) ? value : getUnavailableMetric()
}

const getRoundedDurationMs = (startedAtMs: number) => {
  return Math.max(0, Math.round(performance.now() - startedAtMs))
}

export const sampleProjectTransferMemoryBytes = (): ProjectTransferMetricValue => {
  return typeof process.memoryUsage === 'function' ? process.memoryUsage().rss : getUnavailableMetric()
}

const getMaximumKnownMetric = (values: readonly ProjectTransferMetricValue[]) => {
  const knownValues = values.filter(isKnownMetric)

  return knownValues.length === 0 ? getUnavailableMetric() : Math.max(...knownValues)
}

const getUnavailablePhaseTiming = (): ProjectTransferPerformancePhaseTiming => {
  return {
    durationMs: getUnavailableMetric(),
    endedAt: getUnavailableMetric(),
    sampledPeakMemoryBytes: getUnavailableMetric(),
    startedAt: getUnavailableMetric(),
  }
}

const getUnavailablePhaseTimings = () => {
  return projectTransferPerformancePhases.reduce<
    Record<ProjectTransferPerformancePhase, ProjectTransferPerformancePhaseTiming>
  >(
    (timings, phase) => {
      return {...timings, [phase]: getUnavailablePhaseTiming()}
    },
    {} as Record<ProjectTransferPerformancePhase, ProjectTransferPerformancePhaseTiming>,
  )
}

const getUnavailableRowCounters = () => {
  return [...projectTransferPayloadKeys, 'assetEntries', 'assetReferences'].reduce<
    Record<ProjectTransferPerformanceRowCounterKey, ProjectTransferMetricValue>
  >(
    (counts, key) => {
      return {...counts, [key]: getUnavailableMetric()}
    },
    {} as Record<ProjectTransferPerformanceRowCounterKey, ProjectTransferMetricValue>,
  )
}

const incrementCount = (counts: Record<string, number>, key: string) => {
  return {...counts, [key]: (counts[key] ?? 0) + 1}
}

const getWarningDetails = (warnings: readonly ProjectTransferPackageWarning[]) => {
  const countByKey = warnings.reduce<Record<string, ProjectTransferPerformanceWarningDetail>>((counts, warning) => {
    const key = `${warning.code}\u0000${warning.scope}\u0000${warning.severity}`
    const existing = counts[key]

    return {
      ...counts,
      [key]: {code: warning.code, count: (existing?.count ?? 0) + 1, scope: warning.scope, severity: warning.severity},
    }
  }, {})

  return Object.values(countByKey)
}

const getWarningMetrics = (warnings: readonly ProjectTransferPackageWarning[]) => {
  return {
    byCode: warnings.reduce<Record<string, number>>((counts, warning) => {
      return incrementCount(counts, warning.code)
    }, {}),
    byScope: warnings.reduce<Record<string, number>>((counts, warning) => {
      return incrementCount(counts, warning.scope)
    }, {}),
    bySeverity: warnings.reduce<Record<string, number>>((counts, warning) => {
      return incrementCount(counts, warning.severity)
    }, {}),
    details: getWarningDetails(warnings),
    total: warnings.length,
  }
}

const getKnownTotal = (values: readonly ProjectTransferMetricValue[]) => {
  const knownValues = values.filter(isKnownMetric)

  return knownValues.length === 0
    ? getUnavailableMetric()
    : knownValues.reduce((total, value) => {
        return total + value
      }, 0)
}

const getRatePerSecond = ({
  durationMs,
  value,
}: {
  durationMs: ProjectTransferMetricValue
  value: ProjectTransferMetricValue
}) => {
  return isKnownMetric(durationMs) && durationMs > 0 && isKnownMetric(value)
    ? Number((value / (durationMs / 1000)).toFixed(2))
    : getUnavailableMetric()
}

const getPeakMemoryFromPhases = (
  phases: Record<ProjectTransferPerformancePhase, ProjectTransferPerformancePhaseTiming>,
) => {
  return getMaximumKnownMetric(
    Object.values(phases).map((phase) => {
      return phase.sampledPeakMemoryBytes
    }),
  )
}

const getBenchmarkFields = ({
  benchmark,
  bytes,
  duckdbSpillBytes,
  phases,
  rows,
  sampledPeakMemoryBytes,
  warningDetails,
  writerTransactionMs,
}: {
  benchmark?: Partial<ProjectTransferPerformanceMetrics['benchmark']>
  bytes: Record<string, ProjectTransferMetricValue>
  duckdbSpillBytes: ProjectTransferMetricValue
  phases: Record<ProjectTransferPerformancePhase, ProjectTransferPerformancePhaseTiming>
  rows: Record<ProjectTransferPerformanceRowCounterKey, ProjectTransferMetricValue>
  sampledPeakMemoryBytes: ProjectTransferMetricValue
  warningDetails: ProjectTransferPerformanceWarningDetail[]
  writerTransactionMs: ProjectTransferMetricValue
}): ProjectTransferPerformanceMetrics['benchmark'] => {
  const wallTimeMs = getMetricValue(
    benchmark?.wallTimeMs
      ?? getKnownTotal(
        Object.values(phases).map((phase) => {
          return phase.durationMs
        }),
      ),
  )
  const rowTotal = getKnownTotal(
    projectTransferPayloadKeys.map((key) => {
      return rows[key]
    }),
  )
  const byteTotal = getKnownTotal(Object.values(bytes))
  const peakMemoryBytes = getMetricValue(
    benchmark?.peakMemoryBytes ?? sampledPeakMemoryBytes ?? getPeakMemoryFromPhases(phases),
  )

  return {
    bytesPerSecond: getMetricValue(
      benchmark?.bytesPerSecond ?? getRatePerSecond({durationMs: wallTimeMs, value: byteTotal}),
    ),
    conflictShape: benchmark?.conflictShape ?? getUnavailableMetric(),
    correctnessChecks: benchmark?.correctnessChecks ?? getUnavailableMetric(),
    dependencyExecutionSignature: benchmark?.dependencyExecutionSignature ?? getUnavailableMetric(),
    duckdbSpillBytes: getMetricValue(benchmark?.duckdbSpillBytes ?? duckdbSpillBytes),
    finalAssetBytes: getMetricValue(benchmark?.finalAssetBytes),
    packageFingerprint:
      typeof benchmark?.packageFingerprint === 'string' ? benchmark.packageFingerprint : getUnavailableMetric(),
    peakMemoryBytes,
    rawArticleProvenanceMode:
      typeof benchmark?.rawArticleProvenanceMode === 'string'
        ? benchmark.rawArticleProvenanceMode
        : getUnavailableMetric(),
    revalidationOutcome: benchmark?.revalidationOutcome ?? getUnavailableMetric(),
    rowsPerSecond: getMetricValue(
      benchmark?.rowsPerSecond ?? getRatePerSecond({durationMs: wallTimeMs, value: rowTotal}),
    ),
    schemaVersion: getMetricValue(benchmark?.schemaVersion),
    temporaryDiskBytes: getMetricValue(benchmark?.temporaryDiskBytes),
    wallTimeMs,
    warningDetails: benchmark?.warningDetails ?? warningDetails,
    writerTransactionMs: getMetricValue(benchmark?.writerTransactionMs ?? writerTransactionMs),
  }
}

export const getProjectTransferPerformanceRowCounters = ({
  assetEntryCount,
  assetReferenceCount,
  payloadCounts,
}: {
  assetEntryCount?: ProjectTransferMetricValue | null
  assetReferenceCount?: ProjectTransferMetricValue | null
  payloadCounts?: Partial<Record<ProjectTransferPayloadKey, ProjectTransferMetricValue | null | undefined>>
} = {}) => {
  return {
    ...projectTransferPayloadKeys.reduce<
      Partial<Record<ProjectTransferPerformanceRowCounterKey, ProjectTransferMetricValue>>
    >((counts, key) => {
      return {...counts, [key]: getMetricValue(payloadCounts?.[key])}
    }, {}),
    assetEntries: getMetricValue(assetEntryCount),
    assetReferences: getMetricValue(assetReferenceCount),
  } as Record<ProjectTransferPerformanceRowCounterKey, ProjectTransferMetricValue>
}

const getPayloadRecordCount = <TKey extends ProjectTransferPayloadKey>(
  key: TKey,
  payload: Partial<ProjectTransferPayloadByKey>[TKey],
) => {
  return payload === undefined
    ? getUnavailableMetric()
    : key === 'project'
      ? 1
      : key === 'assetManifest'
        ? (payload as ProjectTransferPayloadByKey['assetManifest']).entries.length
        : Array.isArray(payload)
          ? payload.length
          : 0
}

export const getProjectTransferPerformanceRowCountersFromPayloads = (
  payloads: Partial<ProjectTransferPayloadByKey>,
) => {
  const assetEntries = payloads.assetManifest?.entries ?? null
  const assetReferenceCount =
    assetEntries === null
      ? getUnavailableMetric()
      : assetEntries.reduce((total, entry) => {
          return total + entry.references.length
        }, 0)

  return getProjectTransferPerformanceRowCounters({
    assetEntryCount: assetEntries === null ? getUnavailableMetric() : assetEntries.length,
    assetReferenceCount,
    payloadCounts: projectTransferPayloadKeys.reduce<
      Partial<Record<ProjectTransferPayloadKey, ProjectTransferMetricValue>>
    >((counts, key) => {
      return {...counts, [key]: getPayloadRecordCount(key, payloads[key])}
    }, {}),
  })
}

export const getProjectTransferPerformanceMetrics = ({
  benchmark,
  bytes,
  duckdbSpillBytes,
  operation,
  phases,
  rows,
  sampledPeakMemoryBytes,
  warnings = [],
  writerTransactionMs,
}: ProjectTransferPerformanceMetricInput): ProjectTransferPerformanceMetrics => {
  const phaseTimings = {...getUnavailablePhaseTimings(), ...(phases ?? {})}
  const byteCounters = Object.entries(bytes ?? {}).reduce<Record<string, ProjectTransferMetricValue>>(
    (counters, [key, value]) => {
      return {...counters, [key]: getMetricValue(value)}
    },
    {},
  )
  const rowCounters = {...getUnavailableRowCounters(), ...(rows ?? {})}
  const sampledPeakBytes = getMetricValue(sampledPeakMemoryBytes ?? getPeakMemoryFromPhases(phaseTimings))
  const writerTransactionMetric = getMetricValue(writerTransactionMs)
  const duckdbSpillMetric = getMetricValue(duckdbSpillBytes)
  const warningMetrics = getWarningMetrics(warnings)

  return {
    benchmark: getBenchmarkFields({
      benchmark,
      bytes: byteCounters,
      duckdbSpillBytes: duckdbSpillMetric,
      phases: phaseTimings,
      rows: rowCounters,
      sampledPeakMemoryBytes: sampledPeakBytes,
      warningDetails: warningMetrics.details,
      writerTransactionMs: writerTransactionMetric,
    }),
    bytes: byteCounters,
    duckdb: {spillBytes: duckdbSpillMetric, writerTransactionMs: writerTransactionMetric},
    memory: {sampledPeakBytes},
    operation,
    parser: {usesStreamingParser: false},
    phases: phaseTimings,
    rows: rowCounters,
    version: 1,
    warnings: warningMetrics,
  }
}

const getMergedMetricValue = (left: ProjectTransferMetricValue, right: ProjectTransferMetricValue) => {
  return right === projectTransferMetricUnavailable ? left : right
}

const getMergedPhaseTiming = (
  left: ProjectTransferPerformancePhaseTiming,
  right: ProjectTransferPerformancePhaseTiming,
) => {
  return right.durationMs === projectTransferMetricUnavailable ? left : right
}

const mergeRecordMetrics = <TKey extends string>(
  left: Record<TKey, ProjectTransferMetricValue>,
  right: Partial<Record<TKey, ProjectTransferMetricValue>>,
) => {
  return Object.entries(right).reduce<Record<TKey, ProjectTransferMetricValue>>((merged, [key, value]) => {
    return {...merged, [key]: getMergedMetricValue(merged[key as TKey], value as ProjectTransferMetricValue)}
  }, left)
}

export const mergeProjectTransferPerformanceMetrics = (
  left: ProjectTransferPerformanceMetrics,
  right: ProjectTransferPerformanceMetrics,
): ProjectTransferPerformanceMetrics => {
  const phases = projectTransferPerformancePhases.reduce<
    Record<ProjectTransferPerformancePhase, ProjectTransferPerformancePhaseTiming>
  >(
    (merged, phase) => {
      return {...merged, [phase]: getMergedPhaseTiming(left.phases[phase], right.phases[phase])}
    },
    {} as Record<ProjectTransferPerformancePhase, ProjectTransferPerformancePhaseTiming>,
  )
  const rows = mergeRecordMetrics(left.rows, right.rows)
  const bytes = mergeRecordMetrics(left.bytes, right.bytes)
  const sampledPeakBytes = getMaximumKnownMetric([left.memory.sampledPeakBytes, right.memory.sampledPeakBytes])
  const writerTransactionMs = getMergedMetricValue(left.duckdb.writerTransactionMs, right.duckdb.writerTransactionMs)
  const spillBytes = getMergedMetricValue(left.duckdb.spillBytes, right.duckdb.spillBytes)

  return {
    ...right,
    benchmark: getBenchmarkFields({
      benchmark: {...left.benchmark, ...right.benchmark},
      bytes,
      duckdbSpillBytes: spillBytes,
      phases,
      rows,
      sampledPeakMemoryBytes: sampledPeakBytes,
      warningDetails: right.warnings.details.length > 0 ? right.warnings.details : left.warnings.details,
      writerTransactionMs,
    }),
    bytes,
    duckdb: {spillBytes, writerTransactionMs},
    memory: {sampledPeakBytes},
    phases,
    rows,
    warnings: right.warnings.total > 0 ? right.warnings : left.warnings,
  }
}

export const measureProjectTransferPhase = async <TValue>(
  _phase: ProjectTransferPerformancePhase,
  operation: () => Promise<TValue> | TValue,
): Promise<MeasureProjectTransferPhaseResult<TValue>> => {
  const startedAt = new Date()
  const startedAtMs = performance.now()
  const startedMemory = sampleProjectTransferMemoryBytes()
  const value = await operation()
  const endedMemory = sampleProjectTransferMemoryBytes()

  return {
    timing: {
      durationMs: getRoundedDurationMs(startedAtMs),
      endedAt: new Date().toISOString(),
      sampledPeakMemoryBytes: getMaximumKnownMetric([startedMemory, endedMemory]),
      startedAt: startedAt.toISOString(),
    },
    value,
  }
}
