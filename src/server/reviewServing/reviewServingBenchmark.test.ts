import {expect, test} from 'bun:test'
import {Effect} from 'effect'

import {
  getReviewServingBenchmarkMetrics,
  getReviewServingBenchmarkSmokeInput,
  reviewServingBenchmarkOverlapWorkloadDefinition,
  reviewServingBenchmarkPhase5ReleaseGate,
  reviewServingSynthetic10m7PromptOverlapFixture,
  runReviewServingBenchmarkEffect,
  runReviewServingBenchmarkSmoke,
} from './reviewServingBenchmark.ts'

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
    result.samples.map((sample) => {
      return sample.admissionStatus
    }),
  ).toEqual(['accepted', 'accepted', 'accepted', 'rejected'])
  expect(result.samples.at(-1)).toMatchObject({
    key: 'smoke-rejected-raw-fallback',
    rejectionReason: 'unregisteredContract',
    rowsReturned: 0,
    rowsScanned: 0,
    tempUsageBytes: 0,
  })
  expect(result.metrics).toMatchObject({
    latency: {p50Ms: 8, p95Ms: 20, p99Ms: 20, sampleCount: 4},
    queueDepth: {average: 2.25, peak: 3},
    rows: {rowsReturned: 38, rowsScanned: 102},
    tempUsage: {peakBytes: 128, totalBytes: 192},
    work: {admitted: 3, rejected: 1, total: 4},
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
  const result = await Effect.runPromise(
    runReviewServingBenchmarkEffect({
      ...input,
      executor: (workItem) => {
        return Effect.succeed({...workItem.observation, latencyMs: workItem.observation.latencyMs + 1})
      },
      workItems: input.workItems.slice(0, 1),
    }),
  )

  expect(result.samples).toHaveLength(1)
  expect(result.metrics.latency).toMatchObject({p50Ms: 9, p95Ms: 9, p99Ms: 9, sampleCount: 1})
  expect(result.metrics.work).toEqual({admitted: 1, rejected: 0, total: 1})
})
