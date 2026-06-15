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
export const reviewServingBenchmarkRequestSliceFields = [
  'cursor',
  'filter',
  'listMode',
  'queueKind',
  'searchTokenPrefix',
] as const

export type ReviewServingBenchmarkFixtureKind = (typeof reviewServingBenchmarkFixtureKinds)[number]
export type ReviewServingBenchmarkRequestSliceField = (typeof reviewServingBenchmarkRequestSliceFields)[number]

export type ReviewServingBenchmarkRequestSlice = Partial<Record<ReviewServingBenchmarkRequestSliceField, string>>

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
  jobFilterSignaturePrefix?: string
  jobKind?: string
  key: string
  maxRowsScannedPerRequest: number
  minimumDistinctRequestSlices?: number
  namedCountKey?: NamedReviewFastCountKey
  pageSize: number
  requestCount: number
  requestSliceFields?: readonly ReviewServingBenchmarkRequestSliceField[]
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
  cursor?: string
  filterSignature?: string
  jobFilterSignature?: string
  jobKind?: string
  key: string
  listMode?: string
  observation: ReviewServingBenchmarkObservation
  operationKey: string
  queueKind?: string
  requestSlice?: ReviewServingBenchmarkRequestSlice
  searchText?: string
  searchTokenPrefix?: string
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
    | 'jobFilterSignaturePrefix'
    | 'jobKind'
    | 'namedCountKey'
    | 'operationKey'
    | 'pageSize'
    | 'requestSlice'
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

export type ReviewServingBenchmarkRowsReturnedLimitViolation = {
  actualRowsReturned: number
  expectedMaxRowsReturned: number
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
  operationKey?: string
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
      maxRowsScannedPerRequest: 300,
      minimumDistinctRequestSlices: 7_000,
      pageSize: 100,
      requestCount: 7_000,
      requestSliceFields: ['cursor'],
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.human.rows',
      key: 'humanPromptOverlapRows',
      maxRowsScannedPerRequest: 300,
      minimumDistinctRequestSlices: 7_000,
      pageSize: 100,
      requestCount: 7_000,
      requestSliceFields: ['cursor'],
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.both.rows',
      key: 'llmHumanOverlapRows',
      maxRowsScannedPerRequest: 300,
      minimumDistinctRequestSlices: 7_000,
      pageSize: 100,
      requestCount: 7_000,
      requestSliceFields: ['cursor'],
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.unassessed.rows',
      key: 'unassessedOverlapRows',
      maxRowsScannedPerRequest: 300,
      minimumDistinctRequestSlices: 700,
      pageSize: 100,
      requestCount: 700,
      requestSliceFields: ['cursor'],
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.filters.postings',
      key: 'filteredOverlapRows',
      maxRowsScannedPerRequest: 300,
      minimumDistinctRequestSlices: 7_000,
      pageSize: 100,
      requestCount: 7_000,
      requestSliceFields: ['cursor', 'filter', 'listMode', 'searchTokenPrefix'],
      searchMode: 'tokenPrefix',
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.llm.rowsByArticleSet',
      key: 'filteredLlmRowsByArticleSet',
      maxRowsScannedPerRequest: 100,
      minimumDistinctRequestSlices: 7_000,
      pageSize: 100,
      requestCount: 7_000,
      requestSliceFields: ['filter', 'listMode'],
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.human.rowsByArticleSet',
      key: 'filteredHumanRowsByArticleSet',
      maxRowsScannedPerRequest: 100,
      minimumDistinctRequestSlices: 7_000,
      pageSize: 100,
      requestCount: 7_000,
      requestSliceFields: ['filter', 'listMode'],
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.both.rowsByArticleSet',
      key: 'filteredBothRowsByArticleSet',
      maxRowsScannedPerRequest: 100,
      minimumDistinctRequestSlices: 7_000,
      pageSize: 100,
      requestCount: 7_000,
      requestSliceFields: ['filter', 'listMode'],
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.unassessed.rowsByArticleSet',
      key: 'filteredUnassessedRowsByArticleSet',
      maxRowsScannedPerRequest: 100,
      minimumDistinctRequestSlices: 700,
      pageSize: 100,
      requestCount: 700,
      requestSliceFields: ['filter', 'listMode'],
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.filters.facets',
      key: 'overlapFacetRefresh',
      maxRowsScannedPerRequest: 512,
      minimumDistinctRequestSlices: 700,
      pageSize: 128,
      requestCount: 700,
      requestSliceFields: ['filter'],
      targetRowsReturnedPerRequest: 128,
      workloadClass: 'foregroundReviewFacet',
    },
    {
      contractKey: 'review.human.filters.facets',
      key: 'humanOverlapFacetRefresh',
      maxRowsScannedPerRequest: 512,
      minimumDistinctRequestSlices: 700,
      pageSize: 128,
      requestCount: 700,
      requestSliceFields: ['filter'],
      targetRowsReturnedPerRequest: 128,
      workloadClass: 'foregroundReviewFacet',
    },
    {
      contractKey: 'review.filters.options',
      key: 'overlapFilterOptions',
      maxRowsScannedPerRequest: 512,
      minimumDistinctRequestSlices: 700,
      pageSize: 512,
      requestCount: 700,
      requestSliceFields: ['filter', 'searchTokenPrefix'],
      searchMode: 'tokenPrefix',
      targetRowsReturnedPerRequest: 512,
      workloadClass: 'foregroundReviewFacet',
    },
    {
      contractKey: 'review.human.filters.options',
      key: 'humanOverlapFilterOptions',
      maxRowsScannedPerRequest: 512,
      minimumDistinctRequestSlices: 700,
      pageSize: 512,
      requestCount: 700,
      requestSliceFields: ['filter', 'searchTokenPrefix'],
      searchMode: 'tokenPrefix',
      targetRowsReturnedPerRequest: 512,
      workloadClass: 'foregroundReviewFacet',
    },
    {
      contractKey: 'review.detail.judgments',
      key: 'detailJudgmentPayloadRows',
      maxRowsScannedPerRequest: 512,
      minimumDistinctRequestSlices: 700,
      pageSize: 512,
      requestCount: 700,
      requestSliceFields: ['filter'],
      targetRowsReturnedPerRequest: 7,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.human.list.judgments',
      key: 'humanListJudgmentPayloadRows',
      maxRowsScannedPerRequest: 10_000,
      minimumDistinctRequestSlices: 7_000,
      pageSize: 10_000,
      requestCount: 7_000,
      requestSliceFields: ['cursor', 'filter'],
      targetRowsReturnedPerRequest: 700,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.llm.list.judgments',
      key: 'llmListJudgmentPayloadRows',
      maxRowsScannedPerRequest: 10_000,
      minimumDistinctRequestSlices: 7_000,
      pageSize: 10_000,
      requestCount: 7_000,
      requestSliceFields: ['cursor', 'filter'],
      targetRowsReturnedPerRequest: 700,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.both.list.judgments',
      key: 'bothListJudgmentPayloadRows',
      maxRowsScannedPerRequest: 10_000,
      minimumDistinctRequestSlices: 7_000,
      pageSize: 10_000,
      requestCount: 7_000,
      requestSliceFields: ['cursor', 'filter'],
      targetRowsReturnedPerRequest: 700,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.both.list.humanJudgments',
      key: 'bothListHumanJudgmentPayloadRows',
      maxRowsScannedPerRequest: 10_000,
      minimumDistinctRequestSlices: 7_000,
      pageSize: 10_000,
      requestCount: 7_000,
      requestSliceFields: ['cursor', 'filter'],
      targetRowsReturnedPerRequest: 700,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.llm.count',
      countFilterKeyPrefix: 'prompt:',
      key: 'llmPromptOverlapCounts',
      maxRowsScannedPerRequest: 8,
      minimumDistinctRequestSlices: 7,
      namedCountKey: 'review.llm.assessedByPrompt',
      pageSize: 1,
      requestCount: 700,
      requestSliceFields: ['filter'],
      targetRowsReturnedPerRequest: 1,
      workloadClass: 'foregroundReviewCount',
    },
    {
      contractKey: 'review.human.count',
      countFilterKeyPrefix: 'prompt:',
      key: 'humanPromptOverlapCounts',
      maxRowsScannedPerRequest: 8,
      minimumDistinctRequestSlices: 7,
      namedCountKey: 'review.human.reviewedByPrompt',
      pageSize: 1,
      requestCount: 700,
      requestSliceFields: ['filter'],
      targetRowsReturnedPerRequest: 1,
      workloadClass: 'foregroundReviewCount',
    },
    {
      contractKey: 'review.both.count',
      countFilterKeyPrefix: 'prompt:',
      key: 'bothPromptOverlapCounts',
      maxRowsScannedPerRequest: 8,
      minimumDistinctRequestSlices: 7,
      namedCountKey: 'review.both.conflictByPrompt',
      pageSize: 1,
      requestCount: 700,
      requestSliceFields: ['filter'],
      targetRowsReturnedPerRequest: 1,
      workloadClass: 'foregroundReviewCount',
    },
    {
      contractKey: 'review.unassessed.count',
      countFilterKeyPrefix: 'prompt:',
      key: 'unassessedPromptOverlapCounts',
      maxRowsScannedPerRequest: 8,
      minimumDistinctRequestSlices: 7,
      namedCountKey: 'review.llm.unassessedByPrompt',
      pageSize: 1,
      requestCount: 700,
      requestSliceFields: ['filter'],
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
      targetRowsReturnedPerRequest: 1,
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
      targetRowsReturnedPerRequest: 1,
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
      targetRowsReturnedPerRequest: 1,
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
      targetRowsReturnedPerRequest: 1,
      workloadClass: 'bulkReviewJob',
    },
    {
      contractKey: 'review.queue.unassessed',
      key: 'unassessedOverlapQueue',
      maxRowsScannedPerRequest: 300,
      minimumDistinctRequestSlices: 700,
      pageSize: 100,
      requestCount: 700,
      requestSliceFields: ['cursor', 'filter', 'queueKind'],
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewQueue',
    },
    {
      contractKey: 'review.search.tokenPrefix',
      key: 'titlePrefixOverlapSearch',
      maxRowsScannedPerRequest: 150,
      minimumDistinctRequestSlices: 700,
      pageSize: 50,
      requestCount: 700,
      requestSliceFields: ['cursor', 'searchTokenPrefix'],
      searchMode: 'tokenPrefix',
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

const getReviewServingBenchmarkRequestSliceKey = (
  operation: ReviewServingBenchmarkWorkloadOperation,
  workItem: ReviewServingBenchmarkWorkItem,
) => {
  const fields = operation.requestSliceFields ?? []

  return fields.length === 0
    ? null
    : fields
        .map((field) => {
          return `${field}:${getReviewServingBenchmarkActualRequestSliceValue(field, workItem) ?? ''}`
        })
        .join('|')
}

const getReviewServingBenchmarkActualRequestSliceValue = (
  field: ReviewServingBenchmarkRequestSliceField,
  workItem: ReviewServingBenchmarkWorkItem,
) => {
  if (field === 'cursor') {
    return workItem.cursor ?? null
  }

  if (field === 'searchTokenPrefix') {
    return workItem.searchTokenPrefix ?? null
  }

  if (field === 'listMode') {
    return workItem.listMode ?? null
  }

  if (field === 'queueKind') {
    return workItem.queueKind ?? null
  }

  return workItem.admissionRequest.countFilterKey ?? workItem.filterSignature ?? null
}

const getReviewServingBenchmarkRequestSliceViolations = (
  operation: ReviewServingBenchmarkWorkloadOperation,
  workItem: ReviewServingBenchmarkWorkItem,
): ReviewServingBenchmarkWorkItemShapeViolation[] => {
  const fields = operation.requestSliceFields ?? []

  return fields.flatMap((field) => {
    const declaredValue = workItem.requestSlice?.[field] ?? null
    const actualValue = getReviewServingBenchmarkActualRequestSliceValue(field, workItem)

    if (!declaredValue) {
      return [{actual: `missing:${field}`, expected: actualValue ?? field, field: 'requestSlice', key: workItem.key}]
    }

    if (!actualValue) {
      return [
        {actual: `${field}:${declaredValue}`, expected: `actual:${field}`, field: 'requestSlice', key: workItem.key},
      ]
    }

    return declaredValue === actualValue
      ? []
      : [
          {
            actual: `${field}:${declaredValue}`,
            expected: `${field}:${actualValue}`,
            field: 'requestSlice',
            key: workItem.key,
          },
        ]
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
    [ReviewServingBenchmarkWorkItemShapeViolation['field'], string | null, string | null]
  > = [
    ['countFilterKeyPrefix', workItem.admissionRequest.countFilterKey ?? null, operation.countFilterKeyPrefix ?? null],
    ['jobFilterSignaturePrefix', workItem.jobFilterSignature ?? null, operation.jobFilterSignaturePrefix ?? null],
    ['searchTextPrefix', workItem.searchText ?? null, operation.searchTextPrefix ?? null],
  ]
  const exactViolations: ReviewServingBenchmarkWorkItemShapeViolation[] = exactShapeEntries
    .map(([field, actual, expected]) => {
      return {actual, expected, field, key: workItem.key}
    })
    .filter((violation) => {
      return violation.actual !== violation.expected
    })
  const prefixViolations: ReviewServingBenchmarkWorkItemShapeViolation[] = prefixShapeEntries
    .map(([field, actual, expected]) => {
      return {actual, expected: expected === null ? null : `${expected}*`, field, key: workItem.key}
    })
    .filter((violation) => {
      return violation.expected === null
        ? violation.actual !== null
        : typeof violation.actual !== 'string' || !violation.actual.startsWith(String(violation.expected).slice(0, -1))
    })
  const requestSliceViolations = getReviewServingBenchmarkRequestSliceViolations(operation, workItem)

  return [...exactViolations, ...prefixViolations, ...requestSliceViolations]
}

export const getReviewServingBenchmarkCoverageViolations = (
  input: Pick<ReviewServingBenchmarkRunInput, 'workItems' | 'workload'>,
) => {
  return input.workload.operations
    .map((operation) => {
      const expectedDistinctRequestSlices = operation.minimumDistinctRequestSlices ?? 0
      const matchingRequestSliceKeys = input.workItems
        .filter((workItem) => {
          return (
            workItem.operationKey === operation.key
            && getReviewServingBenchmarkWorkItemShapeViolations(input, workItem).length === 0
          )
        })
        .map((workItem) => {
          return getReviewServingBenchmarkRequestSliceKey(operation, workItem)
        })
        .filter((requestSliceKey): requestSliceKey is string => {
          return requestSliceKey !== null
        })
      const actualDistinctCoverageKeys = new Set(matchingRequestSliceKeys).size

      return expectedDistinctRequestSlices > 0 && actualDistinctCoverageKeys < expectedDistinctRequestSlices
        ? {
            actualDistinctCoverageKeys,
            expectedDistinctCoverageKeys: expectedDistinctRequestSlices,
            operationKey: operation.key,
          }
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
      return `${violation.operationKey}: expected ${violation.expectedDistinctCoverageKeys} distinct request slices, got ${violation.actualDistinctCoverageKeys}`
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

export const getReviewServingBenchmarkRowsReturnedLimitViolations = (
  input: Pick<ReviewServingBenchmarkRunInput, 'workload'>,
  samples: readonly ReviewServingBenchmarkSample[],
) => {
  return samples
    .map((sample) => {
      const operation = getReviewServingBenchmarkOperationByKey(input, sample.operationKey)

      return operation && sample.rowsReturned > operation.pageSize
        ? {
            actualRowsReturned: sample.rowsReturned,
            expectedMaxRowsReturned: operation.pageSize,
            key: sample.key,
            operationKey: sample.operationKey,
          }
        : null
    })
    .filter((violation): violation is ReviewServingBenchmarkRowsReturnedLimitViolation => {
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

const getReviewServingBenchmarkRowsReturnedLimitViolationMessage = (
  violations: readonly ReviewServingBenchmarkRowsReturnedLimitViolation[],
) => {
  return violations
    .map((violation) => {
      return `${violation.key}.${violation.operationKey}: expected <= ${violation.expectedMaxRowsReturned}, got ${violation.actualRowsReturned}`
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
  samples: readonly ReviewServingBenchmarkSample[] = [],
) => {
  const rssGrowthBytes = metrics.memory.peakRssBytes - metrics.memory.startRssBytes
  const operationKeys = [
    ...new Set(
      samples.map((sample) => {
        return sample.operationKey
      }),
    ),
  ]
  const operationLatencyViolations = operationKeys.flatMap((operationKey) => {
    const operationLatencyValues = samples
      .filter((sample) => {
        return sample.operationKey === operationKey
      })
      .map((sample) => {
        return sample.latencyMs
      })
    const p95Ms = getPercentileMetric(operationLatencyValues, 0.95)
    const p99Ms = getPercentileMetric(operationLatencyValues, 0.99)

    return [
      {actual: p95Ms, expected: targets.maxP95LatencyMs, metric: 'latency.p95Ms' as const, operationKey},
      {actual: p99Ms, expected: targets.maxP99LatencyMs, metric: 'latency.p99Ms' as const, operationKey},
    ].filter((violation) => {
      return violation.actual > violation.expected
    })
  })

  const aggregateViolations = [
    {actual: metrics.latency.p95Ms, expected: targets.maxP95LatencyMs, metric: 'latency.p95Ms' as const},
    {actual: metrics.latency.p99Ms, expected: targets.maxP99LatencyMs, metric: 'latency.p99Ms' as const},
    {actual: metrics.memory.peakRssBytes, expected: targets.maxPeakRssBytes, metric: 'memory.peakRssBytes' as const},
    {actual: rssGrowthBytes, expected: targets.maxRssGrowthBytes, metric: 'memory.rssGrowthBytes' as const},
  ].filter((violation) => {
    return violation.actual > violation.expected
  })

  return [...aggregateViolations, ...operationLatencyViolations]
}

const getReviewServingBenchmarkPerformanceViolationMessage = (
  violations: readonly ReviewServingBenchmarkPerformanceViolation[],
) => {
  return violations
    .map((violation) => {
      const metric = violation.operationKey ? `${violation.operationKey}.${violation.metric}` : violation.metric

      return `${metric}: expected <= ${violation.expected}, got ${violation.actual}`
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
  const requestSliceFields = operation.requestSliceFields ?? []
  const expectedRequestSliceFields = expectedOperation?.requestSliceFields ?? []

  return (
    expectedOperation !== undefined
    && operation.contractKey === expectedOperation.contractKey
    && operation.countFilterKeyPrefix === expectedOperation.countFilterKeyPrefix
    && operation.jobFilterSignaturePrefix === expectedOperation.jobFilterSignaturePrefix
    && operation.jobKind === expectedOperation.jobKind
    && operation.key === expectedOperation.key
    && operation.maxRowsScannedPerRequest === expectedOperation.maxRowsScannedPerRequest
    && operation.minimumDistinctRequestSlices === expectedOperation.minimumDistinctRequestSlices
    && operation.namedCountKey === expectedOperation.namedCountKey
    && operation.pageSize === expectedOperation.pageSize
    && operation.requestCount === expectedOperation.requestCount
    && requestSliceFields.length === expectedRequestSliceFields.length
    && requestSliceFields.every((field, index) => {
      return field === expectedRequestSliceFields[index]
    })
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

const validateReviewServingBenchmarkRowsReturnedLimit = (
  input: ReviewServingBenchmarkRunInput,
  samples: readonly ReviewServingBenchmarkSample[],
) => {
  const violations = getReviewServingBenchmarkRowsReturnedLimitViolations(input, samples)

  return violations.length === 0
    ? Effect.void
    : Effect.fail(
        new Error(
          `Review-serving benchmark rows returned limit mismatch: ${getReviewServingBenchmarkRowsReturnedLimitViolationMessage(violations)}`,
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
  samples: readonly ReviewServingBenchmarkSample[],
  targets: ReviewServingBenchmarkPerformanceTargets,
) => {
  const violations = getReviewServingBenchmarkPerformanceViolations(metrics, targets, samples)

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
          minimumDistinctRequestSlices: 1,
          pageSize: 12,
          requestCount: 1,
          targetRowsReturnedPerRequest: 12,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[1],
          minimumDistinctRequestSlices: 1,
          pageSize: 9,
          requestCount: 1,
          targetRowsReturnedPerRequest: 9,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[2],
          minimumDistinctRequestSlices: 1,
          pageSize: 10,
          requestCount: 1,
          targetRowsReturnedPerRequest: 10,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[3],
          minimumDistinctRequestSlices: 1,
          pageSize: 7,
          requestCount: 1,
          targetRowsReturnedPerRequest: 7,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[4],
          minimumDistinctRequestSlices: 1,
          pageSize: 6,
          requestCount: 1,
          targetRowsReturnedPerRequest: 6,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[5],
          minimumDistinctRequestSlices: 1,
          pageSize: 6,
          requestCount: 1,
          targetRowsReturnedPerRequest: 6,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[6],
          minimumDistinctRequestSlices: 1,
          pageSize: 6,
          requestCount: 1,
          targetRowsReturnedPerRequest: 6,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[7],
          minimumDistinctRequestSlices: 1,
          pageSize: 6,
          requestCount: 1,
          targetRowsReturnedPerRequest: 6,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[8],
          minimumDistinctRequestSlices: 1,
          pageSize: 4,
          requestCount: 1,
          targetRowsReturnedPerRequest: 4,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[9],
          minimumDistinctRequestSlices: 1,
          pageSize: 16,
          requestCount: 1,
          targetRowsReturnedPerRequest: 16,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[10],
          minimumDistinctRequestSlices: 1,
          pageSize: 16,
          requestCount: 1,
          targetRowsReturnedPerRequest: 16,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[11],
          minimumDistinctRequestSlices: 1,
          pageSize: 8,
          requestCount: 1,
          targetRowsReturnedPerRequest: 8,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[12],
          minimumDistinctRequestSlices: 1,
          pageSize: 8,
          requestCount: 1,
          targetRowsReturnedPerRequest: 8,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[13],
          minimumDistinctRequestSlices: 1,
          pageSize: 2,
          requestCount: 1,
          targetRowsReturnedPerRequest: 2,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[14],
          minimumDistinctRequestSlices: 1,
          pageSize: 6,
          requestCount: 1,
          targetRowsReturnedPerRequest: 6,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[15],
          minimumDistinctRequestSlices: 1,
          pageSize: 6,
          requestCount: 1,
          targetRowsReturnedPerRequest: 6,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[16],
          minimumDistinctRequestSlices: 1,
          pageSize: 6,
          requestCount: 1,
          targetRowsReturnedPerRequest: 6,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[17],
          minimumDistinctRequestSlices: 1,
          pageSize: 6,
          requestCount: 1,
          targetRowsReturnedPerRequest: 6,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[18],
          minimumDistinctRequestSlices: 1,
          pageSize: 1,
          requestCount: 1,
          targetRowsReturnedPerRequest: 1,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[19],
          minimumDistinctRequestSlices: 1,
          pageSize: 1,
          requestCount: 1,
          targetRowsReturnedPerRequest: 1,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[20],
          minimumDistinctRequestSlices: 1,
          pageSize: 1,
          requestCount: 1,
          targetRowsReturnedPerRequest: 1,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[21],
          minimumDistinctRequestSlices: 1,
          pageSize: 1,
          requestCount: 1,
          targetRowsReturnedPerRequest: 1,
        },
        {...reviewServingBenchmarkOverlapWorkloadDefinition.operations[22], requestCount: 1},
        {...reviewServingBenchmarkOverlapWorkloadDefinition.operations[23], requestCount: 1},
        {...reviewServingBenchmarkOverlapWorkloadDefinition.operations[24], requestCount: 1},
        {...reviewServingBenchmarkOverlapWorkloadDefinition.operations[25], requestCount: 1},
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[26],
          minimumDistinctRequestSlices: 1,
          pageSize: 5,
          requestCount: 1,
          targetRowsReturnedPerRequest: 5,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[27],
          minimumDistinctRequestSlices: 1,
          pageSize: 6,
          requestCount: 1,
          targetRowsReturnedPerRequest: 6,
        },
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
        cursor: 'start',
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
        requestSlice: {cursor: 'start'},
      },
      {
        admissionRequest: {
          contractKey: 'review.human.rows',
          estimatedResultBytes: 9_000,
          estimatedResultRows: 9,
          pageSize: 9,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        cursor: 'start',
        key: 'smoke-human-page',
        observation: {
          latencyMs: 13,
          memoryRssBytes: 128_750_000,
          queueDepth: 2,
          rowsReturned: 9,
          rowsScanned: 18,
          tempUsageBytes: 0,
        },
        operationKey: 'humanPromptOverlapRows',
        requestSlice: {cursor: 'start'},
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
        cursor: 'start',
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
        requestSlice: {cursor: 'start'},
      },
      {
        admissionRequest: {
          contractKey: 'review.unassessed.rows',
          estimatedResultBytes: 7_000,
          estimatedResultRows: 7,
          pageSize: 7,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        cursor: 'start',
        key: 'smoke-unassessed-page',
        observation: {
          latencyMs: 15,
          memoryRssBytes: 129_250_000,
          queueDepth: 2,
          rowsReturned: 7,
          rowsScanned: 14,
          tempUsageBytes: 0,
        },
        operationKey: 'unassessedOverlapRows',
        requestSlice: {cursor: 'start'},
      },
      {
        admissionRequest: {
          contractKey: 'review.filters.postings',
          estimatedResultBytes: 6_000,
          estimatedResultRows: 6,
          pageSize: 6,
          projectId: 'smoke-project',
          searchMode: 'tokenPrefix',
          searchState: {availability: 'ready', snapshotId: 'smoke-snapshot'},
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        cursor: 'start',
        filterSignature: 'prompt:1',
        key: 'smoke-filtered-page',
        listMode: 'llm',
        observation: {
          latencyMs: 16,
          memoryRssBytes: 129_300_000,
          queueDepth: 2,
          rowsReturned: 6,
          rowsScanned: 18,
          tempUsageBytes: 0,
        },
        operationKey: 'filteredOverlapRows',
        requestSlice: {cursor: 'start', filter: 'prompt:1', listMode: 'llm', searchTokenPrefix: 'overlap'},
        searchTokenPrefix: 'overlap',
      },
      {
        admissionRequest: {
          contractKey: 'review.llm.rowsByArticleSet',
          estimatedResultBytes: 6_000,
          estimatedResultRows: 6,
          pageSize: 6,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        filterSignature: 'article-set:llm:smoke',
        key: 'smoke-filtered-llm-row-set',
        listMode: 'llm',
        observation: {
          latencyMs: 11,
          memoryRssBytes: 129_325_000,
          queueDepth: 1,
          rowsReturned: 6,
          rowsScanned: 6,
          tempUsageBytes: 0,
        },
        operationKey: 'filteredLlmRowsByArticleSet',
        requestSlice: {filter: 'article-set:llm:smoke', listMode: 'llm'},
      },
      {
        admissionRequest: {
          contractKey: 'review.human.rowsByArticleSet',
          estimatedResultBytes: 6_000,
          estimatedResultRows: 6,
          pageSize: 6,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        filterSignature: 'article-set:human:smoke',
        key: 'smoke-filtered-human-row-set',
        listMode: 'human',
        observation: {
          latencyMs: 11,
          memoryRssBytes: 129_350_000,
          queueDepth: 1,
          rowsReturned: 6,
          rowsScanned: 6,
          tempUsageBytes: 0,
        },
        operationKey: 'filteredHumanRowsByArticleSet',
        requestSlice: {filter: 'article-set:human:smoke', listMode: 'human'},
      },
      {
        admissionRequest: {
          contractKey: 'review.both.rowsByArticleSet',
          estimatedResultBytes: 6_000,
          estimatedResultRows: 6,
          pageSize: 6,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        filterSignature: 'article-set:both:smoke',
        key: 'smoke-filtered-both-row-set',
        listMode: 'both',
        observation: {
          latencyMs: 11,
          memoryRssBytes: 129_375_000,
          queueDepth: 1,
          rowsReturned: 6,
          rowsScanned: 6,
          tempUsageBytes: 0,
        },
        operationKey: 'filteredBothRowsByArticleSet',
        requestSlice: {filter: 'article-set:both:smoke', listMode: 'both'},
      },
      {
        admissionRequest: {
          contractKey: 'review.unassessed.rowsByArticleSet',
          estimatedResultBytes: 4_000,
          estimatedResultRows: 4,
          pageSize: 4,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        filterSignature: 'article-set:unassessed:smoke',
        key: 'smoke-filtered-unassessed-row-set',
        listMode: 'unassessed',
        observation: {
          latencyMs: 12,
          memoryRssBytes: 129_400_000,
          queueDepth: 1,
          rowsReturned: 4,
          rowsScanned: 4,
          tempUsageBytes: 0,
        },
        operationKey: 'filteredUnassessedRowsByArticleSet',
        requestSlice: {filter: 'article-set:unassessed:smoke', listMode: 'unassessed'},
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
        filterSignature: 'all',
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
        requestSlice: {filter: 'all'},
      },
      {
        admissionRequest: {
          contractKey: 'review.human.filters.facets',
          estimatedResultBytes: 4_000,
          estimatedResultRows: 16,
          pageSize: 16,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewFacet',
        },
        filterSignature: 'all',
        key: 'smoke-human-facet',
        observation: {
          latencyMs: 20,
          memoryRssBytes: 130_050_000,
          queueDepth: 3,
          rowsReturned: 16,
          rowsScanned: 48,
          tempUsageBytes: 0,
        },
        operationKey: 'humanOverlapFacetRefresh',
        requestSlice: {filter: 'all'},
      },
      {
        admissionRequest: {
          contractKey: 'review.filters.options',
          estimatedResultBytes: 8_000,
          estimatedResultRows: 8,
          pageSize: 8,
          projectId: 'smoke-project',
          searchMode: 'tokenPrefix',
          searchState: {availability: 'ready', snapshotId: 'smoke-snapshot'},
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewFacet',
        },
        filterSignature: 'all',
        key: 'smoke-filter-options',
        observation: {
          latencyMs: 18,
          memoryRssBytes: 129_500_000,
          queueDepth: 2,
          rowsReturned: 8,
          rowsScanned: 32,
          tempUsageBytes: 0,
        },
        operationKey: 'overlapFilterOptions',
        requestSlice: {filter: 'all', searchTokenPrefix: 'overlap'},
        searchTokenPrefix: 'overlap',
      },
      {
        admissionRequest: {
          contractKey: 'review.human.filters.options',
          estimatedResultBytes: 8_000,
          estimatedResultRows: 8,
          pageSize: 8,
          projectId: 'smoke-project',
          searchMode: 'tokenPrefix',
          searchState: {availability: 'ready', snapshotId: 'smoke-snapshot'},
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewFacet',
        },
        filterSignature: 'human:reviewed',
        key: 'smoke-human-filter-options',
        observation: {
          latencyMs: 18,
          memoryRssBytes: 129_550_000,
          queueDepth: 2,
          rowsReturned: 8,
          rowsScanned: 32,
          tempUsageBytes: 0,
        },
        operationKey: 'humanOverlapFilterOptions',
        requestSlice: {filter: 'human:reviewed', searchTokenPrefix: 'overlap'},
        searchTokenPrefix: 'overlap',
      },
      {
        admissionRequest: {
          contractKey: 'review.detail.judgments',
          estimatedResultBytes: 2_000,
          estimatedResultRows: 2,
          pageSize: 2,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        filterSignature: 'article:smoke-1',
        key: 'smoke-detail-judgments',
        observation: {
          latencyMs: 9,
          memoryRssBytes: 129_575_000,
          queueDepth: 1,
          rowsReturned: 2,
          rowsScanned: 4,
          tempUsageBytes: 0,
        },
        operationKey: 'detailJudgmentPayloadRows',
        requestSlice: {filter: 'article:smoke-1'},
      },
      {
        admissionRequest: {
          contractKey: 'review.human.list.judgments',
          estimatedResultBytes: 6_000,
          estimatedResultRows: 6,
          pageSize: 6,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        cursor: 'start',
        filterSignature: 'human:reviewed',
        key: 'smoke-human-list-judgments',
        observation: {
          latencyMs: 10,
          memoryRssBytes: 129_600_000,
          queueDepth: 1,
          rowsReturned: 6,
          rowsScanned: 6,
          tempUsageBytes: 0,
        },
        operationKey: 'humanListJudgmentPayloadRows',
        requestSlice: {cursor: 'start', filter: 'human:reviewed'},
      },
      {
        admissionRequest: {
          contractKey: 'review.llm.list.judgments',
          estimatedResultBytes: 6_000,
          estimatedResultRows: 6,
          pageSize: 6,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        cursor: 'start',
        filterSignature: 'llm:assessed',
        key: 'smoke-llm-list-judgments',
        observation: {
          latencyMs: 10,
          memoryRssBytes: 129_610_000,
          queueDepth: 1,
          rowsReturned: 6,
          rowsScanned: 12,
          tempUsageBytes: 0,
        },
        operationKey: 'llmListJudgmentPayloadRows',
        requestSlice: {cursor: 'start', filter: 'llm:assessed'},
      },
      {
        admissionRequest: {
          contractKey: 'review.both.list.humanJudgments',
          estimatedResultBytes: 6_000,
          estimatedResultRows: 6,
          pageSize: 6,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        cursor: 'start',
        filterSignature: 'both:conflict',
        key: 'smoke-both-list-human-judgments',
        observation: {
          latencyMs: 10,
          memoryRssBytes: 129_625_000,
          queueDepth: 1,
          rowsReturned: 6,
          rowsScanned: 6,
          tempUsageBytes: 0,
        },
        operationKey: 'bothListHumanJudgmentPayloadRows',
        requestSlice: {cursor: 'start', filter: 'both:conflict'},
      },
      {
        admissionRequest: {
          contractKey: 'review.both.list.judgments',
          estimatedResultBytes: 6_000,
          estimatedResultRows: 6,
          pageSize: 6,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewRows',
        },
        cursor: 'start',
        filterSignature: 'both:llm',
        key: 'smoke-both-list-judgments',
        observation: {
          latencyMs: 10,
          memoryRssBytes: 129_615_000,
          queueDepth: 1,
          rowsReturned: 6,
          rowsScanned: 12,
          tempUsageBytes: 0,
        },
        operationKey: 'bothListJudgmentPayloadRows',
        requestSlice: {cursor: 'start', filter: 'both:llm'},
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
        requestSlice: {filter: 'prompt:1'},
      },
      {
        admissionRequest: {
          contractKey: 'review.human.count',
          countFilterKey: 'prompt:1',
          countState: {
            availability: 'ready',
            filterKey: 'prompt:1',
            key: 'review.human.reviewedByPrompt',
            snapshotId: 'smoke-snapshot',
            value: 8,
          },
          estimatedResultBytes: 1_000,
          estimatedResultRows: 1,
          namedCountKey: 'review.human.reviewedByPrompt',
          pageSize: 1,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewCount',
        },
        key: 'smoke-human-count',
        observation: {
          latencyMs: 6,
          memoryRssBytes: 128_500_000,
          queueDepth: 1,
          rowsReturned: 1,
          rowsScanned: 1,
          tempUsageBytes: 0,
        },
        operationKey: 'humanPromptOverlapCounts',
        requestSlice: {filter: 'prompt:1'},
      },
      {
        admissionRequest: {
          contractKey: 'review.both.count',
          countFilterKey: 'prompt:1',
          countState: {
            availability: 'ready',
            filterKey: 'prompt:1',
            key: 'review.both.conflictByPrompt',
            snapshotId: 'smoke-snapshot',
            value: 3,
          },
          estimatedResultBytes: 1_000,
          estimatedResultRows: 1,
          namedCountKey: 'review.both.conflictByPrompt',
          pageSize: 1,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewCount',
        },
        key: 'smoke-both-count',
        observation: {
          latencyMs: 7,
          memoryRssBytes: 128_500_000,
          queueDepth: 1,
          rowsReturned: 1,
          rowsScanned: 1,
          tempUsageBytes: 0,
        },
        operationKey: 'bothPromptOverlapCounts',
        requestSlice: {filter: 'prompt:1'},
      },
      {
        admissionRequest: {
          contractKey: 'review.unassessed.count',
          countFilterKey: 'prompt:1',
          countState: {
            availability: 'ready',
            filterKey: 'prompt:1',
            key: 'review.llm.unassessedByPrompt',
            snapshotId: 'smoke-snapshot',
            value: 2,
          },
          estimatedResultBytes: 1_000,
          estimatedResultRows: 1,
          namedCountKey: 'review.llm.unassessedByPrompt',
          pageSize: 1,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewCount',
        },
        key: 'smoke-unassessed-count',
        observation: {
          latencyMs: 8,
          memoryRssBytes: 128_500_000,
          queueDepth: 1,
          rowsReturned: 1,
          rowsScanned: 1,
          tempUsageBytes: 0,
        },
        operationKey: 'unassessedPromptOverlapCounts',
        requestSlice: {filter: 'prompt:1'},
      },
      {
        admissionRequest: {
          contractKey: 'review.bulk.selection',
          estimatedResultBytes: 1_000,
          estimatedResultRows: 1,
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
          rowsReturned: 1,
          rowsScanned: 1,
          tempUsageBytes: 0,
        },
        operationKey: 'bulkOverlapSelectionJob',
      },
      {
        admissionRequest: {
          contractKey: 'review.export.selection',
          estimatedResultBytes: 1_000,
          estimatedResultRows: 1,
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
          rowsReturned: 1,
          rowsScanned: 1,
          tempUsageBytes: 0,
        },
        operationKey: 'exportOverlapSelectionJob',
      },
      {
        admissionRequest: {
          contractKey: 'review.pdf.selection',
          estimatedResultBytes: 1_000,
          estimatedResultRows: 1,
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
          rowsReturned: 1,
          rowsScanned: 1,
          tempUsageBytes: 0,
        },
        operationKey: 'pdfOverlapSelectionJob',
      },
      {
        admissionRequest: {
          contractKey: 'review.search.substringAsync',
          estimatedResultBytes: 1_000,
          estimatedResultRows: 1,
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
          rowsReturned: 1,
          rowsScanned: 1,
          tempUsageBytes: 0,
        },
        operationKey: 'substringOverlapSearchJob',
        searchText: 'overlap smoke',
      },
      {
        admissionRequest: {
          contractKey: 'review.queue.unassessed',
          estimatedResultBytes: 5_000,
          estimatedResultRows: 5,
          pageSize: 5,
          projectId: 'smoke-project',
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewQueue',
        },
        cursor: 'start',
        filterSignature: 'all',
        key: 'smoke-unassessed-queue',
        observation: {
          latencyMs: 14,
          memoryRssBytes: 128_450_000,
          queueDepth: 2,
          rowsReturned: 5,
          rowsScanned: 10,
          tempUsageBytes: 0,
        },
        operationKey: 'unassessedOverlapQueue',
        queueKind: 'oldestUnassessed',
        requestSlice: {cursor: 'start', filter: 'all', queueKind: 'oldestUnassessed'},
      },
      {
        admissionRequest: {
          contractKey: 'review.search.tokenPrefix',
          estimatedResultBytes: 6_000,
          estimatedResultRows: 6,
          pageSize: 6,
          projectId: 'smoke-project',
          searchMode: 'tokenPrefix',
          searchState: {availability: 'ready', snapshotId: 'smoke-snapshot'},
          snapshotFreshness: 'ready',
          snapshotId: 'smoke-snapshot',
          workloadClass: 'foregroundReviewSearch',
        },
        cursor: 'overlap-0',
        key: 'smoke-title-prefix-search',
        observation: {
          latencyMs: 10,
          memoryRssBytes: 128_475_000,
          queueDepth: 1,
          rowsReturned: 6,
          rowsScanned: 12,
          tempUsageBytes: 0,
        },
        operationKey: 'titlePrefixOverlapSearch',
        requestSlice: {cursor: 'overlap-0', searchTokenPrefix: 'overlap'},
        searchTokenPrefix: 'overlap',
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
      yield* validateReviewServingBenchmarkRowsReturnedLimit(input, samples)
      yield* validateReviewServingBenchmarkRowsScanned(input, samples)
      yield* validateReviewServingBenchmarkTempSpill(samples)
      const endRssBytes = sampleReviewServingBenchmarkMemoryRssBytes()
      const metrics = getReviewServingBenchmarkMetrics({endRssBytes, samples, startRssBytes: runState.startRssBytes})
      yield* validateReviewServingBenchmarkPerformanceTargets(metrics, samples, input.workload.performanceTargets)

      return {fixture: input.fixture, metrics, samples, workload: input.workload}
    }),
  )
}

export const runReviewServingBenchmarkSmoke = () => {
  return Effect.runPromise(runReviewServingBenchmarkEffect(getReviewServingBenchmarkSmokeInput()))
}
