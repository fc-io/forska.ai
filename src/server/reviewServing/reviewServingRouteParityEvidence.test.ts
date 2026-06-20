import {expect, test} from 'bun:test'

import {
  reviewServingJobParityCoverage,
  reviewServingJobParityGates,
  reviewServingRouteParityCoverage,
  reviewServingRouteParityGates,
} from './reviewServingRouteParityCoverage.ts'
import {
  reviewServingBrowserFreshnessDiagnosticsEvidence,
  reviewServingJobParityEvidence,
  reviewServingRouteParityEvidence,
} from './reviewServingRouteParityEvidence.ts'
import {runReviewServingRouteParity} from './reviewServingRouteParityRunner.ts'

const getRouteKey = (entry: {method: string; productRoute: string}) => {
  return `${entry.method} ${entry.productRoute}`
}

test('route parity evidence has runnable semantic fixtures and sampled current-behavior cases for every coverage entry', async () => {
  const coverageKeys = reviewServingRouteParityCoverage.map(getRouteKey)
  const evidenceKeys = reviewServingRouteParityEvidence.map((entry) => {
    return entry.routeKey
  })
  const missingRunnableCases = reviewServingRouteParityEvidence.flatMap((entry) => {
    return entry.cases.flatMap((caseInput) => {
      return caseInput.currentBehaviorRows && caseInput.expectedRows.length > 0
        ? []
        : [`${entry.routeKey}: ${caseInput.name}`]
    })
  })
  const missingGateEvidence = reviewServingRouteParityEvidence.flatMap((entry) => {
    return reviewServingRouteParityGates.flatMap((gate) => {
      return entry.evidenceGates.includes(gate) ? [] : [`${entry.routeKey}: ${gate}`]
    })
  })
  const parityResults = await Promise.all(
    reviewServingRouteParityEvidence.map((entry) => {
      return runReviewServingRouteParity(entry)
    }),
  )

  expect([...new Set(evidenceKeys)].sort()).toEqual([...new Set(coverageKeys)].sort())
  expect(missingRunnableCases).toEqual([])
  expect(missingGateEvidence).toEqual([])
  expect(
    parityResults.flatMap((result) => {
      return result.status === 'passed' ? [] : [`${result.routeKey}: ${JSON.stringify(result.mismatches)}`]
    }),
  ).toEqual([])
})

test('job parity evidence has concrete cases and verification tests for every job coverage entry', () => {
  const coverageKeys = reviewServingJobParityCoverage.map(getRouteKey)
  const evidenceKeys = reviewServingJobParityEvidence.map(getRouteKey)
  const missingGateEvidence = reviewServingJobParityEvidence.flatMap((entry) => {
    return reviewServingJobParityGates.flatMap((gate) => {
      return entry.evidenceGates.includes(gate) ? [] : [`${getRouteKey(entry)}: ${gate}`]
    })
  })
  const missingCaseEvidence = reviewServingJobParityEvidence.flatMap((entry) => {
    return entry.evidenceCases.length > 0 && entry.verificationTests.length > 0 ? [] : [getRouteKey(entry)]
  })

  expect([...new Set(evidenceKeys)].sort()).toEqual([...new Set(coverageKeys)].sort())
  expect(missingGateEvidence).toEqual([])
  expect(missingCaseEvidence).toEqual([])
})

test('browser review-flow freshness diagnostics evidence covers requested freshness and snapshot states', () => {
  const freshnessStates = reviewServingBrowserFreshnessDiagnosticsEvidence.map((entry) => {
    return entry.expectedFreshness
  })
  const snapshotStatuses = reviewServingBrowserFreshnessDiagnosticsEvidence.map((entry) => {
    return entry.expectedSnapshotStatus
  })
  const missingVerification = reviewServingBrowserFreshnessDiagnosticsEvidence.flatMap((entry) => {
    return entry.verificationTests.length > 0 ? [] : [`${entry.productRoute}: ${entry.expectedSnapshotStatus}`]
  })

  expect([...new Set(freshnessStates)].sort()).toEqual(['indexing', 'stale', 'unavailable'])
  expect([...new Set(snapshotStatuses)].sort()).toEqual(['candidate', 'failed', 'missing', 'retired'])
  expect(missingVerification).toEqual([])
})
