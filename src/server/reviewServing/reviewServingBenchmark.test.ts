import {expect, test} from 'bun:test'
import {Effect} from 'effect'

import {
  getReviewServingBenchmarkCoverageViolations,
  getReviewServingBenchmarkMetrics,
  getReviewServingBenchmarkPerformanceViolations,
  getReviewServingBenchmarkRequestCountViolations,
  getReviewServingBenchmarkRowsReturnedLimitViolations,
  getReviewServingBenchmarkRowsScannedViolations,
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

const getBenchmarkOperation = (operationKey: string) => {
  const operation = reviewServingBenchmarkOverlapWorkloadDefinition.operations.find((candidate) => {
    return candidate.key === operationKey
  })

  if (!operation) {
    throw new Error(`Missing benchmark operation ${operationKey}`)
  }

  return operation
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
    performanceTargets: {
      maxP95LatencyMs: 2_000,
      maxP99LatencyMs: 5_000,
      maxPeakRssBytes: 21_474_836_480,
      maxRssGrowthBytes: 4_294_967_296,
    },
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
      return (
        operation.contractKey === 'review.llm.count'
        && operation.namedCountKey === 'review.llm.assessedByPrompt'
        && operation.countFilterKeyPrefix === 'prompt:'
        && operation.minimumDistinctRequestSlices === 7
        && operation.requestSliceFields?.includes('filter')
        && operation.workloadClass === 'foregroundReviewCount'
      )
    }),
  ).toBe(true)
  expect(reviewServingBenchmarkOverlapWorkloadDefinition.operations).toHaveLength(28)
  expect(
    reviewServingBenchmarkOverlapWorkloadDefinition.operations.map((operation) => {
      return {contractKey: operation.contractKey, key: operation.key}
    }),
  ).toEqual([
    {contractKey: 'review.llm.rows', key: 'llmPromptOverlapRows'},
    {contractKey: 'review.human.rows', key: 'humanPromptOverlapRows'},
    {contractKey: 'review.both.rows', key: 'llmHumanOverlapRows'},
    {contractKey: 'review.unassessed.rows', key: 'unassessedOverlapRows'},
    {contractKey: 'review.filters.postings', key: 'filteredOverlapRows'},
    {contractKey: 'review.llm.rowsByArticleSet', key: 'filteredLlmRowsByArticleSet'},
    {contractKey: 'review.human.rowsByArticleSet', key: 'filteredHumanRowsByArticleSet'},
    {contractKey: 'review.both.rowsByArticleSet', key: 'filteredBothRowsByArticleSet'},
    {contractKey: 'review.unassessed.rowsByArticleSet', key: 'filteredUnassessedRowsByArticleSet'},
    {contractKey: 'review.filters.facets', key: 'overlapFacetRefresh'},
    {contractKey: 'review.human.filters.facets', key: 'humanOverlapFacetRefresh'},
    {contractKey: 'review.filters.options', key: 'overlapFilterOptions'},
    {contractKey: 'review.human.filters.options', key: 'humanOverlapFilterOptions'},
    {contractKey: 'review.detail.judgments', key: 'detailJudgmentPayloadRows'},
    {contractKey: 'review.human.list.judgments', key: 'humanListJudgmentPayloadRows'},
    {contractKey: 'review.llm.list.judgments', key: 'llmListJudgmentPayloadRows'},
    {contractKey: 'review.both.list.judgments', key: 'bothListJudgmentPayloadRows'},
    {contractKey: 'review.both.list.humanJudgments', key: 'bothListHumanJudgmentPayloadRows'},
    {contractKey: 'review.llm.count', key: 'llmPromptOverlapCounts'},
    {contractKey: 'review.human.count', key: 'humanPromptOverlapCounts'},
    {contractKey: 'review.both.count', key: 'bothPromptOverlapCounts'},
    {contractKey: 'review.unassessed.count', key: 'unassessedPromptOverlapCounts'},
    {contractKey: 'review.bulk.selection', key: 'bulkOverlapSelectionJob'},
    {contractKey: 'review.export.selection', key: 'exportOverlapSelectionJob'},
    {contractKey: 'review.pdf.selection', key: 'pdfOverlapSelectionJob'},
    {contractKey: 'review.search.substringAsync', key: 'substringOverlapSearchJob'},
    {contractKey: 'review.queue.unassessed', key: 'unassessedOverlapQueue'},
    {contractKey: 'review.search.tokenPrefix', key: 'titlePrefixOverlapSearch'},
  ])
  expect(getBenchmarkOperation('llmPromptOverlapRows')).toMatchObject({
    maxRowsScannedPerRequest: 300,
    minimumDistinctRequestSlices: 7_000,
    requestSliceFields: ['cursor'],
  })
  expect(getBenchmarkOperation('filteredOverlapRows')).toMatchObject({
    contractKey: 'review.filters.postings',
    maxRowsScannedPerRequest: 300,
    minimumDistinctRequestSlices: 7_000,
    pageSize: 100,
    requestSliceFields: ['cursor', 'filter', 'listMode', 'searchTokenPrefix'],
    searchMode: 'tokenPrefix',
    workloadClass: 'foregroundReviewRows',
  })
  expect(
    [
      'filteredLlmRowsByArticleSet',
      'filteredHumanRowsByArticleSet',
      'filteredBothRowsByArticleSet',
      'filteredUnassessedRowsByArticleSet',
    ].map((operationKey) => {
      const operation = getBenchmarkOperation(operationKey)

      return {
        contractKey: operation.contractKey,
        maxRowsScannedPerRequest: operation.maxRowsScannedPerRequest,
        requestSliceFields: operation.requestSliceFields,
        workloadClass: operation.workloadClass,
      }
    }),
  ).toEqual([
    {
      contractKey: 'review.llm.rowsByArticleSet',
      maxRowsScannedPerRequest: 100,
      requestSliceFields: ['filter', 'listMode'],
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.human.rowsByArticleSet',
      maxRowsScannedPerRequest: 100,
      requestSliceFields: ['filter', 'listMode'],
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.both.rowsByArticleSet',
      maxRowsScannedPerRequest: 100,
      requestSliceFields: ['filter', 'listMode'],
      workloadClass: 'foregroundReviewRows',
    },
    {
      contractKey: 'review.unassessed.rowsByArticleSet',
      maxRowsScannedPerRequest: 100,
      requestSliceFields: ['filter', 'listMode'],
      workloadClass: 'foregroundReviewRows',
    },
  ])
  expect(getBenchmarkOperation('overlapFacetRefresh')).toMatchObject({
    maxRowsScannedPerRequest: 512,
    minimumDistinctRequestSlices: 700,
    pageSize: 128,
    requestSliceFields: ['filter'],
  })
  expect(getBenchmarkOperation('humanOverlapFacetRefresh')).toMatchObject({
    contractKey: 'review.human.filters.facets',
    maxRowsScannedPerRequest: 512,
    minimumDistinctRequestSlices: 700,
    pageSize: 128,
    requestSliceFields: ['filter'],
    workloadClass: 'foregroundReviewFacet',
  })
  expect(getBenchmarkOperation('overlapFilterOptions')).toMatchObject({
    contractKey: 'review.filters.options',
    maxRowsScannedPerRequest: 512,
    minimumDistinctRequestSlices: 700,
    pageSize: 512,
    requestSliceFields: ['filter', 'searchTokenPrefix'],
    searchMode: 'tokenPrefix',
    workloadClass: 'foregroundReviewFacet',
  })
  expect(getBenchmarkOperation('humanOverlapFilterOptions')).toMatchObject({
    contractKey: 'review.human.filters.options',
    maxRowsScannedPerRequest: 512,
    minimumDistinctRequestSlices: 700,
    pageSize: 512,
    requestSliceFields: ['filter', 'searchTokenPrefix'],
    searchMode: 'tokenPrefix',
    workloadClass: 'foregroundReviewFacet',
  })
  expect(getBenchmarkOperation('detailJudgmentPayloadRows')).toMatchObject({
    contractKey: 'review.detail.judgments',
    maxRowsScannedPerRequest: 512,
    minimumDistinctRequestSlices: 700,
    pageSize: 512,
    requestSliceFields: ['filter'],
    workloadClass: 'foregroundReviewRows',
  })
  expect(getBenchmarkOperation('humanListJudgmentPayloadRows')).toMatchObject({
    contractKey: 'review.human.list.judgments',
    maxRowsScannedPerRequest: 10_000,
    minimumDistinctRequestSlices: 7_000,
    pageSize: 10_000,
    requestSliceFields: ['cursor', 'filter'],
    targetRowsReturnedPerRequest: 700,
    workloadClass: 'foregroundReviewRows',
  })
  expect(getBenchmarkOperation('llmListJudgmentPayloadRows')).toMatchObject({
    contractKey: 'review.llm.list.judgments',
    maxRowsScannedPerRequest: 10_000,
    minimumDistinctRequestSlices: 7_000,
    pageSize: 10_000,
    requestSliceFields: ['cursor', 'filter'],
    targetRowsReturnedPerRequest: 700,
    workloadClass: 'foregroundReviewRows',
  })
  expect(getBenchmarkOperation('bothListJudgmentPayloadRows')).toMatchObject({
    contractKey: 'review.both.list.judgments',
    maxRowsScannedPerRequest: 10_000,
    minimumDistinctRequestSlices: 7_000,
    pageSize: 10_000,
    requestSliceFields: ['cursor', 'filter'],
    targetRowsReturnedPerRequest: 700,
    workloadClass: 'foregroundReviewRows',
  })
  expect(getBenchmarkOperation('bothListHumanJudgmentPayloadRows')).toMatchObject({
    contractKey: 'review.both.list.humanJudgments',
    maxRowsScannedPerRequest: 10_000,
    minimumDistinctRequestSlices: 7_000,
    pageSize: 10_000,
    requestSliceFields: ['cursor', 'filter'],
    targetRowsReturnedPerRequest: 700,
    workloadClass: 'foregroundReviewRows',
  })
  expect(getBenchmarkOperation('unassessedOverlapQueue')).toMatchObject({
    contractKey: 'review.queue.unassessed',
    requestSliceFields: ['cursor', 'filter', 'queueKind'],
    workloadClass: 'foregroundReviewQueue',
  })
  expect(
    ['bulkOverlapSelectionJob', 'exportOverlapSelectionJob', 'pdfOverlapSelectionJob', 'substringOverlapSearchJob'].map(
      (operationKey) => {
        const operation = getBenchmarkOperation(operationKey)

        return {key: operation.key, targetRowsReturnedPerRequest: operation.targetRowsReturnedPerRequest}
      },
    ),
  ).toEqual([
    {key: 'bulkOverlapSelectionJob', targetRowsReturnedPerRequest: 1},
    {key: 'exportOverlapSelectionJob', targetRowsReturnedPerRequest: 1},
    {key: 'pdfOverlapSelectionJob', targetRowsReturnedPerRequest: 1},
    {key: 'substringOverlapSearchJob', targetRowsReturnedPerRequest: 1},
  ])
  expect(
    reviewServingBenchmarkOverlapWorkloadDefinition.operations.some((operation) => {
      return operation.contractKey === 'review.bulk.selection' && operation.jobKind === 'review.bulk.selection'
    }),
  ).toBe(true)
  expect(
    reviewServingBenchmarkOverlapWorkloadDefinition.operations.some((operation) => {
      return operation.contractKey === 'review.search.substringAsync' && operation.searchTextPrefix === 'overlap '
    }),
  ).toBe(true)
  expect(
    reviewServingBenchmarkOverlapWorkloadDefinition.operations.some((operation) => {
      return operation.contractKey === 'review.search.tokenPrefix' && operation.searchMode === 'tokenPrefix'
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
  ).toEqual(
    Array.from({length: 28}, () => {
      return 1
    }),
  )
  expect(
    result.samples.map((sample) => {
      return sample.admissionStatus
    }),
  ).toEqual(
    Array.from({length: 28}, () => {
      return 'accepted'
    }),
  )
  expect(result.metrics).toMatchObject({
    latency: {p50Ms: 10, p95Ms: 20, p99Ms: 20, sampleCount: 28},
    queueDepth: {average: 1.25, peak: 3},
    rows: {rowsReturned: 159, rowsScanned: 356},
    tempUsage: {peakBytes: 0, totalBytes: 0},
    work: {admitted: 28, rejected: 0, total: 28},
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
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'humanPromptOverlapRows'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'llmHumanOverlapRows'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'unassessedOverlapRows'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'filteredOverlapRows'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'filteredLlmRowsByArticleSet'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'filteredHumanRowsByArticleSet'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'filteredBothRowsByArticleSet'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'filteredUnassessedRowsByArticleSet'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'overlapFacetRefresh'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'humanOverlapFacetRefresh'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'overlapFilterOptions'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'humanOverlapFilterOptions'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'detailJudgmentPayloadRows'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'humanListJudgmentPayloadRows'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'llmListJudgmentPayloadRows'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'bothListJudgmentPayloadRows'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'bothListHumanJudgmentPayloadRows'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'llmPromptOverlapCounts'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'humanPromptOverlapCounts'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'bothPromptOverlapCounts'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'unassessedPromptOverlapCounts'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'bulkOverlapSelectionJob'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'exportOverlapSelectionJob'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'pdfOverlapSelectionJob'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'substringOverlapSearchJob'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'unassessedOverlapQueue'},
    {actualRequestCount: 0, expectedRequestCount: 1, operationKey: 'titlePrefixOverlapSearch'},
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

test('review-serving benchmark rejects dimensions that the declared operation omits', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const mismatchedWorkItem = {
    ...input.workItems[0],
    admissionRequest: {
      ...input.workItems[0].admissionRequest,
      namedCountKey: 'review.llm.assessedByPrompt' as const,
      searchMode: 'tokenPrefix' as const,
    },
    jobFilterSignature: 'phase5-overlap:unexpected',
    jobKind: 'review.bulk.selection',
  }
  const mismatchedInput = {...input, workItems: [mismatchedWorkItem, ...input.workItems.slice(1)]}

  expect(getReviewServingBenchmarkWorkItemShapeViolations(mismatchedInput, mismatchedWorkItem)).toEqual([
    {actual: 'review.llm.assessedByPrompt', expected: null, field: 'namedCountKey', key: 'smoke-llm-page'},
    {actual: 'review.bulk.selection', expected: null, field: 'jobKind', key: 'smoke-llm-page'},
    {actual: 'tokenPrefix', expected: null, field: 'searchMode', key: 'smoke-llm-page'},
    {actual: 'phase5-overlap:unexpected', expected: null, field: 'jobFilterSignaturePrefix', key: 'smoke-llm-page'},
  ])
  expect(await getBenchmarkRunFailureMessage(mismatchedInput)).toContain('Review-serving benchmark work item mismatch')
})

test('review-serving benchmark rejects count operations with the wrong count shape', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const countWorkItem = input.workItems.find((workItem) => {
    return workItem.operationKey === 'llmPromptOverlapCounts'
  })

  if (!countWorkItem) {
    throw new Error('Missing smoke count work item')
  }

  const mismatchedWorkItem = {
    ...countWorkItem,
    admissionRequest: {
      ...countWorkItem.admissionRequest,
      countFilterKey: 'list:all',
      countState: {
        availability: 'ready' as const,
        filterKey: 'list:all',
        key: 'review.list.total' as const,
        snapshotId: 'smoke-snapshot',
        value: 10,
      },
      namedCountKey: 'review.list.total',
    },
  }
  const mismatchedInput = {
    ...input,
    workItems: input.workItems.map((workItem) => {
      return workItem.operationKey === 'llmPromptOverlapCounts' ? mismatchedWorkItem : workItem
    }),
  }

  expect(getReviewServingBenchmarkWorkItemShapeViolations(mismatchedInput, mismatchedWorkItem)).toEqual([
    {
      actual: 'review.list.total',
      expected: 'review.llm.assessedByPrompt',
      field: 'namedCountKey',
      key: 'smoke-llm-count',
    },
    {actual: 'list:all', expected: 'prompt:*', field: 'countFilterKeyPrefix', key: 'smoke-llm-count'},
    {actual: 'filter:prompt:1', expected: 'filter:list:all', field: 'requestSlice', key: 'smoke-llm-count'},
  ])
  expect(await getBenchmarkRunFailureMessage(mismatchedInput)).toContain('Review-serving benchmark work item mismatch')
})

test('review-serving benchmark rejects durable job operations with the wrong criteria shape', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const bulkWorkItem = input.workItems.find((workItem) => {
    return workItem.operationKey === 'bulkOverlapSelectionJob'
  })

  if (!bulkWorkItem) {
    throw new Error('Missing smoke bulk work item')
  }

  const mismatchedWorkItem = {...bulkWorkItem, jobFilterSignature: 'other:bulk:smoke', jobKind: 'review.pdf.selection'}
  const mismatchedInput = {
    ...input,
    workItems: input.workItems.map((workItem) => {
      return workItem.operationKey === 'bulkOverlapSelectionJob' ? mismatchedWorkItem : workItem
    }),
  }

  expect(getReviewServingBenchmarkWorkItemShapeViolations(mismatchedInput, mismatchedWorkItem)).toEqual([
    {
      actual: 'review.pdf.selection',
      expected: 'review.bulk.selection',
      field: 'jobKind',
      key: 'smoke-bulk-selection-job',
    },
    {
      actual: 'other:bulk:smoke',
      expected: 'phase5-overlap:*',
      field: 'jobFilterSignaturePrefix',
      key: 'smoke-bulk-selection-job',
    },
  ])
  expect(await getBenchmarkRunFailureMessage(mismatchedInput)).toContain('Review-serving benchmark work item mismatch')
})

test('review-serving benchmark rejects queue work items without a declared queue kind slice', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const queueWorkItem = input.workItems.find((workItem) => {
    return workItem.operationKey === 'unassessedOverlapQueue'
  })

  if (!queueWorkItem) {
    throw new Error('Missing smoke queue work item')
  }

  const mismatchedWorkItem = {...queueWorkItem, queueKind: undefined, requestSlice: {cursor: 'start', filter: 'all'}}
  const mismatchedInput = {
    ...input,
    workItems: input.workItems.map((workItem) => {
      return workItem.operationKey === 'unassessedOverlapQueue' ? mismatchedWorkItem : workItem
    }),
  }

  expect(getReviewServingBenchmarkWorkItemShapeViolations(mismatchedInput, mismatchedWorkItem)).toEqual([
    {
      actual: 'missing:queueKind',
      expected: 'queueKind',
      field: 'requestSlice',
      key: 'smoke-unassessed-queue',
    },
  ])
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

test('review-serving benchmark rejects samples over scanned row ceilings', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const samples = [
    {
      admissionStatus: 'accepted' as const,
      contractKey: 'review.llm.rows',
      key: 'sample-wide-scan',
      latencyMs: 1,
      memoryRssBytes: 1,
      operationKey: 'llmPromptOverlapRows',
      queueDepth: 0,
      rejectionReason: null,
      rowsReturned: 12,
      rowsScanned: 301,
      tempUsageBytes: 0,
    },
  ]

  expect(getReviewServingBenchmarkRowsScannedViolations(input, samples)).toEqual([
    {actualRowsScanned: 301, expectedRowsScanned: 300, key: 'sample-wide-scan', operationKey: 'llmPromptOverlapRows'},
  ])
  expect(
    await getBenchmarkRunFailureMessage({
      ...input,
      executor: (workItem) => {
        return Effect.succeed({...workItem.observation, rowsScanned: 301})
      },
    }),
  ).toContain('Review-serving benchmark rows scanned mismatch')
})

test('review-serving benchmark rejects repeated request slices', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const operation = input.workload.operations[0]
  const firstWorkItem = input.workItems[0]
  const duplicatedCoverageInput = {
    ...input,
    workload: {...input.workload, operations: [{...operation, minimumDistinctRequestSlices: 2, requestCount: 2}]},
    workItems: [firstWorkItem, {...firstWorkItem, key: 'smoke-llm-page-repeat'}],
  }

  expect(getReviewServingBenchmarkCoverageViolations(duplicatedCoverageInput)).toEqual([
    {actualDistinctCoverageKeys: 1, expectedDistinctCoverageKeys: 2, operationKey: 'llmPromptOverlapRows'},
  ])
  expect(await getBenchmarkRunFailureMessage(duplicatedCoverageInput)).toContain(
    'Review-serving benchmark coverage mismatch',
  )
})

test('review-serving benchmark request slices must match actual request fields', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const countWorkItem = input.workItems.find((workItem) => {
    return workItem.operationKey === 'llmPromptOverlapCounts'
  })

  if (!countWorkItem) {
    throw new Error('Missing smoke count work item')
  }

  const mismatchedWorkItem = {...countWorkItem, requestSlice: {filter: 'prompt:2'}}
  const mismatchedInput = {
    ...input,
    workItems: input.workItems.map((workItem) => {
      return workItem.operationKey === 'llmPromptOverlapCounts' ? mismatchedWorkItem : workItem
    }),
  }

  expect(getReviewServingBenchmarkWorkItemShapeViolations(mismatchedInput, mismatchedWorkItem)).toEqual([
    {actual: 'filter:prompt:2', expected: 'filter:prompt:1', field: 'requestSlice', key: 'smoke-llm-count'},
  ])
  expect(await getBenchmarkRunFailureMessage(mismatchedInput)).toContain('Review-serving benchmark work item mismatch')
})

test('review-serving benchmark rejects samples above declared page caps', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const samples = [
    {
      admissionStatus: 'accepted' as const,
      contractKey: 'review.llm.rows',
      key: 'sample-wide-page',
      latencyMs: 1,
      memoryRssBytes: 1,
      operationKey: 'llmPromptOverlapRows',
      queueDepth: 0,
      rejectionReason: null,
      rowsReturned: 13,
      rowsScanned: 13,
      tempUsageBytes: 0,
    },
  ]

  expect(getReviewServingBenchmarkRowsReturnedLimitViolations(input, samples)).toEqual([
    {
      actualRowsReturned: 13,
      expectedMaxRowsReturned: 12,
      key: 'sample-wide-page',
      operationKey: 'llmPromptOverlapRows',
    },
  ])
  expect(
    await getBenchmarkRunFailureMessage({
      ...input,
      executor: (workItem) => {
        return Effect.succeed({...workItem.observation, rowsReturned: workItem.observation.rowsReturned + 1})
      },
    }),
  ).toContain('Review-serving benchmark rows returned limit mismatch')
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

test('review-serving benchmark rejects latency and memory target violations', async () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const metrics = getReviewServingBenchmarkMetrics({
    endRssBytes: 1_600,
    samples: [
      {
        admissionStatus: 'accepted' as const,
        contractKey: 'review.llm.rows',
        key: 'sample-slow',
        latencyMs: 2_001,
        memoryRssBytes: 1_600,
        operationKey: 'llmPromptOverlapRows',
        queueDepth: 0,
        rejectionReason: null,
        rowsReturned: 12,
        rowsScanned: 12,
        tempUsageBytes: 0,
      },
    ],
    startRssBytes: 100,
  })
  const tightTargets = {
    maxP95LatencyMs: 2_000,
    maxP99LatencyMs: 2_000,
    maxPeakRssBytes: 1_000,
    maxRssGrowthBytes: 1_000,
  }

  expect(getReviewServingBenchmarkPerformanceViolations(metrics, tightTargets)).toEqual([
    {actual: 2_001, expected: 2_000, metric: 'latency.p95Ms'},
    {actual: 2_001, expected: 2_000, metric: 'latency.p99Ms'},
    {actual: 1_600, expected: 1_000, metric: 'memory.peakRssBytes'},
    {actual: 1_500, expected: 1_000, metric: 'memory.rssGrowthBytes'},
  ])
  expect(
    await getBenchmarkRunFailureMessage({
      ...input,
      executor: (workItem) => {
        return Effect.succeed({...workItem.observation, latencyMs: 2_001})
      },
      workload: {...input.workload, performanceTargets: {...input.workload.performanceTargets, maxP95LatencyMs: 2_000}},
    }),
  ).toContain('Review-serving benchmark performance target mismatch')
})

test('review-serving benchmark rejects per-operation latency target violations', () => {
  const input = getReviewServingBenchmarkSmokeInput()
  const metrics = getReviewServingBenchmarkMetrics({
    endRssBytes: 100,
    samples: input.workItems.map((workItem) => {
      return {
        ...workItem.observation,
        admissionStatus: 'accepted' as const,
        contractKey: workItem.admissionRequest.contractKey,
        key: workItem.key,
        latencyMs: 1,
        operationKey: workItem.operationKey,
        rejectionReason: null,
      }
    }),
    startRssBytes: 100,
  })
  const slowMinoritySamples = input.workItems.map((workItem) => {
    return {
      ...workItem.observation,
      admissionStatus: 'accepted' as const,
      contractKey: workItem.admissionRequest.contractKey,
      key: workItem.key,
      latencyMs: workItem.operationKey === 'pdfOverlapSelectionJob' ? 2_001 : 1,
      operationKey: workItem.operationKey,
      rejectionReason: null,
    }
  })

  expect(
    getReviewServingBenchmarkPerformanceViolations(metrics, input.workload.performanceTargets, slowMinoritySamples),
  ).toContainEqual({actual: 2_001, expected: 2_000, metric: 'latency.p95Ms', operationKey: 'pdfOverlapSelectionJob'})
})
