import {Effect} from 'effect'

import {
  admitReviewServingRequest,
  type ReviewServingAdmissionRejectionReason,
  type ReviewServingAdmissionRequest,
  type ReviewServingAdmissionResult,
} from './reviewServingAdmission.ts'
import type {ReviewServingReadContractKey, ReviewServingWorkloadClass} from './reviewServingContracts.ts'

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
  key: string
  pageSize: number
  requestCount: number
  targetRowsReturnedPerRequest: number
  workloadClass: ReviewServingWorkloadClass
}

export type ReviewServingBenchmarkWorkloadDefinition = {
  fixtureKind: ReviewServingBenchmarkFixtureKind
  key: string
  operations: readonly ReviewServingBenchmarkWorkloadOperation[]
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
  key: string
  observation: ReviewServingBenchmarkObservation
  operationKey: string
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

type ReviewServingBenchmarkRunState = {startedAtMs: number; startRssBytes: number}

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
      pageSize: 100,
      requestCount: 7_000,
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.both.rows',
      key: 'llmHumanOverlapRows',
      pageSize: 100,
      requestCount: 7_000,
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.filters.facets',
      key: 'overlapFacetRefresh',
      pageSize: 1,
      requestCount: 700,
      targetRowsReturnedPerRequest: 128,
      workloadClass: 'foregroundReviewFacet',
    },
    {
      contractKey: 'review.queue.unassessed',
      key: 'unassessedOverlapQueue',
      pageSize: 100,
      requestCount: 700,
      targetRowsReturnedPerRequest: 100,
      workloadClass: 'foregroundReviewQueue',
    },
    {
      contractKey: 'review.search.tokenPrefix',
      key: 'titlePrefixOverlapSearch',
      pageSize: 50,
      requestCount: 700,
      targetRowsReturnedPerRequest: 50,
      workloadClass: 'foregroundReviewSearch',
    },
  ],
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

const releaseBenchmarkRunState = (_state: ReviewServingBenchmarkRunState) => {
  return Effect.void
}

const getDefaultBenchmarkObservation = (workItem: ReviewServingBenchmarkWorkItem) => {
  return Effect.sync(() => {
    return workItem.observation
  })
}

const getRejectedBenchmarkObservation = (workItem: ReviewServingBenchmarkWorkItem) => {
  return {...workItem.observation, rowsReturned: 0, rowsScanned: 0, tempUsageBytes: 0}
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
    const observationEffect = admission.admitted
      ? executor(workItem, admission)
      : Effect.succeed(getRejectedBenchmarkObservation(workItem))
    const observation = yield* observationEffect

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
    },
    workItems: [
      {
        admissionRequest: {
          contractKey: 'review.llm.rows',
          estimatedResultBytes: 12_000,
          estimatedResultRows: 12,
          pageSize: 12,
          snapshotFreshness: 'ready',
          workloadClass: 'foregroundReviewRows',
        },
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
          snapshotFreshness: 'ready',
          workloadClass: 'foregroundReviewRows',
        },
        key: 'smoke-both-page',
        observation: {
          latencyMs: 12,
          memoryRssBytes: 129_000_000,
          queueDepth: 2,
          rowsReturned: 10,
          rowsScanned: 30,
          tempUsageBytes: 64,
        },
        operationKey: 'llmHumanOverlapRows',
      },
      {
        admissionRequest: {
          contractKey: 'review.filters.facets',
          estimatedResultBytes: 4_000,
          estimatedResultRows: 16,
          pageSize: 1,
          snapshotFreshness: 'ready',
          workloadClass: 'foregroundReviewFacet',
        },
        key: 'smoke-facet',
        observation: {
          latencyMs: 20,
          memoryRssBytes: 130_000_000,
          queueDepth: 3,
          rowsReturned: 16,
          rowsScanned: 48,
          tempUsageBytes: 128,
        },
        operationKey: 'overlapFacetRefresh',
      },
      {
        admissionRequest: {
          contractKey: 'review.rawFallback.rows',
          estimatedResultBytes: 10_000,
          estimatedResultRows: 10,
          pageSize: 10,
          snapshotFreshness: 'ready',
          workloadClass: 'foregroundReviewRows',
        },
        key: 'smoke-rejected-raw-fallback',
        observation: {
          latencyMs: 4,
          memoryRssBytes: 127_000_000,
          queueDepth: 3,
          rowsReturned: 10,
          rowsScanned: 10,
          tempUsageBytes: 256,
        },
        operationKey: 'llmPromptOverlapRows',
      },
    ],
  }
}

export const runReviewServingBenchmarkEffect = (input: ReviewServingBenchmarkRunInput) => {
  const executor = input.executor ?? getDefaultBenchmarkObservation

  return Effect.scoped(
    Effect.gen(function* () {
      const runState = yield* Effect.acquireRelease(getBenchmarkRunState(), releaseBenchmarkRunState)
      const samples = yield* Effect.forEach(input.workItems, (workItem) => {
        return runBenchmarkWorkItemEffect(workItem, executor)
      })
      const endRssBytes = sampleReviewServingBenchmarkMemoryRssBytes()

      return {
        fixture: input.fixture,
        metrics: getReviewServingBenchmarkMetrics({endRssBytes, samples, startRssBytes: runState.startRssBytes}),
        samples,
        workload: input.workload,
      }
    }),
  )
}

export const runReviewServingBenchmarkSmoke = () => {
  return Effect.runPromise(runReviewServingBenchmarkEffect(getReviewServingBenchmarkSmokeInput()))
}
