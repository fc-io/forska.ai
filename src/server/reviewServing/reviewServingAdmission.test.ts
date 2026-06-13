import {expect, test} from 'bun:test'

import {admitReviewServingRequest} from './reviewServingAdmission.ts'

test('admitReviewServingRequest accepts a registered foreground row read within budget', () => {
  const result = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    estimatedResultBytes: 50_000,
    pageSize: 25,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })

  expect(result.admitted).toBe(true)
})

test('admitReviewServingRequest rejects unregistered and unclassified foreground work', () => {
  const unregistered = admitReviewServingRequest({
    contractKey: 'review.rawFallback.rows',
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })
  const wrongClass = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewCount',
  })

  expect(unregistered).toEqual({admitted: false, contract: null, reason: 'unregisteredContract'})
  expect(wrongClass.admitted ? null : wrongClass.reason).toBe('workloadClassMismatch')
})

test('admitReviewServingRequest rejects over-budget foreground work before SQL execution', () => {
  const pageSizeResult = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    pageSize: 101,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })
  const bytesResult = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    estimatedResultBytes: 3_000_000,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })

  expect(pageSizeResult.admitted ? null : pageSizeResult.reason).toBe('pageSizeOverLimit')
  expect(bytesResult.admitted ? null : bytesResult.reason).toBe('estimatedResultBytesOverLimit')
})

test('admitReviewServingRequest rejects synchronous substring search', () => {
  const result = admitReviewServingRequest({
    contractKey: 'review.search.tokenPrefix',
    pageSize: 10,
    searchMode: 'substringSync',
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewSearch',
  })

  expect(result.admitted ? null : result.reason).toBe('synchronousSubstringSearchUnavailable')
})

test('admitReviewServingRequest rejects unsupported count shapes', () => {
  const result = admitReviewServingRequest({
    contractKey: 'review.llm.count',
    namedCountKey: 'review.raw.countEverything',
    pageSize: 1,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewCount',
  })

  expect(result.admitted ? null : result.reason).toBe('unsupportedCountShape')
})

test('admitReviewServingRequest rejects stale snapshots unless the caller explicitly allows stale', () => {
  const rejected = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    pageSize: 25,
    snapshotFreshness: 'stale',
    workloadClass: 'foregroundReviewRows',
  })
  const allowed = admitReviewServingRequest({
    allowStale: true,
    contractKey: 'review.llm.rows',
    pageSize: 25,
    snapshotFreshness: 'stale',
    workloadClass: 'foregroundReviewRows',
  })

  expect(rejected.admitted ? null : rejected.reason).toBe('staleSnapshotRequired')
  expect(allowed.admitted).toBe(true)
})
