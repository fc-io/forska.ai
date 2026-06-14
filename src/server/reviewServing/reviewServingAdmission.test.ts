import {expect, test} from 'bun:test'

import {
  admitReviewServingDuckdbWorkload,
  admitReviewServingRequest,
  getReviewServingAdmissionDiagnostics,
} from './reviewServingAdmission.ts'

const readyServingIdentity = {projectId: 'project-1', snapshotId: 'snapshot-1'} as const

test('admitReviewServingRequest accepts a registered foreground row read within budget', () => {
  const result = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    estimatedResultBytes: 50_000,
    pageSize: 25,
    ...readyServingIdentity,
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

test('admitReviewServingRequest rejects invalid numeric budgets before SQL execution', () => {
  const negativePageSize = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    pageSize: -1,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })
  const zeroPageSize = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    pageSize: 0,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })
  const negativeRows = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    estimatedResultRows: -1,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })
  const invalidBytes = admitReviewServingRequest({
    contractKey: 'review.llm.rows',
    estimatedResultBytes: Number.POSITIVE_INFINITY,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })

  expect(negativePageSize.admitted ? null : negativePageSize.reason).toBe('invalidBudgetValue')
  expect(zeroPageSize.admitted ? null : zeroPageSize.reason).toBe('invalidBudgetValue')
  expect(negativeRows.admitted ? null : negativeRows.reason).toBe('invalidBudgetValue')
  expect(invalidBytes.admitted ? null : invalidBytes.reason).toBe('invalidBudgetValue')
  expect(negativePageSize.diagnostics.routeBudget.pageSize).toEqual({
    accepted: false,
    budgetKey: 'maxPageSize',
    limit: 100,
    rejectionReason: 'invalidBudgetValue',
    requested: -1,
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
  const missingSubstringMode = admitReviewServingRequest({
    contractKey: 'review.search.substringAsync',
    pageSize: 1,
    snapshotFreshness: 'ready',
    workloadClass: 'bulkReviewJob',
  })
  const acceptedSubstringMode = admitReviewServingRequest({
    contractKey: 'review.search.substringAsync',
    pageSize: 1,
    searchMode: 'substringAsync',
    snapshotFreshness: 'ready',
    workloadClass: 'bulkReviewJob',
  })

  expect(substringOnTokenPrefixRows.admitted ? null : substringOnTokenPrefixRows.reason).toBe('searchModeMismatch')
  expect(tokenPrefixOnNoSearchCount.admitted ? null : tokenPrefixOnNoSearchCount.reason).toBe('searchModeMismatch')
  expect(missingSubstringMode.admitted ? null : missingSubstringMode.reason).toBe('searchModeMismatch')
  expect(acceptedSubstringMode.admitted).toBe(true)
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

test('admitReviewServingRequest rejects summary lookups without a named count key', () => {
  const result = admitReviewServingRequest({
    contractKey: 'review.llm.count',
    pageSize: 1,
    snapshotFreshness: 'ready',
    snapshotId: 'snapshot-1',
    workloadClass: 'foregroundReviewCount',
  })

  expect(result.admitted ? null : result.reason).toBe('unsupportedCountShape')
  expect(result.diagnostics.count).toMatchObject({requestedKey: null, supported: false})
})

test('admitReviewServingRequest rejects supported count keys without ready matching count state', () => {
  const unavailable = admitReviewServingRequest({
    contractKey: 'review.llm.count',
    countFilterKey: 'prompt:1',
    countState: {
      availability: 'unavailable',
      filterKey: 'prompt:1',
      key: 'review.llm.assessedByPrompt',
      reason: 'projector unavailable',
    },
    namedCountKey: 'review.llm.assessedByPrompt',
    pageSize: 1,
    ...readyServingIdentity,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewCount',
  })
  const pending = admitReviewServingRequest({
    contractKey: 'review.llm.count',
    countFilterKey: 'prompt:1',
    countState: {
      availability: 'async',
      filterKey: 'prompt:1',
      jobId: 'count-job-1',
      key: 'review.llm.assessedByPrompt',
      reason: 'building',
    },
    namedCountKey: 'review.llm.assessedByPrompt',
    pageSize: 1,
    ...readyServingIdentity,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewCount',
  })
  const mismatched = admitReviewServingRequest({
    contractKey: 'review.llm.count',
    countFilterKey: 'prompt:1',
    countState: {
      availability: 'ready',
      filterKey: 'prompt:1',
      key: 'review.list.total',
      snapshotId: 'snapshot-1',
      value: 12,
    },
    namedCountKey: 'review.llm.assessedByPrompt',
    pageSize: 1,
    ...readyServingIdentity,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewCount',
  })
  const wrongSnapshot = admitReviewServingRequest({
    contractKey: 'review.llm.count',
    countFilterKey: 'prompt:1',
    countState: {
      availability: 'ready',
      filterKey: 'prompt:1',
      key: 'review.llm.assessedByPrompt',
      snapshotId: 'snapshot-old',
      value: 12,
    },
    namedCountKey: 'review.llm.assessedByPrompt',
    pageSize: 1,
    ...readyServingIdentity,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewCount',
  })
  const wrongFilterKey = admitReviewServingRequest({
    contractKey: 'review.llm.count',
    countFilterKey: 'prompt:2',
    countState: {
      availability: 'ready',
      filterKey: 'prompt:1',
      key: 'review.llm.assessedByPrompt',
      snapshotId: 'snapshot-1',
      value: 12,
    },
    namedCountKey: 'review.llm.assessedByPrompt',
    pageSize: 1,
    ...readyServingIdentity,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewCount',
  })

  expect(unavailable.admitted ? null : unavailable.reason).toBe('countStateUnavailable')
  expect(pending.admitted ? null : pending.reason).toBe('countStateUnavailable')
  expect(mismatched.admitted ? null : mismatched.reason).toBe('countStateUnavailable')
  expect(wrongSnapshot.admitted ? null : wrongSnapshot.reason).toBe('countStateUnavailable')
  expect(wrongFilterKey.admitted ? null : wrongFilterKey.reason).toBe('countStateUnavailable')
})

test('admitReviewServingRequest rejects token-prefix search without ready search state', () => {
  const missingMode = admitReviewServingRequest({
    contractKey: 'review.search.tokenPrefix',
    pageSize: 10,
    searchState: {availability: 'ready', snapshotId: 'snapshot-1'},
    snapshotFreshness: 'ready',
    snapshotId: 'snapshot-1',
    workloadClass: 'foregroundReviewSearch',
  })
  const indexing = admitReviewServingRequest({
    contractKey: 'review.search.tokenPrefix',
    pageSize: 10,
    searchMode: 'tokenPrefix',
    searchState: {availability: 'indexing', reason: 'search projector indexing'},
    ...readyServingIdentity,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewSearch',
  })
  const wrongSnapshot = admitReviewServingRequest({
    contractKey: 'review.search.tokenPrefix',
    pageSize: 10,
    searchMode: 'tokenPrefix',
    searchState: {availability: 'ready', snapshotId: 'snapshot-old'},
    ...readyServingIdentity,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewSearch',
  })
  const ready = admitReviewServingRequest({
    contractKey: 'review.search.tokenPrefix',
    pageSize: 10,
    searchMode: 'tokenPrefix',
    searchState: {availability: 'ready', snapshotId: 'snapshot-1'},
    ...readyServingIdentity,
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewSearch',
  })

  expect(missingMode.admitted ? null : missingMode.reason).toBe('searchModeMismatch')
  expect(indexing.admitted ? null : indexing.reason).toBe('searchStateUnavailable')
  expect(wrongSnapshot.admitted ? null : wrongSnapshot.reason).toBe('searchStateUnavailable')
  expect(ready.admitted).toBe(true)
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
    ...readyServingIdentity,
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

test('admitReviewServingRequest rejects stale fallback without explicit stale snapshot freshness', () => {
  const omitted = admitReviewServingRequest({
    allowStale: true,
    contractKey: 'review.llm.rows',
    pageSize: 25,
    ...readyServingIdentity,
    workloadClass: 'foregroundReviewRows',
  })
  const indexing = admitReviewServingRequest({
    allowStale: true,
    contractKey: 'review.llm.rows',
    pageSize: 25,
    ...readyServingIdentity,
    snapshotFreshness: 'indexing',
    workloadClass: 'foregroundReviewRows',
  })
  const unavailable = admitReviewServingRequest({
    allowStale: true,
    contractKey: 'review.llm.rows',
    pageSize: 25,
    ...readyServingIdentity,
    snapshotFreshness: 'unavailable',
    workloadClass: 'foregroundReviewRows',
  })

  expect(omitted.admitted ? null : omitted.reason).toBe('staleSnapshotRequired')
  expect(indexing.admitted ? null : indexing.reason).toBe('staleSnapshotRequired')
  expect(unavailable.admitted ? null : unavailable.reason).toBe('staleSnapshotRequired')
  expect(indexing.diagnostics.freshness).toEqual({
    accepted: false,
    allowStale: true,
    behavior: 'requireReadySnapshot',
    snapshotFreshness: 'indexing',
  })
})

test('admitReviewServingRequest rejects ready serving reads without project and snapshot identity', () => {
  const missingProject = admitReviewServingRequest({
    contractKey: 'review.detail.row',
    pageSize: 1,
    snapshotFreshness: 'ready',
    snapshotId: 'snapshot-1',
    workloadClass: 'foregroundReviewRows',
  })
  const missingSnapshot = admitReviewServingRequest({
    contractKey: 'review.detail.row',
    pageSize: 1,
    projectId: 'project-1',
    snapshotFreshness: 'ready',
    workloadClass: 'foregroundReviewRows',
  })

  expect(missingProject.admitted ? null : missingProject.reason).toBe('servingIdentityMissing')
  expect(missingSnapshot.admitted ? null : missingSnapshot.reason).toBe('servingIdentityMissing')
  expect(missingProject.diagnostics.servingIdentity).toEqual({
    accepted: false,
    projectId: null,
    snapshotId: 'snapshot-1',
  })
})

test('getReviewServingAdmissionDiagnostics exposes route and work state shapes', () => {
  const diagnostics = getReviewServingAdmissionDiagnostics({
    contractKey: 'review.llm.count',
    countFilterKey: 'prompt:1',
    countState: {
      availability: 'ready',
      filterKey: 'prompt:1',
      key: 'review.llm.assessedByPrompt',
      snapshotId: 'snapshot-1',
      value: 12,
    },
    jobState: {jobId: 'job-1', processedCount: 4, snapshotId: 'snapshot-1', status: 'running', totalEstimate: 12},
    namedCountKey: 'review.llm.assessedByPrompt',
    pageSize: 1,
    projectId: 'project-1',
    searchState: {availability: 'unavailable', reason: 'count route has no search work'},
    snapshotFreshness: 'ready',
    snapshotId: 'snapshot-1',
    workloadClass: 'foregroundReviewCount',
  })

  expect(diagnostics).toMatchObject({
    contractKey: 'review.llm.count',
    count: {
      requestedFilterKey: 'prompt:1',
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
    servingIdentity: {accepted: true, projectId: 'project-1', snapshotId: 'snapshot-1'},
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
    snapshotId: 'snapshot-1',
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
    timeoutMs: 5_000,
    workloadClass: 'foregroundReviewRows',
  })
})

test('admitReviewServingDuckdbWorkload only uses stale fallback for explicit stale snapshots', () => {
  const ready = admitReviewServingDuckdbWorkload({
    allowStale: true,
    contractKey: 'review.llm.rows',
    pageSize: 25,
    projectId: 'project-a',
    snapshotFreshness: 'ready',
    snapshotId: 'snapshot-1',
    workloadClass: 'foregroundReviewRows',
  })
  const stale = admitReviewServingDuckdbWorkload({
    allowStale: true,
    contractKey: 'review.llm.rows',
    pageSize: 25,
    projectId: 'project-a',
    snapshotFreshness: 'stale',
    snapshotId: 'snapshot-1',
    workloadClass: 'foregroundReviewRows',
  })

  expect(ready.admitted ? ready.workloadContext.fallbackIntent : null).toBe('reject')
  expect(stale.admitted ? stale.workloadContext.fallbackIntent : null).toBe('serveStale')
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
