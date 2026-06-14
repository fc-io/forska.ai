import {Effect} from 'effect'

import {
  admitReviewServingRequest,
  type ReviewServingAdmissionRejectionReason,
  type ReviewServingAdmissionRequest,
  type ReviewServingAdmissionResult,
} from './reviewServingAdmission.ts'
import type {
  NamedReviewFastCountKey,
  ReviewServingReadContractKey,
  ReviewServingSearchMode,
  ReviewServingWorkloadClass,
} from './reviewServingContracts.ts'

export const reviewServingBenchmarkFixtureKinds = ['smoke', 'synthetic10m7PromptOverlap'] as const

export type ReviewServingBenchmarkFixtureKind = (typeof reviewServingBenchmarkFixtureKinds)[number]

export type ReviewServingBenchmarkFixture = {
  articleCount: number
  articlePromptOverlapRows: number
  kind: ReviewServingBenchmarkFixtureKind
  promptCount: number
  requiresCompletedSchemaProjectors: boolean
}

export type ReviewServingBenchmarkWorkloadOperation = {
  contractKey: ReviewServingReadContractKey
  countFilterKeyPrefix?: string
  coverageKeyPrefix?: string
  jobFilterSignaturePrefix?: string
  jobKind?: string
  key: string
  maxRowsScannedPerRequest: number
  minimumDistinctCoverageKeys?: number
  namedCountKey?: NamedReviewFastCountKey
  pageSize: number
  requestCount: number
  searchMode?: ReviewServingSearchMode
  searchTextPrefix?: string
  targetRowsReturnedPerRequest: number
  workloadClass: ReviewServingWorkloadClass
}

export type ReviewServingBenchmarkPerformanceTargets = {
  maxP95LatencyMs: number
  maxP99LatencyMs: number
  maxPeakRssBytes: number
  maxRssGrowthBytes: number
}

export type ReviewServingBenchmarkWorkloadDefinition = {
  fixtureKind: ReviewServingBenchmarkFixtureKind
  key: string
  operations: readonly ReviewServingBenchmarkWorkloadOperation[]
  performanceTargets: ReviewServingBenchmarkPerformanceTargets
  requiredForPhase0: boolean
  releaseGatePhase: 'Phase 5'
}

export type ReviewServingBenchmarkObservation = {
  latencyMs: number
  memoryRssBytes: number
  queueDepth: number
  rowsReturned: number
  rowsScanned: number
  tempUsageBytes: number
}

export type ReviewServingBenchmarkWorkItem = {
  admissionRequest: ReviewServingAdmissionRequest
  coverageKey?: string
  jobFilterSignature?: string
  jobKind?: string
  key: string
  observation: ReviewServingBenchmarkObservation
  operationKey: string
  searchText?: string
}

export type ReviewServingBenchmarkSample = ReviewServingBenchmarkObservation & {
  admissionStatus: ReviewServingAdmissionResult['status']
  contractKey: string
  key: string
  operationKey: string
  rejectionReason: ReviewServingAdmissionRejectionReason | null
}

export type ReviewServingBenchmarkExecutor = (
  workItem: ReviewServingBenchmarkWorkItem,
  admission: Extract<ReviewServingAdmissionResult, {admitted: true}>,
) => Effect.Effect<ReviewServingBenchmarkObservation>

export type ReviewServingBenchmarkLatencyMetrics = {p50Ms: number; p95Ms: number; p99Ms: number; sampleCount: number}

export type ReviewServingBenchmarkMetrics = {
  latency: ReviewServingBenchmarkLatencyMetrics
  memory: {endRssBytes: number; peakRssBytes: number; startRssBytes: number}
  queueDepth: {average: number; peak: number}
  rows: {rowsReturned: number; rowsScanned: number}
  tempUsage: {peakBytes: number; totalBytes: number}
  work: {admitted: number; rejected: number; total: number}
}

export type ReviewServingBenchmarkRunInput = {
  executor?: ReviewServingBenchmarkExecutor
  fixture: ReviewServingBenchmarkFixture
  workload: ReviewServingBenchmarkWorkloadDefinition
  workItems: readonly ReviewServingBenchmarkWorkItem[]
}

export type ReviewServingBenchmarkRunResult = {
  fixture: ReviewServingBenchmarkFixture
  metrics: ReviewServingBenchmarkMetrics
  samples: readonly ReviewServingBenchmarkSample[]
  workload: ReviewServingBenchmarkWorkloadDefinition
}

export type ReviewServingBenchmarkRequestCountViolation = {
  actualRequestCount: number
  expectedRequestCount: number
  operationKey: string
}

export type ReviewServingBenchmarkWorkItemShapeViolation = {
  actual: string | number | null
  expected: string | number | null
  field:
    | 'contractKey'
    | 'countFilterKeyPrefix'
    | 'coverageKeyPrefix'
    | 'jobFilterSignaturePrefix'
    | 'jobKind'
    | 'namedCountKey'
    | 'operationKey'
    | 'pageSize'
    | 'searchMode'
    | 'searchTextPrefix'
    | 'workloadClass'
  key: string
}

export type ReviewServingBenchmarkRowTargetViolation = {
  actualRowsReturned: number
  expectedRowsReturned: number
  key: string
  operationKey: string
}

export type ReviewServingBenchmarkRowsScannedViolation = {
  actualRowsScanned: number
  expectedRowsScanned: number
  key: string
  operationKey: string
}

export type ReviewServingBenchmarkCoverageViolation = {
  actualDistinctCoverageKeys: number
  expectedDistinctCoverageKeys: number
  operationKey: string
}

export type ReviewServingBenchmarkTempSpillViolation = {key: string; operationKey: string; tempUsageBytes: number}

export type ReviewServingBenchmarkPerformanceViolation = {
  actual: number
  expected: number
  metric: 'latency.p95Ms' | 'latency.p99Ms' | 'memory.peakRssBytes' | 'memory.rssGrowthBytes'
}

type ReviewServingBenchmarkRunState = {startedAtMs: number; startRssBytes: number}

const gibibyte = 1024 ** 3

export const reviewServingBenchmarkPhase5PerformanceTargets = {
  maxP95LatencyMs: 2_000,
  maxP99LatencyMs: 5_000,
  maxPeakRssBytes: 20 * gibibyte,
  maxRssGrowthBytes: 4 * gibibyte,
} as const satisfies ReviewServingBenchmarkPerformanceTargets

export const reviewServingSynthetic10m7PromptOverlapFixture = {
  articleCount: 10_000_000,
  articlePromptOverlapRows: 70_000_000,
  kind: 'synthetic10m7PromptOverlap',
  promptCount: 7,
  requiresCompletedSchemaProjectors: true,
} as const satisfies ReviewServingBenchmarkFixture

export const reviewServingBenchmarkSmokeFixture = {
  articleCount: 12,
  articlePromptOverlapRows: 24,
  kind: 'smoke',
  promptCount: 2,
  requiresCompletedSchemaProjectors: false,
} as const satisfies ReviewServingBenchmarkFixture

export const reviewServingBenchmarkOverlapWorkloadDefinition = {
  fixtureKind: 'synthetic10m7PromptOverlap',
  key: 'reviewServing.10m7PromptOverlap.v1',
  operations: [
    {
      contractKey: 'review.llm.rows',
      key: 'llmPromptOverlapRows',
      coverageKeyPrefix: 'page:llm:',
      maxRowsScannedPerRequest: 300,
      minimumDistinctCoverageKeys: 7_000,
      pageSize: 100,
      requestCount: 7_000,
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.both.rows',
      key: 'llmHumanOverlapRows',
      coverageKeyPrefix: 'page:both:',
      maxRowsScannedPerRequest: 300,
      minimumDistinctCoverageKeys: 7_000,
      pageSize: 100,
      requestCount: 7_000,
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.filters.facets',
      coverageKeyPrefix: 'facet:',
      key: 'overlapFacetRefresh',
      maxRowsScannedPerRequest: 512,
      minimumDistinctCoverageKeys: 700,
      pageSize: 128,
      requestCount: 700,
      targetRowsReturnedPerRequest: 128,
      workloadClass: 'foregroundReviewFacet',
    },
    {
      contractKey: 'review.llm.count',
      countFilterKeyPrefix: 'prompt:',
      key: 'llmPromptOverlapCounts',
      maxRowsScannedPerRequest: 8,
      namedCountKey: 'review.llm.assessedByPrompt',
      pageSize: 1,
      requestCount: 700,
      targetRowsReturnedPerRequest: 1,
      workloadClass: 'foregroundReviewCount',
    },
    {
      contractKey: 'review.bulk.selection',
      jobFilterSignaturePrefix: 'phase5-overlap:',
      jobKind: 'review.bulk.selection',
      key: 'bulkOverlapSelectionJob',
      maxRowsScannedPerRequest: 10,
      pageSize: 1,
      requestCount: 70,
      searchMode: 'tokenPrefix',
      targetRowsReturnedPerRequest: 0,
      workloadClass: 'bulkReviewJob',
    },
    {
      contractKey: 'review.export.selection',
      jobFilterSignaturePrefix: 'phase5-overlap:',
      jobKind: 'review.export.selection',
      key: 'exportOverlapSelectionJob',
      maxRowsScannedPerRequest: 10,
      pageSize: 1,
      requestCount: 70,
      searchMode: 'tokenPrefix',
      targetRowsReturnedPerRequest: 0,
      workloadClass: 'bulkReviewJob',
    },
    {
      contractKey: 'review.pdf.selection',
      jobFilterSignaturePrefix: 'phase5-overlap:',
      jobKind: 'review.pdf.selection',
      key: 'pdfOverlapSelectionJob',
      maxRowsScannedPerRequest: 10,
      pageSize: 1,
      requestCount: 70,
      searchMode: 'tokenPrefix',
      targetRowsReturnedPerRequest: 0,
      workloadClass: 'bulkReviewJob',
    },
    {
      contractKey: 'review.search.substringAsync',
      jobFilterSignaturePrefix: 'phase5-overlap:',
      key: 'substringOverlapSearchJob',
      maxRowsScannedPerRequest: 10,
      pageSize: 1,
      requestCount: 70,
      searchMode: 'substringAsync',
      searchTextPrefix: 'overlap ',
      targetRowsReturnedPerRequest: 0,
      workloadClass: 'bulkReviewJob',
    },
    {
      contractKey: 'review.queue.unassessed',
      coverageKeyPrefix: 'queue:',
      key: 'unassessedOverlapQueue',
      maxRowsScannedPerRequest: 300,
      minimumDistinctCoverageKeys: 700,
      pageSize: 100,
      requestCount: 700,
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewQueue',
    },
    {
      contractKey: 'review.search.tokenPrefix',
      coverageKeyPrefix: 'tokenPrefix:',
      key: 'titlePrefixOverlapSearch',
      maxRowsScannedPerRequest: 150,
      minimumDistinctCoverageKeys: 700,
      pageSize: 50,
      requestCount: 700,
      targetRowsReturnedPerRequest: 50,
      workloadClass: 'foregroundReviewSearch',
    },
  ],
  performanceTargets: reviewServingBenchmarkPhase5PerformanceTargets,
  releaseGatePhase: 'Phase 5',
  requiredForPhase0: false,
} as const satisfies ReviewServingBenchmarkWorkloadDefinition

export const reviewServingBenchmarkPhase5ReleaseGate = {
  fixtureKind: reviewServingSynthetic10m7PromptOverlapFixture.kind,
  requiredForPhase0: false,
  releaseGatePhase: 'Phase 5',
  workloadKey: reviewServingBenchmarkOverlapWorkloadDefinition.key,
} as const

export const sampleReviewServingBenchmarkMemoryRssBytes = () => {
  return typeof process.memoryUsage === 'function' ? process.memoryUsage().rss : 0
}

const getPercentileMetric = (values: readonly number[], percentile: number) => {
  const sortedValues = [...values].sort((left, right) => {
    return left - right
  })
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * percentile) - 1))

  return sortedValues.length === 0 ? 0 : (sortedValues[index] ?? 0)
}

const getTotal = (values: readonly number[]) => {
  return values.reduce((total, value) => {
    return total + value
  }, 0)
}

const getPeak = (values: readonly number[]) => {
  return values.length === 0 ? 0 : Math.max(...values)
}

const getAverage = (values: readonly number[]) => {
  return values.length === 0 ? 0 : Number((getTotal(values) / values.length).toFixed(2))
}

const getObservationValues = (
  samples: readonly ReviewServingBenchmarkSample[],
  getValue: (sample: ReviewServingBenchmarkSample) => number,
) => {
  return samples.map((sample) => {
    return getValue(sample)
  })
}

const getWorkMetrics = (samples: readonly ReviewServingBenchmarkSample[]) => {
  const admitted = samples.filter((sample) => {
    return sample.admissionStatus === 'accepted'
  }).length
  const rejected = samples.length - admitted

  return {admitted, rejected, total: samples.length}
}

const getBenchmarkRunState = () => {
  return Effect.sync<ReviewServingBenchmarkRunState>(() => {
    return {startedAtMs: performance.now(), startRssBytes: sampleReviewServingBenchmarkMemoryRssBytes()}
  })
}

export const getReviewServingBenchmarkRequestCountViolations = (
  input: Pick<ReviewServingBenchmarkRunInput, 'workItems' | 'workload'>,
) => {
  const matchingWorkItems = input.workItems.filter((workItem) => {
    return getReviewServingBenchmarkWorkItemShapeViolations(input, workItem).length === 0
  })
  const actualRequestCounts = matchingWorkItems.reduce<Record<string, number>>((counts, workItem) => {
    return {...counts, [workItem.operationKey]: (counts[workItem.operationKey] ?? 0) + 1}
  }, {})
  const workloadOperationKeys = new Set(
    input.workload.operations.map((operation) => {
      return operation.key
    }),
  )
  const workloadViolations = input.workload.operations
    .filter((operation) => {
      return (actualRequestCounts[operation.key] ?? 0) !== operation.requestCount
    })
    .map((operation) => {
      return {
        actualRequestCount: actualRequestCounts[operation.key] ?? 0,
        expectedRequestCount: operation.requestCount,
        operationKey: operation.key,
      }
    })
  const unknownWorkItemViolations = Object.entries(actualRequestCounts)
    .filter(([operationKey]) => {
      return !workloadOperationKeys.has(operationKey)
    })
    .map(([operationKey, actualRequestCount]) => {
      return {actualRequestCount, expectedRequestCount: 0, operationKey}
    })

  return [...workloadViolations, ...unknownWorkItemViolations]
}

const getReviewServingBenchmarkOperationByKey = (
  input: Pick<ReviewServingBenchmarkRunInput, 'workload'>,
  operationKey: string,
) => {
  return input.workload.operations.find((operation) => {
    return operation.key === operationKey
  })
}

export const getReviewServingBenchmarkWorkItemShapeViolations = (
  input: Pick<ReviewServingBenchmarkRunInput, 'workload'>,
  workItem: ReviewServingBenchmarkWorkItem,
): ReviewServingBenchmarkWorkItemShapeViolation[] => {
  const operation = getReviewServingBenchmarkOperationByKey(input, workItem.operationKey)

  if (!operation) {
    return [{actual: workItem.operationKey, expected: null, field: 'operationKey', key: workItem.key}]
  }

  const exactShapeEntries: ReadonlyArray<
    [ReviewServingBenchmarkWorkItemShapeViolation['field'], string | number | null, string | number | null]
  > = [
    ['contractKey', workItem.admissionRequest.contractKey, operation.contractKey],
    ['pageSize', workItem.admissionRequest.pageSize ?? null, operation.pageSize],
    ['workloadClass', workItem.admissionRequest.workloadClass, operation.workloadClass],
    ['namedCountKey', workItem.admissionRequest.namedCountKey ?? null, operation.namedCountKey ?? null],
    ['jobKind', workItem.jobKind ?? null, operation.jobKind ?? null],
    ['searchMode', workItem.admissionRequest.searchMode ?? null, operation.searchMode ?? null],
  ]

  const prefixShapeEntries: ReadonlyArray<
    [ReviewServingBenchmarkWorkItemShapeViolation['field'], string | null, string | undefined]
  > = [
    ['countFilterKeyPrefix', workItem.admissionRequest.countFilterKey ?? null, operation.countFilterKeyPrefix],
    ['coverageKeyPrefix', workItem.coverageKey ?? null, operation.coverageKeyPrefix],
    ['jobFilterSignaturePrefix', workItem.jobFilterSignature ?? null, operation.jobFilterSignaturePrefix],
    ['searchTextPrefix', workItem.searchText ?? null, operation.searchTextPrefix],
  ]
  const exactViolations: ReviewServingBenchmarkWorkItemShapeViolation[] = exactShapeEntries
    .filter(([_field, _actual, expected]) => {
      return expected !== null
    })
    .map(([field, actual, expected]) => {
      return {actual, expected, field, key: workItem.key}
    })
    .filter((violation) => {
      return violation.actual !== violation.expected
    })
  const prefixViolations: ReviewServingBenchmarkWorkItemShapeViolation[] = prefixShapeEntries
    .filter(([_field, _actual, expected]) => {
      return expected !== undefined
    })
    .map(([field, actual, expected]) => {
      return {actual, expected: `${expected}*`, field, key: workItem.key}
    })
    .filter((violation) => {
      return (
        typeof violation.actual !== 'string' || !violation.actual.startsWith(String(violation.expected).slice(0, -1))
      )
    })

  return [...exactViolations, ...prefixViolations]
}

export const getReviewServingBenchmarkCoverageViolations = (
  input: Pick<ReviewServingBenchmarkRunInput, 'workItems' | 'workload'>,
) => {
  return input.workload.operations
    .map((operation) => {
      const expectedDistinctCoverageKeys = operation.minimumDistinctCoverageKeys ?? 0
      const matchingCoverageKeys = input.workItems
        .filter((workItem) => {
          return (
            workItem.operationKey === operation.key
            && getReviewServingBenchmarkWorkItemShapeViolations(input, workItem).length === 0
          )
        })
        .map((workItem) => {
          return workItem.coverageKey ?? null
        })
        .filter((coverageKey): coverageKey is string => {
          return coverageKey !== null
        })
      const actualDistinctCoverageKeys = new Set(matchingCoverageKeys).size

      return expectedDistinctCoverageKeys > 0 && actualDistinctCoverageKeys < expectedDistinctCoverageKeys
        ? {actualDistinctCoverageKeys, expectedDistinctCoverageKeys, operationKey: operation.key}
        : null
    })
    .filter((violation): violation is ReviewServingBenchmarkCoverageViolation => {
      return violation !== null
    })
}

const getReviewServingBenchmarkCoverageViolationMessage = (
  violations: readonly ReviewServingBenchmarkCoverageViolation[],
) => {
  return violations
    .map((violation) => {
      return `${violation.operationKey}: expected ${violation.expectedDistinctCoverageKeys} distinct coverage keys, got ${violation.actualDistinctCoverageKeys}`
    })
    .join('; ')
}

const getReviewServingBenchmarkWorkItemShapeViolationMessage = (
  violations: readonly ReviewServingBenchmarkWorkItemShapeViolation[],
) => {
  return violations
    .map((violation) => {
      return `${violation.key}.${violation.field}: expected ${violation.expected}, got ${violation.actual}`
    })
    .join('; ')
}

export const getReviewServingBenchmarkRowTargetViolations = (
  input: Pick<ReviewServingBenchmarkRunInput, 'workload'>,
  samples: readonly ReviewServingBenchmarkSample[],
) => {
  return samples
    .map((sample) => {
      const operation = getReviewServingBenchmarkOperationByKey(input, sample.operationKey)

      return operation && sample.rowsReturned < operation.targetRowsReturnedPerRequest
        ? {
            actualRowsReturned: sample.rowsReturned,
            expectedRowsReturned: operation.targetRowsReturnedPerRequest,
            key: sample.key,
            operationKey: sample.operationKey,
          }
        : null
    })
    .filter((violation): violation is ReviewServingBenchmarkRowTargetViolation => {
      return violation !== null
    })
}

export const getReviewServingBenchmarkRowsScannedViolations = (
  input: Pick<ReviewServingBenchmarkRunInput, 'workload'>,
  samples: readonly ReviewServingBenchmarkSample[],
) => {
  return samples
    .map((sample) => {
      const operation = getReviewServingBenchmarkOperationByKey(input, sample.operationKey)

      return operation && sample.rowsScanned > operation.maxRowsScannedPerRequest
        ? {
            actualRowsScanned: sample.rowsScanned,
            expectedRowsScanned: operation.maxRowsScannedPerRequest,
            key: sample.key,
            operationKey: sample.operationKey,
          }
        : null
    })
    .filter((violation): violation is ReviewServingBenchmarkRowsScannedViolation => {
      return violation !== null
    })
}

const getReviewServingBenchmarkRowsScannedViolationMessage = (
  violations: readonly ReviewServingBenchmarkRowsScannedViolation[],
) => {
  return violations
    .map((violation) => {
      return `${violation.key}.${violation.operationKey}: expected <= ${violation.expectedRowsScanned}, got ${violation.actualRowsScanned}`
    })
    .join('; ')
}

const getReviewServingBenchmarkRowTargetViolationMessage = (
  violations: readonly ReviewServingBenchmarkRowTargetViolation[],
) => {
  return violations
    .map((violation) => {
      return `${violation.key}.${violation.operationKey}: expected ${violation.expectedRowsReturned}, got ${violation.actualRowsReturned}`
    })
    .join('; ')
}

export const getReviewServingBenchmarkTempSpillViolations = (samples: readonly ReviewServingBenchmarkSample[]) => {
  return samples
    .filter((sample) => {
      return sample.admissionStatus === 'accepted' && sample.tempUsageBytes > 0
    })
    .map((sample) => {
      return {key: sample.key, operationKey: sample.operationKey, tempUsageBytes: sample.tempUsageBytes}
    })
}

const getReviewServingBenchmarkTempSpillViolationMessage = (
  violations: readonly ReviewServingBenchmarkTempSpillViolation[],
) => {
  return violations
    .map((violation) => {
      return `${violation.key}.${violation.operationKey}: temp spill ${violation.tempUsageBytes}`
    })
    .join('; ')
}

export const getReviewServingBenchmarkPerformanceViolations = (
  metrics: ReviewServingBenchmarkMetrics,
  targets: ReviewServingBenchmarkPerformanceTargets,
) => {
  const rssGrowthBytes = metrics.memory.peakRssBytes - metrics.memory.startRssBytes

  return [
    {actual: metrics.latency.p95Ms, expected: targets.maxP95LatencyMs, metric: 'latency.p95Ms' as const},
    {actual: metrics.latency.p99Ms, expected: targets.maxP99LatencyMs, metric: 'latency.p99Ms' as const},
    {actual: metrics.memory.peakRssBytes, expected: targets.maxPeakRssBytes, metric: 'memory.peakRssBytes' as const},
    {actual: rssGrowthBytes, expected: targets.maxRssGrowthBytes, metric: 'memory.rssGrowthBytes' as const},
  ].filter((violation) => {
    return violation.actual > violation.expected
  })
}

const getReviewServingBenchmarkPerformanceViolationMessage = (
  violations: readonly ReviewServingBenchmarkPerformanceViolation[],
) => {
  return violations
    .map((violation) => {
      return `${violation.metric}: expected <= ${violation.expected}, got ${violation.actual}`
    })
    .join('; ')
}

const getExpectedReviewServingBenchmarkFixture = (fixtureKind: ReviewServingBenchmarkFixtureKind) => {
  return fixtureKind === 'synthetic10m7PromptOverlap'
    ? reviewServingSynthetic10m7PromptOverlapFixture
    : reviewServingBenchmarkSmokeFixture
}

const getReviewServingBenchmarkFixtureMismatch = (input: ReviewServingBenchmarkRunInput) => {
  const expectedFixture = getExpectedReviewServingBenchmarkFixture(input.workload.fixtureKind)

  return input.fixture.articleCount !== expectedFixture.articleCount
    || input.fixture.articlePromptOverlapRows !== expectedFixture.articlePromptOverlapRows
    || input.fixture.kind !== expectedFixture.kind
    || input.fixture.promptCount !== expectedFixture.promptCount
    || input.fixture.requiresCompletedSchemaProjectors !== expectedFixture.requiresCompletedSchemaProjectors
    ? `expected ${JSON.stringify(expectedFixture)}, got ${JSON.stringify(input.fixture)}`
    : null
}

const isReviewServingBenchmarkOperationMatch = (
  operation: ReviewServingBenchmarkWorkloadOperation,
  expectedOperation: ReviewServingBenchmarkWorkloadOperation | undefined,
) => {
  return (
    expectedOperation !== undefined
    && operation.contractKey === expectedOperation.contractKey
    && operation.countFilterKeyPrefix === expectedOperation.countFilterKeyPrefix
    && operation.coverageKeyPrefix === expectedOperation.coverageKeyPrefix
    && operation.jobFilterSignaturePrefix === expectedOperation.jobFilterSignaturePrefix
    && operation.jobKind === expectedOperation.jobKind
    && operation.key === expectedOperation.key
    && operation.maxRowsScannedPerRequest === expectedOperation.maxRowsScannedPerRequest
    && operation.minimumDistinctCoverageKeys === expectedOperation.minimumDistinctCoverageKeys
    && operation.namedCountKey === expectedOperation.namedCountKey
    && operation.pageSize === expectedOperation.pageSize
    && operation.requestCount === expectedOperation.requestCount
    && operation.searchMode === expectedOperation.searchMode
    && operation.searchTextPrefix === expectedOperation.searchTextPrefix
    && operation.targetRowsReturnedPerRequest === expectedOperation.targetRowsReturnedPerRequest
    && operation.workloadClass === expectedOperation.workloadClass
  )
}

const isReviewServingBenchmarkPerformanceTargetMatch = (
  targets: ReviewServingBenchmarkPerformanceTargets,
  expectedTargets: ReviewServingBenchmarkPerformanceTargets,
) => {
  return (
    targets.maxP95LatencyMs === expectedTargets.maxP95LatencyMs
    && targets.maxP99LatencyMs === expectedTargets.maxP99LatencyMs
    && targets.maxPeakRssBytes === expectedTargets.maxPeakRssBytes
    && targets.maxRssGrowthBytes === expectedTargets.maxRssGrowthBytes
  )
}

const getReviewServingBenchmarkWorkloadMismatch = (input: ReviewServingBenchmarkRunInput) => {
  if (input.workload.fixtureKind !== reviewServingSynthetic10m7PromptOverlapFixture.kind) {
    return null
  }

  const expectedWorkload = reviewServingBenchmarkOverlapWorkloadDefinition
  const operationsMatch =
    input.workload.operations.length === expectedWorkload.operations.length
    && input.workload.operations.every((operation, index) => {
      return isReviewServingBenchmarkOperationMatch(operation, expectedWorkload.operations[index])
    })
  const workloadMatches =
    input.workload.fixtureKind === expectedWorkload.fixtureKind
    && input.workload.key === expectedWorkload.key
    && isReviewServingBenchmarkPerformanceTargetMatch(
      input.workload.performanceTargets,
      expectedWorkload.performanceTargets,
    )
    && input.workload.releaseGatePhase === expectedWorkload.releaseGatePhase
    && input.workload.requiredForPhase0 === expectedWorkload.requiredForPhase0
    && operationsMatch

  return workloadMatches ? null : `expected ${JSON.stringify(expectedWorkload)}, got ${JSON.stringify(input.workload)}`
}

const validateReviewServingBenchmarkRequestCounts = (input: ReviewServingBenchmarkRunInput) => {
  const shapeViolations = input.workItems.flatMap((workItem) => {
    return getReviewServingBenchmarkWorkItemShapeViolations(input, workItem)
  })
  const violations = getReviewServingBenchmarkRequestCountViolations(input)
  const coverageViolations = getReviewServingBenchmarkCoverageViolations(input)
  const fixtureMismatch = getReviewServingBenchmarkFixtureMismatch(input)
  const workloadMismatch = getReviewServingBenchmarkWorkloadMismatch(input)
  const message = violations
    .map((violation) => {
      return `${violation.operationKey}: expected ${violation.expectedRequestCount}, got ${violation.actualRequestCount}`
    })
    .join('; ')

  if (fixtureMismatch) {
    return Effect.fail(new Error(`Review-serving benchmark fixture mismatch: ${fixtureMismatch}`))
  }

  if (workloadMismatch) {
    return Effect.fail(new Error(`Review-serving benchmark workload mismatch: ${workloadMismatch}`))
  }

  if (shapeViolations.length > 0) {
    return Effect.fail(
      new Error(
        `Review-serving benchmark work item mismatch: ${getReviewServingBenchmarkWorkItemShapeViolationMessage(shapeViolations)}`,
      ),
    )
  }

  if (violations.length > 0) {
    return Effect.fail(new Error(`Review-serving benchmark request count mismatch: ${message}`))
  }

  return coverageViolations.length === 0
    ? Effect.void
    : Effect.fail(
        new Error(
          `Review-serving benchmark coverage mismatch: ${getReviewServingBenchmarkCoverageViolationMessage(coverageViolations)}`,
        ),
      )
}

const validateReviewServingBenchmarkRowTargets = (
  input: ReviewServingBenchmarkRunInput,
  samples: readonly ReviewServingBenchmarkSample[],
) => {
  const violations = getReviewServingBenchmarkRowTargetViolations(input, samples)

  return violations.length === 0
    ? Effect.void
    : Effect.fail(
        new Error(
          `Review-serving benchmark row target mismatch: ${getReviewServingBenchmarkRowTargetViolationMessage(violations)}`,
        ),
      )
}

const validateReviewServingBenchmarkRowsScanned = (
  input: ReviewServingBenchmarkRunInput,
  samples: readonly ReviewServingBenchmarkSample[],
) => {
  const violations = getReviewServingBenchmarkRowsScannedViolations(input, samples)

  return violations.length === 0
    ? Effect.void
    : Effect.fail(
        new Error(
          `Review-serving benchmark rows scanned mismatch: ${getReviewServingBenchmarkRowsScannedViolationMessage(violations)}`,
        ),
      )
}

const validateReviewServingBenchmarkTempSpill = (samples: readonly ReviewServingBenchmarkSample[]) => {
  const violations = getReviewServingBenchmarkTempSpillViolations(samples)

  return violations.length === 0
    ? Effect.void
    : Effect.fail(
        new Error(
          `Review-serving benchmark temp spill mismatch: ${getReviewServingBenchmarkTempSpillViolationMessage(violations)}`,
        ),
      )
}

const validateReviewServingBenchmarkPerformanceTargets = (
  metrics: ReviewServingBenchmarkMetrics,
  targets: ReviewServingBenchmarkPerformanceTargets,
) => {
  const violations = getReviewServingBenchmarkPerformanceViolations(metrics, targets)

  return violations.length === 0
    ? Effect.void
    : Effect.fail(
        new Error(
          `Review-serving benchmark performance target mismatch: ${getReviewServingBenchmarkPerformanceViolationMessage(violations)}`,
        ),
      )
}

const releaseBenchmarkRunState = (_state: ReviewServingBenchmarkRunState) => {
  return Effect.void
}

const getDefaultBenchmarkObservation = (workItem: ReviewServingBenchmarkWorkItem) => {
  return Effect.sync(() => {
    return workItem.observation
  })
}

const getBenchmarkSample = ({
  admission,
  observation,
  workItem,
}: {
  admission: ReviewServingAdmissionResult
  observation: ReviewServingBenchmarkObservation
  workItem: ReviewServingBenchmarkWorkItem
}): ReviewServingBenchmarkSample => {
  return {
    ...observation,
    admissionStatus: admission.status,
    contractKey: workItem.admissionRequest.contractKey,
    key: workItem.key,
    operationKey: workItem.operationKey,
    rejectionReason: admission.admitted ? null : admission.reason,
  }
}

const runBenchmarkWorkItemEffect = (
  workItem: ReviewServingBenchmarkWorkItem,
  executor: ReviewServingBenchmarkExecutor,
) => {
  return Effect.gen(function* () {
    const admission = admitReviewServingRequest(workItem.admissionRequest)
    if (!admission.admitted) {
      return yield* Effect.fail(
        new Error(`Review-serving benchmark admission rejected for ${workItem.key}: ${admission.reason}`),
      )
    }

    const observation = yield* executor(workItem, admission)

    return getBenchmarkSample({admission, observation, workItem})
  })
}

export const getReviewServingBenchmarkMetrics = ({
  endRssBytes,
  samples,
  startRssBytes,
}: {
  endRssBytes: number
  samples: readonly ReviewServingBenchmarkSample[]
  startRssBytes: number
}): ReviewServingBenchmarkMetrics => {
  const latencyValues = getObservationValues(samples, (sample) => {
    return sample.latencyMs
  })
  const memoryValues = [
    startRssBytes,
    endRssBytes,
    ...getObservationValues(samples, (sample) => {
      return sample.memoryRssBytes
    }),
  ]
  const queueDepthValues = getObservationValues(samples, (sample) => {
    return sample.queueDepth
  })
  const tempUsageValues = getObservationValues(samples, (sample) => {
    return sample.tempUsageBytes
  })
  const rowsScannedValues = getObservationValues(samples, (sample) => {
    return sample.rowsScanned
  })
  const rowsReturnedValues = getObservationValues(samples, (sample) => {
    return sample.rowsReturned
  })

  return {
    latency: {
      p50Ms: getPercentileMetric(latencyValues, 0.5),
      p95Ms: getPercentileMetric(latencyValues, 0.95),
      p99Ms: getPercentileMetric(latencyValues, 0.99),
      sampleCount: samples.length,
    },
    memory: {endRssBytes, peakRssBytes: getPeak(memoryValues), startRssBytes},
    queueDepth: {average: getAverage(queueDepthValues), peak: getPeak(queueDepthValues)},
    rows: {rowsReturned: getTotal(rowsReturnedValues), rowsScanned: getTotal(rowsScannedValues)},
    tempUsage: {peakBytes: getPeak(tempUsageValues), totalBytes: getTotal(tempUsageValues)},
    work: getWorkMetrics(samples),
  }
}

export const getReviewServingBenchmarkSmokeInput = (): ReviewServingBenchmarkRunInput => {
  return {
    fixture: reviewServingBenchmarkSmokeFixture,
    workload: {
      ...reviewServingBenchmarkOverlapWorkloadDefinition,
      fixtureKind: 'smoke',
      key: 'reviewServing.smokeOverlap.v1',
      operations: [
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[0],
          minimumDistinctCoverageKeys: 1,
          pageSize: 12,
          requestCount: 1,
          targetRowsReturnedPerRequest: 12,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[1],
          minimumDistinctCoverageKeys: 1,
          pageSize: 10,
          requestCount: 1,
          targetRowsReturnedPerRequest: 10,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[2],
          minimumDistinctCoverageKeys: 1,
          pageSize: 16,
          requestCount: 1,
          targetRowsReturnedPerRequest: 16,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[3],
          pageSize: 1,
          requestCount: 1,
          targetRowsReturnedPerRequest: 1,
        },
        {...reviewServingBenchmarkOverlapWorkloadDefinition.operations[4], requestCount: 1},
        {...reviewServingBenchmarkOverlapWorkloadDefinition.operations[5], requestCount: 1},
        {...reviewServingBenchmarkOverlapWorkloadDefinition.operations[6], requestCount: 1},
        {...reviewServingBenchmarkOverlapWorkloadDefinition.operations[7], requestCount: 1},
      ],
    },
    workItems: [
      {
        admissionRequest: {
          contractKey: 'review.llm.rows',
          estimatedResultBytes: 12_000,
          estimatedResultRows: 12,
          pageSize: 12,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        coverageKey: 'page:llm:smoke-first',
        key: 'smoke-llm-page',
        observation: {
          latencyMs: 8,
          memoryRssBytes: 128_000_000,
          queueDepth: 1,
          rowsReturned: 12,
          rowsScanned: 24,
          tempUsageBytes: 0,
        },
        operationKey: 'llmPromptOverlapRows',
      },
      {
        admissionRequest: {
          contractKey: 'review.both.rows',
          estimatedResultBytes: 10_000,
          estimatedResultRows: 10,
          pageSize: 10,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        coverageKey: 'page:both:smoke-first',
        key: 'smoke-both-page',
        observation: {
          latencyMs: 12,
          memoryRssBytes: 129_000_000,
          queueDepth: 2,
          rowsReturned: 10,
          rowsScanned: 30,
          tempUsageBytes: 0,
        },
        operationKey: 'llmHumanOverlapRows',
      },
      {
        admissionRequest: {
          contractKey: 'review.filters.facets',
          estimatedResultBytes: 4_000,
          estimatedResultRows: 16,
          pageSize: 16,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewFacet',
        },
        coverageKey: 'facet:smoke-first',
        key: 'smoke-facet',
        observation: {
          latencyMs: 20,
          memoryRssBytes: 130_000_000,
          queueDepth: 3,
          rowsReturned: 16,
          rowsScanned: 48,
          tempUsageBytes: 0,
        },
        operationKey: 'overlapFacetRefresh',
      },
      {
        admissionRequest: {
          contractKey: 'review.llm.count',
          countFilterKey: 'prompt:1',
          countState: {
            availability: 'ready',
            filterKey: 'prompt:1',
            key: 'review.llm.assessedByPrompt',
            snapshotId: 'smoke-snapshot',
            value: 10,
          },
          estimatedResultBytes: 1_000,
          estimatedResultRows: 1,
          namedCountKey: 'review.llm.assessedByPrompt',
          pageSize: 1,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewCount',
        },
        key: 'smoke-llm-count',
        observation: {
          latencyMs: 6,
          memoryRssBytes: 128_500_000,
          queueDepth: 1,
          rowsReturned: 1,
          rowsScanned: 1,
          tempUsageBytes: 0,
        },
        operationKey: 'llmPromptOverlapCounts',
      },
      {
        admissionRequest: {
          contractKey: 'review.bulk.selection',
          estimatedResultBytes: 1_000,
          estimatedResultRows: 0,
          pageSize: 1,
          projectId: 'smoke-project',
          searchMode: 'tokenPrefix',
          searchState: {availability: 'ready', snapshotId: 'smoke-snapshot'},
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'bulkReviewJob',
        },
        jobFilterSignature: 'phase5-overlap:bulk:smoke',
        jobKind: 'review.bulk.selection',
        key: 'smoke-bulk-selection-job',
        observation: {
          latencyMs: 5,
          memoryRssBytes: 128_250_000,
          queueDepth: 0,
          rowsReturned: 0,
          rowsScanned: 1,
          tempUsageBytes: 0,
        },
        operationKey: 'bulkOverlapSelectionJob',
      },
      {
        admissionRequest: {
          contractKey: 'review.export.selection',
          estimatedResultBytes: 1_000,
          estimatedResultRows: 0,
          pageSize: 1,
          projectId: 'smoke-project',
          searchMode: 'tokenPrefix',
          searchState: {availability: 'ready', snapshotId: 'smoke-snapshot'},
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'bulkReviewJob',
        },
        jobFilterSignature: 'phase5-overlap:export:smoke',
        jobKind: 'review.export.selection',
        key: 'smoke-export-selection-job',
        observation: {
          latencyMs: 7,
          memoryRssBytes: 128_300_000,
          queueDepth: 0,
          rowsReturned: 0,
          rowsScanned: 1,
          tempUsageBytes: 0,
        },
        operationKey: 'exportOverlapSelectionJob',
      },
      {
        admissionRequest: {
          contractKey: 'review.pdf.selection',
          estimatedResultBytes: 1_000,
          estimatedResultRows: 0,
          pageSize: 1,
          projectId: 'smoke-project',
          searchMode: 'tokenPrefix',
          searchState: {availability: 'ready', snapshotId: 'smoke-snapshot'},
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'bulkReviewJob',
        },
        jobFilterSignature: 'phase5-overlap:pdf:smoke',
        jobKind: 'review.pdf.selection',
        key: 'smoke-pdf-selection-job',
        observation: {
          latencyMs: 9,
          memoryRssBytes: 128_350_000,
          queueDepth: 0,
          rowsReturned: 0,
          rowsScanned: 1,
          tempUsageBytes: 0,
        },
        operationKey: 'pdfOverlapSelectionJob',
      },
      {
        admissionRequest: {
          contractKey: 'review.search.substringAsync',
          estimatedResultBytes: 1_000,
          estimatedResultRows: 0,
          pageSize: 1,
          projectId: 'smoke-project',
          searchMode: 'substringAsync',
          snapshotFreshness: 'unavailable',
          workloadClass: 'bulkReviewJob',
        },
        jobFilterSignature: 'phase5-overlap:substring:smoke',
        key: 'smoke-substring-search-job',
        observation: {
          latencyMs: 11,
          memoryRssBytes: 128_400_000,
          queueDepth: 0,
          rowsReturned: 0,
          rowsScanned: 1,
          tempUsageBytes: 0,
        },
        operationKey: 'substringOverlapSearchJob',
        searchText: 'overlap smoke',
      },
    ],
  }
}

export const runReviewServingBenchmarkEffect = (input: ReviewServingBenchmarkRunInput) => {
  const executor = input.executor ?? getDefaultBenchmarkObservation

  return Effect.scoped(
    Effect.gen(function* () {
      yield* validateReviewServingBenchmarkRequestCounts(input)
      const runState = yield* Effect.acquireRelease(getBenchmarkRunState(), releaseBenchmarkRunState)
      const samples = yield* Effect.forEach(input.workItems, (workItem) => {
        return runBenchmarkWorkItemEffect(workItem, executor)
      })
      yield* validateReviewServingBenchmarkRowTargets(input, samples)
      yield* validateReviewServingBenchmarkRowsScanned(input, samples)
      yield* validateReviewServingBenchmarkTempSpill(samples)
      const endRssBytes = sampleReviewServingBenchmarkMemoryRssBytes()
      const metrics = getReviewServingBenchmarkMetrics({endRssBytes, samples, startRssBytes: runState.startRssBytes})
      yield* validateReviewServingBenchmarkPerformanceTargets(metrics, input.workload.performanceTargets)

      return {fixture: input.fixture, metrics, samples, workload: input.workload}
    }),
  )
}

export const runReviewServingBenchmarkSmoke = () => {
  return Effect.runPromise(runReviewServingBenchmarkEffect(getReviewServingBenchmarkSmokeInput()))
}
