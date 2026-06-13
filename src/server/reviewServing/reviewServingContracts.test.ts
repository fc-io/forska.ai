import {expect, test} from 'bun:test'

import {
  isNamedReviewFastCountKey,
  isReviewServingBulkJobStatus,
  isReviewServingComponentRequirement,
  isReviewServingCountAvailability,
  isReviewServingFreshnessState,
  isReviewServingPhysicalAccessStrategy,
  isReviewServingSearchAvailability,
  isReviewServingSnapshotStatus,
  namedReviewFastCountDefinitions,
  namedReviewFastCountKeys,
  reviewServingBulkJobStatuses,
  type ReviewServingBulkState,
  reviewServingComponentRequirements,
  reviewServingCountAvailabilityStates,
  type ReviewServingCountState,
  reviewServingFreshnessStates,
  reviewServingPhysicalAccessStrategies,
  reviewServingProjectionComponents,
  reviewServingRouteBudgetKeys,
  reviewServingSearchAvailabilityStates,
  type ReviewServingSearchState,
  type ReviewServingSnapshotState,
  reviewServingSnapshotStatuses,
} from './reviewServingContracts.ts'

test('review serving contracts export explicit lifecycle state values', () => {
  expect(reviewServingFreshnessStates).toEqual(['ready', 'indexing', 'stale', 'unavailable'])
  expect(reviewServingCountAvailabilityStates).toEqual(['ready', 'stale', 'unavailable', 'async'])
  expect(reviewServingSearchAvailabilityStates).toEqual(['ready', 'indexing', 'unavailable', 'async'])
  expect(reviewServingBulkJobStatuses).toEqual(['pending', 'running', 'completed', 'failed', 'cancelled'])
  expect(reviewServingSnapshotStatuses).toEqual(['candidate', 'active', 'failed', 'retired'])
  expect(reviewServingComponentRequirements).toEqual(['required', 'optional'])
})

test('review serving contracts export physical access and budget value sets', () => {
  expect(reviewServingPhysicalAccessStrategies).toEqual([
    'jobCriteria',
    'keyedLookup',
    'orderedPrefix',
    'postingIntersection',
    'queueOrdering',
    'summaryLookup',
    'tokenPrefixIndex',
  ])
  expect(reviewServingRouteBudgetKeys).toEqual([
    'allowsTempSpill',
    'maxEstimatedResultBytes',
    'maxPageSize',
    'maxResultRows',
  ])
})

test('review serving contract guards accept only exported state values', () => {
  expect(isReviewServingFreshnessState('ready')).toBe(true)
  expect(isReviewServingFreshnessState('hydrating')).toBe(false)
  expect(isReviewServingCountAvailability('async')).toBe(true)
  expect(isReviewServingCountAvailability('loading')).toBe(false)
  expect(isReviewServingSearchAvailability('indexing')).toBe(true)
  expect(isReviewServingSearchAvailability('queued')).toBe(false)
  expect(isReviewServingSnapshotStatus('active')).toBe(true)
  expect(isReviewServingSnapshotStatus('building')).toBe(false)
  expect(isReviewServingComponentRequirement('optional')).toBe(true)
  expect(isReviewServingComponentRequirement('niceToHave')).toBe(false)
  expect(isReviewServingPhysicalAccessStrategy('summaryLookup')).toBe(true)
  expect(isReviewServingPhysicalAccessStrategy('rawScan')).toBe(false)
  expect(isReviewServingBulkJobStatus('running')).toBe(true)
  expect(isReviewServingBulkJobStatus('retrying')).toBe(false)
  expect(isNamedReviewFastCountKey('review.list.total')).toBe(true)
  expect(isNamedReviewFastCountKey('review.raw.total')).toBe(false)
})

test('named fast count definitions cover exact registered keys and known components', () => {
  const registeredKeys = [...namedReviewFastCountKeys].sort()
  const definitionKeys = Object.keys(namedReviewFastCountDefinitions).sort()
  const components = new Set(reviewServingProjectionComponents)
  const unknownComponents = Object.values(namedReviewFastCountDefinitions).flatMap((definition) => {
    return definition.requiredComponents.filter((component) => {
      return !components.has(component)
    })
  })

  expect(definitionKeys).toEqual(registeredKeys)
  expect(unknownComponents).toEqual([])
})

test('review serving contract state shapes carry snapshot and component identifiers', () => {
  const snapshotState = {
    componentStates: {
      optional: [
        {
          baseGeneration: '1',
          component: 'search',
          patchWatermark: '2',
          projectionIdentity: 'search:abc',
          requirement: 'optional',
        },
      ],
      required: [
        {
          baseGeneration: '3',
          component: 'display',
          patchWatermark: '4',
          projectionIdentity: 'display:def',
          requirement: 'required',
        },
      ],
    },
    freshness: 'ready',
    lastKnownGoodSnapshotId: null,
    projectId: 'project-1',
    reviewConfigHash: 'review:abc',
    selectedImportSnapshotId: 'selected-import-1',
    snapshotId: 'snapshot-1',
    status: 'active',
  } satisfies ReviewServingSnapshotState
  const countState = {
    availability: 'ready',
    key: 'review.list.total',
    snapshotId: snapshotState.snapshotId,
    value: 12,
  } satisfies ReviewServingCountState
  const searchState = {availability: 'ready', snapshotId: snapshotState.snapshotId} satisfies ReviewServingSearchState
  const bulkState = {
    jobId: 'bulk-1',
    processedCount: 12,
    resultManifestId: 'manifest-1',
    snapshotId: snapshotState.snapshotId,
    status: 'completed',
    totalEstimate: 12,
  } satisfies ReviewServingBulkState

  expect(snapshotState.componentStates.required[0]?.requirement).toBe('required')
  expect(countState.snapshotId).toBe(snapshotState.snapshotId)
  expect(searchState.snapshotId).toBe(snapshotState.snapshotId)
  expect(bulkState.status).toBe('completed')
})
