import type {ReviewServingCountState, ReviewServingFreshnessState} from './reviewServingContracts.ts'
import {
  readReviewServingRows,
  type ReviewServingReaderRequest,
  type ReviewServingReaderResult,
} from './reviewServingReader.ts'
import {getReviewServingSqlShapeViolations} from './reviewServingSql.ts'
import {reviewServingSqlForbiddenPatterns} from './reviewServingSqlForbiddenPatterns.ts'

const snapshotScopedTables = new Set([
  'app.review_bulk_operation_job',
  'app.review_search_job',
  'app.review_serving_snapshot_manifest',
])

export type ReviewServingRouteParityMismatchKind =
  | 'cursor'
  | 'forbiddenForegroundDuckdbWork'
  | 'freshnessState'
  | 'invariant'
  | 'latency'
  | 'namedCountState'
  | 'olapForwardingOnly'
  | 'responseSize'
  | 'sampledParity'
  | 'semanticFixture'
  | 'sqlShape'

export type ReviewServingRouteParityMismatch = {
  actual: unknown
  caseName: string
  expected: unknown
  kind: ReviewServingRouteParityMismatchKind
  message: string
}

export type ReviewServingRouteParityCase<T> = {
  currentBehaviorRows?: () => Promise<readonly T[]>
  expectedCursorValid?: boolean
  expectedFreshness?: ReviewServingFreshnessState
  expectedNamedCountState?: {
    availability: ReviewServingCountState['availability']
    filterKey: string
    key: ReviewServingCountState['key']
    snapshotId?: string
  }
  expectedRows: readonly T[]
  maxCurrentBehaviorBytes?: number
  maxCurrentBehaviorRows?: number
  maxLatencyMs?: number
  maxResultBytes?: number
  name: string
  request: ReviewServingReaderRequest
}

export type ReviewServingRouteParityRunnerInput<T> = {
  cases: readonly ReviewServingRouteParityCase<T>[]
  legacyOlapForwardingTests?: readonly string[]
  reader?: (request: ReviewServingReaderRequest) => Promise<ReviewServingReaderResult<T>>
  routeKey: string
}

export type ReviewServingRouteParityResult =
  | {mismatches: []; routeKey: string; status: 'passed'}
  | {mismatches: readonly ReviewServingRouteParityMismatch[]; routeKey: string; status: 'failed'}

const getStableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(getStableJsonValue)
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((stableValue, key) => {
        return {...stableValue, [key]: getStableJsonValue((value as Record<string, unknown>)[key])}
      }, {})
  }

  return value
}

const getStableJson = (value: unknown) => {
  return JSON.stringify(getStableJsonValue(value))
}

const getUtf8Bytes = (value: unknown) => {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

const getRows = <T>(result: ReviewServingReaderResult<T>) => {
  return result.status === 'accepted' ? result.rows : []
}

const getInvariantMismatches = <T>(
  caseInput: ReviewServingRouteParityCase<T>,
  result: ReviewServingReaderResult<T>,
) => {
  return result.status === 'accepted'
    ? []
    : [
        {
          actual: result.reason,
          caseName: caseInput.name,
          expected: 'accepted',
          kind: 'invariant' as const,
          message: `reviewServingReader rejected route parity case ${caseInput.name}`,
        },
      ]
}

const getSemanticFixtureMismatches = <T>(
  caseInput: ReviewServingRouteParityCase<T>,
  result: ReviewServingReaderResult<T>,
) => {
  const actualRows = getRows(result)
  const matchesFixture = getStableJson(actualRows) === getStableJson(caseInput.expectedRows)

  return matchesFixture
    ? []
    : [
        {
          actual: actualRows,
          caseName: caseInput.name,
          expected: caseInput.expectedRows,
          kind: 'semanticFixture' as const,
          message: `reviewServingReader rows do not match semantic fixture for ${caseInput.name}`,
        },
      ]
}

const getSampledParityMismatches = async <T>(
  caseInput: ReviewServingRouteParityCase<T>,
  result: ReviewServingReaderResult<T>,
) => {
  if (!caseInput.currentBehaviorRows) {
    return []
  }

  const currentRows = await caseInput.currentBehaviorRows()
  const currentBytes = getUtf8Bytes(currentRows)
  const maxRows = caseInput.maxCurrentBehaviorRows ?? caseInput.request.limit
  const maxBytes = caseInput.maxCurrentBehaviorBytes ?? caseInput.maxResultBytes ?? 2_000_000
  const rowsSafe = currentRows.length <= maxRows
  const bytesSafe = currentBytes <= maxBytes
  const rowsMatch = getStableJson(currentRows) === getStableJson(getRows(result))
  const sizeMismatches = [
    rowsSafe
      ? null
      : {
          actual: currentRows.length,
          caseName: caseInput.name,
          expected: `<= ${maxRows}`,
          kind: 'invariant' as const,
          message: `current behavior sample is too large for ${caseInput.name}`,
        },
    bytesSafe
      ? null
      : {
          actual: currentBytes,
          caseName: caseInput.name,
          expected: `<= ${maxBytes}`,
          kind: 'responseSize' as const,
          message: `current behavior sample bytes exceed parity cap for ${caseInput.name}`,
        },
  ].filter((mismatch) => {
    return mismatch !== null
  })
  const parityMismatch = rowsMatch
    ? []
    : [
        {
          actual: getRows(result),
          caseName: caseInput.name,
          expected: currentRows,
          kind: 'sampledParity' as const,
          message: `reviewServingReader rows do not match sampled current behavior for ${caseInput.name}`,
        },
      ]

  return [...sizeMismatches, ...parityMismatch]
}

const getCursorMismatches = <T>(caseInput: ReviewServingRouteParityCase<T>, result: ReviewServingReaderResult<T>) => {
  const expectedCursorValid = caseInput.expectedCursorValid
  const actualCursorValid = result.diagnostics.cursor.valid

  return expectedCursorValid === undefined || expectedCursorValid === actualCursorValid
    ? []
    : [
        {
          actual: actualCursorValid,
          caseName: caseInput.name,
          expected: expectedCursorValid,
          kind: 'cursor' as const,
          message: `cursor diagnostics do not match route parity expectation for ${caseInput.name}`,
        },
      ]
}

const getFreshnessMismatches = <T>(
  caseInput: ReviewServingRouteParityCase<T>,
  result: ReviewServingReaderResult<T>,
) => {
  const expectedFreshness = caseInput.expectedFreshness
  const actualFreshness = result.diagnostics.manifest.freshness

  return expectedFreshness === undefined || expectedFreshness === actualFreshness
    ? []
    : [
        {
          actual: actualFreshness,
          caseName: caseInput.name,
          expected: expectedFreshness,
          kind: 'freshnessState' as const,
          message: `freshness diagnostics do not match route parity expectation for ${caseInput.name}`,
        },
      ]
}

const getNamedCountStateMismatches = <T>(
  caseInput: ReviewServingRouteParityCase<T>,
  result: ReviewServingReaderResult<T>,
) => {
  const expectedState = caseInput.expectedNamedCountState
  const actualState = result.diagnostics.admission?.count.state ?? null
  const expectedJson = getStableJson(expectedState)
  const actualJson = getStableJson(
    actualState
      ? {
          availability: actualState.availability,
          filterKey: actualState.filterKey,
          key: actualState.key,
          snapshotId: 'snapshotId' in actualState ? actualState.snapshotId : undefined,
        }
      : null,
  )

  return expectedState === undefined || expectedJson === actualJson
    ? []
    : [
        {
          actual: actualState,
          caseName: caseInput.name,
          expected: expectedState,
          kind: 'namedCountState' as const,
          message: `named count state diagnostics do not match route parity expectation for ${caseInput.name}`,
        },
      ]
}

const getSqlMismatches = <T>(caseInput: ReviewServingRouteParityCase<T>, result: ReviewServingReaderResult<T>) => {
  const sql = result.sql ?? ''
  const requireSnapshotScope = result.contract ? !snapshotScopedTables.has(result.contract.servingTable) : true
  const sqlShapeViolations = sql
    ? getReviewServingSqlShapeViolations(sql, {requireSnapshotScope})
    : result.diagnostics.sqlShapeViolations
  const forbiddenViolations = reviewServingSqlForbiddenPatterns.filter((forbiddenPattern) => {
    return forbiddenPattern.pattern.test(sql)
  })
  const shapeMismatches =
    sqlShapeViolations.length === 0
      ? []
      : [
          {
            actual: sqlShapeViolations,
            caseName: caseInput.name,
            expected: [],
            kind: 'sqlShape' as const,
            message: `SQL shape violations block route parity for ${caseInput.name}`,
          },
        ]
  const foregroundMismatches =
    forbiddenViolations.length === 0
      ? []
      : [
          {
            actual: forbiddenViolations.map((violation) => {
              return violation.label
            }),
            caseName: caseInput.name,
            expected: [],
            kind: 'forbiddenForegroundDuckdbWork' as const,
            message: `forbidden foreground DuckDB work blocks route parity for ${caseInput.name}`,
          },
        ]

  return [...shapeMismatches, ...foregroundMismatches]
}

const getLatencyMismatches = <T>(caseInput: ReviewServingRouteParityCase<T>, latencyMs: number) => {
  const maxLatencyMs = caseInput.maxLatencyMs

  return maxLatencyMs === undefined || latencyMs <= maxLatencyMs
    ? []
    : [
        {
          actual: latencyMs,
          caseName: caseInput.name,
          expected: `<= ${maxLatencyMs}`,
          kind: 'latency' as const,
          message: `route parity latency budget exceeded for ${caseInput.name}`,
        },
      ]
}

const getResponseSizeMismatches = <T>(
  caseInput: ReviewServingRouteParityCase<T>,
  result: ReviewServingReaderResult<T>,
) => {
  const maxResultBytes = caseInput.maxResultBytes
  const resultBytes = getUtf8Bytes(getRows(result))

  return maxResultBytes === undefined || resultBytes <= maxResultBytes
    ? []
    : [
        {
          actual: resultBytes,
          caseName: caseInput.name,
          expected: `<= ${maxResultBytes}`,
          kind: 'responseSize' as const,
          message: `route parity response-size budget exceeded for ${caseInput.name}`,
        },
      ]
}

const runCase = async <T>(
  caseInput: ReviewServingRouteParityCase<T>,
  reader: (request: ReviewServingReaderRequest) => Promise<ReviewServingReaderResult<T>>,
) => {
  const startedAt = performance.now()
  const result = await reader(caseInput.request)
  const latencyMs = performance.now() - startedAt
  const sampledParityMismatches = await getSampledParityMismatches(caseInput, result)

  return [
    ...getInvariantMismatches(caseInput, result),
    ...getSemanticFixtureMismatches(caseInput, result),
    ...sampledParityMismatches,
    ...getCursorMismatches(caseInput, result),
    ...getFreshnessMismatches(caseInput, result),
    ...getNamedCountStateMismatches(caseInput, result),
    ...getSqlMismatches(caseInput, result),
    ...getLatencyMismatches(caseInput, latencyMs),
    ...getResponseSizeMismatches(caseInput, result),
  ]
}

const getOlapForwardingOnlyMismatches = <T>(input: ReviewServingRouteParityRunnerInput<T>) => {
  return input.cases.length > 0 || (input.legacyOlapForwardingTests?.length ?? 0) === 0
    ? []
    : [
        {
          actual: input.legacyOlapForwardingTests,
          caseName: input.routeKey,
          expected: 'reviewServingReader parity fixtures',
          kind: 'olapForwardingOnly' as const,
          message: `OLAP forwarding tests alone do not satisfy Phase 4 serving parity for ${input.routeKey}`,
        },
      ]
}

export const runReviewServingRouteParity = async <T>(
  input: ReviewServingRouteParityRunnerInput<T>,
): Promise<ReviewServingRouteParityResult> => {
  const reader = input.reader ?? readReviewServingRows<T>
  const caseMismatchGroups = await Promise.all(
    input.cases.map((caseInput) => {
      return runCase(caseInput, reader)
    }),
  )
  const mismatches = [...getOlapForwardingOnlyMismatches(input), ...caseMismatchGroups.flat()]

  return mismatches.length === 0
    ? {mismatches: [], routeKey: input.routeKey, status: 'passed'}
    : {mismatches, routeKey: input.routeKey, status: 'failed'}
}
