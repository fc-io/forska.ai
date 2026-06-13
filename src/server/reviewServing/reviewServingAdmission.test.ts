import {expect, test} from 'bun:test'

import {
  admitReviewServingDuckdbWorkload,
  admitReviewServingRequest,
  getReviewServingAdmissionDiagnostics,
} from './reviewServingAdmission.ts'

test('admitReviewServingRequest accepts a registered foreground row read within budget', () => {
  const result = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    estimatedResultBytes: 50_000,
    pageSize: 25,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })

  expect(result).toMatchObject({
    admitted: true,
    diagnostics: {decision: 'accepted', rejectionReason: null},
    status: 'accepted',
  })
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

  expect(unregistered).toMatchObject({
    admitted: false,
    contract: null,
    diagnostics: {
      contractKey: 'review.rawFallback.rows',
      decision: 'rejected',
      rejectionReason: 'unregisteredContract',
      workloadClass: {matches: false, registered: null, requested: 'foregroundReviewRows'},
    },
    reason: 'unregisteredContract',
    status: 'rejected',
  })
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
  const rowsResult = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    estimatedResultRows: 101,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })

  expect(pageSizeResult.admitted ? null : pageSizeResult.reason).toBe('pageSizeOverLimit')
  expect(bytesResult.admitted ? null : bytesResult.reason).toBe('estimatedResultBytesOverLimit')
  expect(rowsResult.admitted ? null : rowsResult.reason).toBe('estimatedResultRowsOverLimit')
  expect(pageSizeResult.diagnostics.routeBudget.pageSize).toEqual({
    accepted: false,
    budgetKey: 'maxPageSize',
    limit: 100,
    rejectionReason: 'pageSizeOverLimit',
    requested: 101,
  })
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
  expect(result.diagnostics.search).toMatchObject({
    registeredMode: 'tokenPrefix',
    requestedMode: 'substringSync',
    synchronousSubstringRejected: true,
  })
})

test('admitReviewServingRequest rejects search modes that do not match the contract', () => {
  const substringOnTokenPrefixRows = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    pageSize: 10,
    searchMode: 'substringAsync',
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })
  const tokenPrefixOnNoSearchCount = admitReviewServingRequest({
    contractKey: 'review.llm.count',
    pageSize: 1,
    searchMode: 'tokenPrefix',
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewCount',
  })

  expect(substringOnTokenPrefixRows.admitted ? null : substringOnTokenPrefixRows.reason).toBe('searchModeMismatch')
  expect(tokenPrefixOnNoSearchCount.admitted ? null : tokenPrefixOnNoSearchCount.reason).toBe('searchModeMismatch')
  expect(substringOnTokenPrefixRows.diagnostics.search).toMatchObject({
    registeredMode: 'tokenPrefix',
    requestedMode: 'substringAsync',
  })
})

test('admitReviewServingRequest rejects unsupported count shapes', () => {
  const result = admitReviewServingRequest({
    contractKey: 'review.llm.count',
    namedCountKey: 'review.raw.countEverything',
    pageSize: 1,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewCount',
  })
  const unsupportedRegisteredCount = admitReviewServingRequest({
    contractKey: 'review.llm.count',
    namedCountKey: 'review.human.reviewedByPrompt',
    pageSize: 1,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewCount',
  })

  expect(result.admitted ? null : result.reason).toBe('unsupportedCountShape')
  expect(result.diagnostics.count).toMatchObject({requestedKey: 'review.raw.countEverything', supported: false})
  expect(unsupportedRegisteredCount.admitted ? null : unsupportedRegisteredCount.reason).toBe('unsupportedCountShape')
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
  expect(rejected.diagnostics.freshness).toEqual({
    accepted: false,
    allowStale: false,
    behavior: 'requireReadySnapshot',
    snapshotFreshness: 'stale',
  })
  expect(allowed.diagnostics.freshness).toEqual({
    accepted: true,
    allowStale: true,
    behavior: 'requireReadySnapshot',
    snapshotFreshness: 'stale',
  })
})

test('getReviewServingAdmissionDiagnostics exposes route and work state shapes', () => {
  const diagnostics = getReviewServingAdmissionDiagnostics({
    contractKey: 'review.llm.count',
    countState: {availability: 'ready', key: 'review.llm.assessedByPrompt', snapshotId: 'snapshot-1', value: 12},
    jobState: {jobId: 'job-1', processedCount: 4, snapshotId: 'snapshot-1', status: 'running', totalEstimate: 12},
    namedCountKey: 'review.llm.assessedByPrompt',
    pageSize: 1,
    searchState: {availability: 'unavailable', reason: 'count route has no search work'},
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewCount',
  })

  expect(diagnostics).toMatchObject({
    contractKey: 'review.llm.count',
    count: {
      requestedKey: 'review.llm.assessedByPrompt',
      state: {availability: 'ready', snapshotId: 'snapshot-1', value: 12},
      supported: true,
    },
    decision: 'accepted',
    freshness: {accepted: true, allowStale: false, behavior: 'requireReadySnapshot', snapshotFreshness: 'ready'},
    job: {state: {jobId: 'job-1', processedCount: 4, status: 'running'}},
    rejectionReason: null,
    routeBudget: {
      estimatedResultBytes: {
        accepted: true,
        budgetKey: 'maxEstimatedResultBytes',
        limit: 2_000_000,
        rejectionReason: null,
        requested: null,
      },
      pageSize: {accepted: true, budgetKey: 'maxPageSize', limit: 1, rejectionReason: null, requested: 1},
      resultRows: {accepted: true, budgetKey: 'maxResultRows', limit: 1, rejectionReason: null, requested: null},
      tempSpill: {accepted: true, budgetKey: 'allowsTempSpill', limit: false, rejectionReason: null, requested: false},
    },
    search: {
      registeredMode: 'none',
      requestedMode: null,
      state: {availability: 'unavailable', reason: 'count route has no search work'},
      synchronousSubstringRejected: false,
    },
    workloadClass: {matches: true, registered: 'foregroundReviewCount', requested: 'foregroundReviewCount'},
  })
})

test('admitReviewServingDuckdbWorkload maps an admitted contract to generic DuckDB workload context', () => {
  const result = admitReviewServingDuckdbWorkload({
    contractKey: 'review.llm.rows',
    estimatedResultBytes: 50_000,
    pageSize: 25,
    projectId: 'project-a',
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })

  expect(result).toMatchObject({
    admitted: true,
    diagnostics: {decision: 'accepted', rejectionReason: null},
    status: 'accepted',
  })
  expect(result.admitted ? result.workloadContext : null).toEqual({
    allowsTempSpill: false,
    fallbackIntent: 'reject',
    maxResultBytes: 2_000_000,
    maxResultRows: 100,
    projectId: 'project-a',
    routeOrJobKey: 'review.llm.rows',
    workloadClass: 'foregroundReviewRows',
  })
})

test('admitReviewServingDuckdbWorkload preserves rejection before DuckDB execution', () => {
  const result = admitReviewServingDuckdbWorkload({
    contractKey: 'review.rawFallback.rows',
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })

  expect(result).toMatchObject({
    admitted: false,
    contract: null,
    diagnostics: {decision: 'rejected', rejectionReason: 'unregisteredContract'},
    reason: 'unregisteredContract',
    status: 'rejected',
  })
})
