import {expect, test} from 'bun:test'

import type {ReviewServingReadContract} from './reviewServingContracts.ts'
import type {ReviewServingReaderRequest, ReviewServingReaderResult} from './reviewServingReader.ts'
import {
  type ReviewServingRouteParityMismatchKind,
  runReviewServingRouteParity,
} from './reviewServingRouteParityRunner.ts'

type TestRow = {articleId: string; title: string}

const validSql =
  'SELECT article_id FROM mart.review_article_serving_v4 WHERE project_id = $projectId AND snapshot_id = $snapshotId ORDER BY sort_key DESC LIMIT $limit'
const readyRequest: ReviewServingReaderRequest = {
  contractKey: 'review.llm.rows',
  limit: 1,
  projectId: 'project-1',
  reviewConfigHash: 'config-1',
  snapshotId: 'active-snapshot',
}
const fixtureRows = [{articleId: 'article-1', title: 'Article 1'}]

const getAcceptedResult = <T>(rows: readonly T[], overrides?: Partial<{sql: string}>): ReviewServingReaderResult<T> => {
  return {
    contract: {} as ReviewServingReadContract,
    diagnostics: {
      admission: {
        contractKey: 'review.llm.rows',
        count: {
          requestedFilterKey: 'prompt:1',
          requestedKey: 'review.llm.assessedByPrompt',
          state: {
            availability: 'ready',
            filterKey: 'prompt:1',
            key: 'review.llm.assessedByPrompt',
            snapshotId: 'active-snapshot',
            value: 12,
          },
          supported: true,
        },
        decision: 'accepted',
        freshness: {accepted: true, allowStale: false, behavior: 'requireReadySnapshot', snapshotFreshness: 'ready'},
        job: {state: null},
        rejectionReason: null,
        routeBudget: {
          estimatedResultBytes: {
            accepted: true,
            budgetKey: 'maxEstimatedResultBytes',
            limit: 2_000_000,
            rejectionReason: null,
            requested: null,
          },
          pageSize: {accepted: true, budgetKey: 'maxPageSize', limit: 100, rejectionReason: null, requested: 1},
          resultRows: {accepted: true, budgetKey: 'maxResultRows', limit: 100, rejectionReason: null, requested: null},
          tempSpill: {
            accepted: true,
            budgetKey: 'allowsTempSpill',
            limit: false,
            rejectionReason: null,
            requested: false,
          },
        },
        search: {registeredMode: 'none', requestedMode: null, state: null, synchronousSubstringRejected: false},
        servingIdentity: {accepted: true, projectId: 'project-1', snapshotId: 'active-snapshot'},
        workloadClass: {matches: true, registered: 'foregroundReviewRows', requested: 'foregroundReviewRows'},
      },
      contractKey: 'review.llm.rows',
      cursor: {reason: null, valid: true},
      diagnostics: null,
      filterSignature: 'filters:1',
      manifest: {
        freshness: 'ready',
        lastError: null,
        projectId: 'project-1',
        snapshotId: 'active-snapshot',
        status: 'active',
      },
      missingRequiredComponents: [],
      rejectionReason: null,
      sqlShapeViolations: [],
    },
    rows: [...rows],
    sql: overrides?.sql ?? validSql,
    status: 'accepted',
  }
}

const getRejectedResult = <T>(): ReviewServingReaderResult<T> => {
  return {
    contract: null,
    diagnostics: {
      admission: null,
      contractKey: 'review.llm.rows',
      cursor: {reason: null, valid: true},
      diagnostics: null,
      filterSignature: null,
      manifest: {freshness: 'unavailable', lastError: null, projectId: null, snapshotId: null, status: 'missing'},
      missingRequiredComponents: [],
      rejectionReason: 'servingIdentityMissing',
      sqlShapeViolations: [],
    },
    reason: 'servingIdentityMissing',
    sql: null,
    status: 'rejected',
  }
}

const getMismatchKinds = (result: Awaited<ReturnType<typeof runReviewServingRouteParity<TestRow>>>) => {
  return result.mismatches.map((mismatch) => {
    return mismatch.kind
  })
}

const runSingleMismatchCase = async (
  kind: ReviewServingRouteParityMismatchKind,
  input: Parameters<typeof runReviewServingRouteParity<TestRow>>[0],
) => {
  const result = await runReviewServingRouteParity(input)

  expect(result.status).toBe('failed')
  expect(getMismatchKinds(result)).toContain(kind)
}

test('runReviewServingRouteParity passes route migration when reader semantics and route budgets match', async () => {
  const result = await runReviewServingRouteParity<TestRow>({
    cases: [
      {
        currentBehaviorRows: async () => {
          return fixtureRows
        },
        expectedCursorValid: true,
        expectedFreshness: 'ready',
        expectedNamedCountState: {
          availability: 'ready',
          filterKey: 'prompt:1',
          key: 'review.llm.assessedByPrompt',
          snapshotId: 'active-snapshot',
        },
        expectedRows: fixtureRows,
        maxLatencyMs: 1_000,
        maxResultBytes: 1_000,
        name: 'llm rows first page',
        request: readyRequest,
      },
    ],
    reader: async () => {
      return getAcceptedResult(fixtureRows)
    },
    routeKey: 'review.llm.rows',
  })

  expect(result).toEqual({mismatches: [], routeKey: 'review.llm.rows', status: 'passed'})
})

test('runReviewServingRouteParity blocks route migration on semantic fixture mismatches', async () => {
  await runSingleMismatchCase('semanticFixture', {
    cases: [
      {
        expectedRows: [{articleId: 'article-2', title: 'Article 2'}],
        name: 'llm rows first page',
        request: readyRequest,
      },
    ],
    reader: async () => {
      return getAcceptedResult(fixtureRows)
    },
    routeKey: 'review.llm.rows',
  })
})

test('runReviewServingRouteParity blocks route migration on invariant mismatches', async () => {
  await runSingleMismatchCase('invariant', {
    cases: [{expectedRows: fixtureRows, name: 'llm rows first page', request: readyRequest}],
    reader: async () => {
      return getRejectedResult()
    },
    routeKey: 'review.llm.rows',
  })
})

test('runReviewServingRouteParity blocks route migration on sampled current behavior mismatches', async () => {
  await runSingleMismatchCase('sampledParity', {
    cases: [
      {
        currentBehaviorRows: async () => {
          return [{articleId: 'article-2', title: 'Article 2'}]
        },
        expectedRows: fixtureRows,
        name: 'llm rows first page',
        request: readyRequest,
      },
    ],
    reader: async () => {
      return getAcceptedResult(fixtureRows)
    },
    routeKey: 'review.llm.rows',
  })
})

test('runReviewServingRouteParity blocks route migration on cursor mismatches', async () => {
  await runSingleMismatchCase('cursor', {
    cases: [{expectedCursorValid: false, expectedRows: fixtureRows, name: 'llm rows cursor', request: readyRequest}],
    reader: async () => {
      return getAcceptedResult(fixtureRows)
    },
    routeKey: 'review.llm.rows',
  })
})

test('runReviewServingRouteParity blocks route migration on freshness-state mismatches', async () => {
  await runSingleMismatchCase('freshnessState', {
    cases: [{expectedFreshness: 'stale', expectedRows: fixtureRows, name: 'llm rows freshness', request: readyRequest}],
    reader: async () => {
      return getAcceptedResult(fixtureRows)
    },
    routeKey: 'review.llm.rows',
  })
})

test('runReviewServingRouteParity blocks route migration on named count state mismatches', async () => {
  await runSingleMismatchCase('namedCountState', {
    cases: [
      {
        expectedNamedCountState: {availability: 'ready', filterKey: 'prompt:2', key: 'review.llm.assessedByPrompt'},
        expectedRows: fixtureRows,
        name: 'llm count state',
        request: readyRequest,
      },
    ],
    reader: async () => {
      return getAcceptedResult(fixtureRows)
    },
    routeKey: 'review.llm.count',
  })
})

test('runReviewServingRouteParity blocks route migration on SQL-shape mismatches', async () => {
  await runSingleMismatchCase('sqlShape', {
    cases: [{expectedRows: fixtureRows, name: 'llm rows sql', request: readyRequest}],
    reader: async () => {
      return getAcceptedResult(fixtureRows, {sql: 'SELECT article_id FROM mart.review_article_serving_v4'})
    },
    routeKey: 'review.llm.rows',
  })
})

test('runReviewServingRouteParity blocks route migration on forbidden foreground DuckDB work', async () => {
  await runSingleMismatchCase('forbiddenForegroundDuckdbWork', {
    cases: [{expectedRows: fixtureRows, name: 'llm rows raw scan', request: readyRequest}],
    reader: async () => {
      return getAcceptedResult(fixtureRows, {
        sql: 'SELECT id FROM app.article WHERE project_id = $projectId ORDER BY id LIMIT $limit',
      })
    },
    routeKey: 'review.llm.rows',
  })
})

test('runReviewServingRouteParity blocks route migration on latency mismatches', async () => {
  await runSingleMismatchCase('latency', {
    cases: [{expectedRows: fixtureRows, maxLatencyMs: 1, name: 'llm rows latency', request: readyRequest}],
    reader: async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })

      return getAcceptedResult(fixtureRows)
    },
    routeKey: 'review.llm.rows',
  })
})

test('runReviewServingRouteParity blocks route migration on response-size mismatches', async () => {
  await runSingleMismatchCase('responseSize', {
    cases: [{expectedRows: fixtureRows, maxResultBytes: 1, name: 'llm rows bytes', request: readyRequest}],
    reader: async () => {
      return getAcceptedResult(fixtureRows)
    },
    routeKey: 'review.llm.rows',
  })
})
