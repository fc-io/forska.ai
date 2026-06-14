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

export type ReviewServingBenchmarkRequestCountViolation = {
  actualRequestCount: number
  expectedRequestCount: number
  operationKey: string
}

export type ReviewServingBenchmarkWorkItemShapeViolation = {
  actual: string | number | null
  expected: string | number | null
  field: 'contractKey' | 'operationKey' | 'pageSize' | 'workloadClass'
  key: string
}

export type ReviewServingBenchmarkRowTargetViolation = {
  actualRowsReturned: number
  expectedRowsReturned: number
  key: string
  operationKey: string
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

  return [
    {
      actual: workItem.admissionRequest.contractKey,
      expected: operation.contractKey,
      field: 'contractKey',
      key: workItem.key,
    },
    {
      actual: workItem.admissionRequest.pageSize ?? null,
      expected: operation.pageSize,
      field: 'pageSize',
      key: workItem.key,
    },
    {
      actual: workItem.admissionRequest.workloadClass,
      expected: operation.workloadClass,
      field: 'workloadClass',
      key: workItem.key,
    },
  ].filter((violation) => {
    return violation.actual !== violation.expected
  })
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

const getReviewServingBenchmarkRowTargetViolationMessage = (
  violations: readonly ReviewServingBenchmarkRowTargetViolation[],
) => {
  return violations
    .map((violation) => {
      return `${violation.key}.${violation.operationKey}: expected ${violation.expectedRowsReturned}, got ${violation.actualRowsReturned}`
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

const validateReviewServingBenchmarkRequestCounts = (input: ReviewServingBenchmarkRunInput) => {
  const shapeViolations = input.workItems.flatMap((workItem) => {
    return getReviewServingBenchmarkWorkItemShapeViolations(input, workItem)
  })
  const violations = getReviewServingBenchmarkRequestCountViolations(input)
  const fixtureMismatch = getReviewServingBenchmarkFixtureMismatch(input)
  const message = violations
    .map((violation) => {
      return `${violation.operationKey}: expected ${violation.expectedRequestCount}, got ${violation.actualRequestCount}`
    })
    .join('; ')

  if (fixtureMismatch) {
    return Effect.fail(new Error(`Review-serving benchmark fixture mismatch: ${fixtureMismatch}`))
  }

  if (shapeViolations.length > 0) {
    return Effect.fail(
      new Error(
        `Review-serving benchmark work item mismatch: ${getReviewServingBenchmarkWorkItemShapeViolationMessage(shapeViolations)}`,
      ),
    )
  }

  return violations.length === 0
    ? Effect.void
    : Effect.fail(new Error(`Review-serving benchmark request count mismatch: ${message}`))
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
          pageSize: 12,
          requestCount: 1,
          targetRowsReturnedPerRequest: 12,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[1],
          pageSize: 10,
          requestCount: 1,
          targetRowsReturnedPerRequest: 10,
        },
        {
          ...reviewServingBenchmarkOverlapWorkloadDefinition.operations[2],
          pageSize: 1,
          requestCount: 1,
          targetRowsReturnedPerRequest: 16,
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
