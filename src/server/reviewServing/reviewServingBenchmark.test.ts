import {expect, test} from 'bun:test'
import {Effect} from 'effect'

import {
  getReviewServingBenchmarkMetrics,
  getReviewServingBenchmarkRequestCountViolations,
  getReviewServingBenchmarkRowTargetViolations,
  getReviewServingBenchmarkSmokeInput,
  getReviewServingBenchmarkTempSpillViolations,
  getReviewServingBenchmarkWorkItemShapeViolations,
  reviewServingBenchmarkOverlapWorkloadDefinition,
  reviewServingBenchmarkPhase5ReleaseGate,
  reviewServingSynthetic10m7PromptOverlapFixture,
  runReviewServingBenchmarkEffect,
  runReviewServingBenchmarkSmoke,
} from './reviewServingBenchmark.ts'

const getBenchmarkRunFailureMessage = async (input: Parameters<typeof runReviewServingBenchmarkEffect>[0]) => {
  return Effect.runPromise(runReviewServingBenchmarkEffect(input)).then(
    () => {
      return ''
    },
    (error) => {
      return String(error)
    },
  )
}

test('review-serving benchmark documents the full 10M article and 7 prompt overlap release gate', () => {
  expect(reviewServingSynthetic10m7PromptOverlapFixture).toEqual({
    articleCount: 10_000_000,
    articlePromptOverlapRows: 70_000_000,
    kind: 'synthetic10m7PromptOverlap',
    promptCount: 7,
    requiresCompletedSchemaProjectors: true,
  })
  expect(reviewServingBenchmarkOverlapWorkloadDefinition).toMatchObject({
    fixtureKind: 'synthetic10m7PromptOverlap',
    key: 'reviewServing.10m7PromptOverlap.v1',
    releaseGatePhase: 'Phase 5',
    requiredForPhase0: false,
  })
  expect(reviewServingBenchmarkPhase5ReleaseGate).toEqual({
    fixtureKind: 'synthetic10m7PromptOverlap',
    requiredForPhase0: false,
    releaseGatePhase: 'Phase 5',
    workloadKey: 'reviewServing.10m7PromptOverlap.v1',
  })
  expect(
    reviewServingBenchmarkOverlapWorkloadDefinition.operations.some((operation) => {
      return operation.contractKey === 'review.llm.count' && operation.workloadClass === 'foregroundReviewCount'
    }),
  ).toBe(true)
})

test('review-serving smoke benchmark runs against mocked inputs without completed schema or projectors', async () => {
  const result = await runReviewServingBenchmarkSmoke()

  expect(result.fixture).toMatchObject({kind: 'smoke', requiresCompletedSchemaProjectors: false})
  expect(result.workload).toMatchObject({
    fixtureKind: 'smoke',
    key: 'reviewServing.smokeOverlap.v1',
    releaseGatePhase: 'Phase 5',
    requiredForPhase0: false,
  })
  expect(
    result.workload.operations.map((operation) => {
      return operation.requestCount
    }),
  ).toEqual([1, 1, 1, 1])
  expect(
    result.samples.map((sample) => {
      return sample.admissionStatus
    }),
  ).toEqual(['accepted', 'accepted', 'accepted', 'accepted'])
  expect(result.metrics).toMatchObject({
    latency: {p50Ms: 8, p95Ms: 20, p99Ms: 20, sampleCount: 4},
    queueDepth: {average: 1.75, peak: 3},
    rows: {rowsReturned: 39, rowsScanned: 103},
    tempUsage: {peakBytes: 0, totalBytes: 0},
    work: {admitted: 4, rejected: 0, total: 4},
  })
  expect(result.metrics.memory.peakRssBytes).toBeGreaterThanOrEqual(result.metrics.memory.startRssBytes)
})

test('review-serving benchmark metrics shape keeps latency, memory, temp, queue, row, and work counters explicit', () => {
  const metrics = getReviewServingBenchmarkMetrics({
    endRssBytes: 115,
    samples: [
      {
        admissionStatus: 'accepted',
        contractKey: 'review.llm.rows',
        key: 'sample-1',
        latencyMs: 10,
        memoryRssBytes: 110,
        operationKey: 'llmPromptOverlapRows',
        queueDepth: 2,
        rejectionReason: null,
        rowsReturned: 5,
        rowsScanned: 10,
        tempUsageBytes: 20,
      },
      {
        admissionStatus: 'rejected',
        contractKey: 'review.rawFallback.rows',
        key: 'sample-2',
        latencyMs: 40,
        memoryRssBytes: 120,
        operationKey: 'llmPromptOverlapRows',
        queueDepth: 4,
        rejectionReason: 'unregisteredContract',
        rowsReturned: 0,
        rowsScanned: 0,
        tempUsageBytes: 0,
      },
    ],
    startRssBytes: 100,
  })

  expect(metrics).toEqual({
    latency: {p50Ms: 10, p95Ms: 40, p99Ms: 40, sampleCount: 2},
    memory: {endRssBytes: 115, peakRssBytes: 120, startRssBytes: 100},
    queueDepth: {average: 3, peak: 4},
    rows: {rowsReturned: 5, rowsScanned: 10},
    tempUsage: {peakBytes: 20, totalBytes: 20},
    work: {admitted: 1, rejected: 1, total: 2},
  })
})

test('review-serving benchmark runner can use an injected executor for later real workload phases', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const singleWorkItemInput = {
    ...input,
    workload: {...input.workload, operations: [{...input.workload.operations[0], requestCount: 1}]},
    workItems: input.workItems.slice(0, 1),
  }
  const result = await Effect.runPromise(
    runReviewServingBenchmarkEffect({
      ...singleWorkItemInput,
      executor: (workItem) => {
        return Effect.succeed({...workItem.observation, latencyMs: workItem.observation.latencyMs + 1})
      },
    }),
  )

  expect(result.samples).toHaveLength(1)
  expect(result.metrics.latency).toMatchObject({p50Ms: 9, p95Ms: 9, p99Ms: 9, sampleCount: 1})
  expect(result.metrics.work).toEqual({admitted: 1, rejected: 0, total: 1})
})

test('review-serving benchmark rejects runs that do not satisfy operation request counts', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const underSampledInput = {...input, workItems: input.workItems.slice(0, 1)}

  expect(getReviewServingBenchmarkRequestCountViolations(underSampledInput)).toEqual([
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'llmHumanOverlapRows'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'overlapFacetRefresh'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'llmPromptOverlapCounts'},
  ])
  const failureMessage = await getBenchmarkRunFailureMessage(underSampledInput)

  expect(failureMessage).toContain('Review-serving benchmark request count mismatch')
})

test('review-serving benchmark rejects work items that do not match the declared operation', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const mismatchedWorkItem = {
    ...input.workItems[0],
    admissionRequest: {...input.workItems[0].admissionRequest, contractKey: 'review.rawFallback.rows'},
  }
  const mismatchedInput = {...input, workItems: [mismatchedWorkItem, ...input.workItems.slice(1)]}

  expect(getReviewServingBenchmarkWorkItemShapeViolations(mismatchedInput, mismatchedWorkItem)).toEqual([
    {actual: 'review.rawFallback.rows', expected: 'review.llm.rows', field: 'contractKey', key: 'smoke-llm-page'},
  ])
  expect(getReviewServingBenchmarkRequestCountViolations(mismatchedInput)).toContainEqual({
    actualRequestCount: 0,
    expectedRequestCount: 1,
    operationKey: 'llmPromptOverlapRows',
  })
  expect(await getBenchmarkRunFailureMessage(mismatchedInput)).toContain('Review-serving benchmark work item mismatch')
})

test('review-serving benchmark rejects fixture and workload kind mismatches', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const mismatchedInput = {...input, workload: {...input.workload, fixtureKind: 'synthetic10m7PromptOverlap' as const}}

  expect(await getBenchmarkRunFailureMessage(mismatchedInput)).toContain('Review-serving benchmark fixture mismatch')
})

test('review-serving benchmark rejects synthetic runs without the canonical release workload', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const tinySyntheticInput = {
    ...input,
    fixture: reviewServingSynthetic10m7PromptOverlapFixture,
    workload: {
      ...reviewServingBenchmarkOverlapWorkloadDefinition,
      operations: [{...reviewServingBenchmarkOverlapWorkloadDefinition.operations[0], requestCount: 1}],
    },
    workItems: input.workItems.slice(0, 1),
  }

  expect(await getBenchmarkRunFailureMessage(tinySyntheticInput)).toContain(
    'Review-serving benchmark workload mismatch',
  )
})

test('review-serving benchmark rejects incomplete canonical fixture properties', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const mismatchedInput = {...input, fixture: {...input.fixture, articleCount: 1}}

  expect(await getBenchmarkRunFailureMessage(mismatchedInput)).toContain('Review-serving benchmark fixture mismatch')
})

test('review-serving benchmark rejects samples below declared row targets', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const samples = [
    {
      admissionStatus: 'accepted' as const,
      contractKey: 'review.llm.rows',
      key: 'sample-low-row-count',
      latencyMs: 1,
      memoryRssBytes: 1,
      operationKey: 'llmPromptOverlapRows',
      queueDepth: 0,
      rejectionReason: null,
      rowsReturned: 0,
      rowsScanned: 0,
      tempUsageBytes: 0,
    },
  ]

  expect(getReviewServingBenchmarkRowTargetViolations(input, samples)).toEqual([
    {
      actualRowsReturned: 0,
      expectedRowsReturned: 12,
      key: 'sample-low-row-count',
      operationKey: 'llmPromptOverlapRows',
    },
  ])
  expect(
    await getBenchmarkRunFailureMessage({
      ...input,
      executor: (workItem) => {
        return Effect.succeed({...workItem.observation, rowsReturned: 0})
      },
    }),
  ).toContain('Review-serving benchmark row target mismatch')
})

test('review-serving benchmark rejects temp spill observations', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const spilledInput = {
    ...input,
    workItems: input.workItems.map((workItem, index) => {
      return index === 0 ? {...workItem, observation: {...workItem.observation, tempUsageBytes: 1}} : workItem
    }),
  }
  const spilledSamples = [
    {
      admissionStatus: 'accepted' as const,
      contractKey: 'review.llm.rows',
      key: 'sample-spill',
      latencyMs: 1,
      memoryRssBytes: 1,
      operationKey: 'llmPromptOverlapRows',
      queueDepth: 0,
      rejectionReason: null,
      rowsReturned: 12,
      rowsScanned: 12,
      tempUsageBytes: 1,
    },
  ]

  expect(getReviewServingBenchmarkTempSpillViolations(spilledSamples)).toEqual([
    {key: 'sample-spill', operationKey: 'llmPromptOverlapRows', tempUsageBytes: 1},
  ])
  expect(await getBenchmarkRunFailureMessage(spilledInput)).toContain('Review-serving benchmark temp spill mismatch')
})
