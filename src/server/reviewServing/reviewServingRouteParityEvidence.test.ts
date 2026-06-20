import {existsSync} from 'node:fs'

import {expect, mock, test} from 'bun:test'

import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'

const components: readonly ReviewServingProjectionComponent[] = [
  'display',
  'projectScope',
  'selectedImport',
  'payload',
  'llmStatus',
  'humanStatus',
  'posting',
  'summary',
  'queue',
  'search',
  'judgmentInputContent',
]

const getComponentState = () => {
  return {
    optional: [
      {
        baseGeneration: '1',
        component: 'search' as const,
        patchWatermark: '2',
        projectionIdentity: 'search-identity',
        requirement: 'optional' as const,
      },
    ],
    required: components
      .filter((component) => {
        return component !== 'search'
      })
      .map((component) => {
        return {
          baseGeneration: '1',
          component,
          patchWatermark: '2',
          projectionIdentity: `${component}-identity`,
          requirement: 'required' as const,
        }
      }),
  }
}

const getSnapshotRow = () => {
  return {
    componentStateJson: getComponentState(),
    composedIdentityJson: {snapshot: 'active-snapshot'},
    lastError: null,
    lastKnownGoodSnapshotId: null,
    optionalComponentsJson: ['search'],
    projectId: 'project-1',
    requiredComponentsJson: components,
    reviewConfigHash: 'config-1',
    selectedImportSnapshotId: 'selected-import-snapshot-1',
    snapshotId: 'snapshot-active',
    snapshotStatus: 'active',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sourceWatermarksJson: {},
    validationResultJson: null,
  }
}

const getRouteKey = (entry: {method: string; productRoute: string}) => {
  return `${entry.method} ${entry.productRoute}`
}

const getDiagnosticsRows = (statement: string) => {
  if (statement.includes('GROUP BY snapshot_status')) {
    return [{snapshotCount: 1, snapshotStatus: 'active'}]
  }

  if (statement.includes('COUNT(*) FILTER')) {
    return [
      {
        completedCount: 0,
        expiredLeaseCount: 0,
        failedCount: 0,
        oldestQueuedAt: null,
        pendingCount: 0,
        runningCount: 0,
        updatedAt: null,
      },
    ]
  }

  if (statement.includes('quarantinedCursorCount')) {
    return [{quarantinedCursorCount: 0}]
  }

  return []
}

const createDatabase = async () => {
  const evidence = await import('./reviewServingRouteParityEvidence.ts')
  const rowByContractKey = new Map(
    evidence.reviewServingRouteParityEvidence.flatMap((entry) => {
      return entry.cases.map((caseInput) => {
        return [caseInput.request.contractKey, caseInput.expectedRows]
      })
    }),
  )

  return {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        if (statement.includes('snapshot_id AS snapshotId') || statement.includes('snapshot_id AS snapshot_id')) {
          return [getSnapshotRow()] as T[]
        }

        if (!statement.includes("snapshot_status IN ('active', 'retired')")) {
          return getDiagnosticsRows(statement) as T[]
        }
      }

      return ([...rowByContractKey.values()][0] ?? []) as T[]
    },
    run: async () => {},
    transaction: async <T>(operation: (database: unknown) => Promise<T>) => {
      return operation(database)
    },
  }
}

const database = await createDatabase()

await mock.module('../services/appDatabaseService.ts', () => {
  return {
    getAppDatabaseService: () => {
      return database
    },
  }
})

await mock.module('../services/appReadOnlyDatabaseService.ts', () => {
  return {
    getApiReadOnlyAppDatabaseService: () => {
      return database
    },
  }
})

test('route parity evidence runs real readers for every mounted coverage contract', async () => {
  const coverage = await import('./reviewServingRouteParityCoverage.ts')
  const contracts = await import('./reviewServingReadContracts.ts')
  const evidence = await import('./reviewServingRouteParityEvidence.ts')
  const runner = await import('./reviewServingRouteParityRunner.ts')
  const coverageKeys = coverage.reviewServingRouteParityCoverage.map(getRouteKey)
  const evidenceKeys = evidence.reviewServingRouteParityEvidence.map((entry) => {
    return entry.routeKey
  })
  const expectedContractCases = contracts.reviewServingReadContractRouteInventory
    .filter((entry) => {
      return entry.mounted && coverageKeys.includes(getRouteKey(entry))
    })
    .flatMap((entry) => {
      return entry.contractKeys.map((contractKey) => {
        return `${getRouteKey(entry)} ${contractKey}`
      })
    })
  const actualContractCases = evidence.reviewServingRouteParityEvidence.flatMap((entry) => {
    return entry.cases.map((caseInput) => {
      return `${entry.routeKey} ${caseInput.request.contractKey}`
    })
  })
  const missingRunnableCases = evidence.reviewServingRouteParityEvidence.flatMap((entry) => {
    return entry.cases.flatMap((caseInput) => {
      return caseInput.currentBehaviorRows && caseInput.expectedRows.length > 0
        ? []
        : [`${entry.routeKey}: ${caseInput.name}`]
    })
  })
  const missingGateEvidence = evidence.reviewServingRouteParityEvidence.flatMap((entry) => {
    return coverage.reviewServingRouteParityGates.flatMap((gate) => {
      return entry.evidenceGates.includes(gate) ? [] : [`${entry.routeKey}: ${gate}`]
    })
  })
  const parityResults = await Promise.all(
    evidence.reviewServingRouteParityEvidence.map((entry) => {
      return runner.runReviewServingRouteParity(entry)
    }),
  )

  expect([...new Set(evidenceKeys)].sort()).toEqual([...new Set(coverageKeys)].sort())
  expect(actualContractCases.sort()).toEqual(expectedContractCases.sort())
  expect(missingRunnableCases).toEqual([])
  expect(missingGateEvidence).toEqual([])
  expect(
    parityResults.flatMap((result) => {
      return result.status === 'passed' ? [] : [`${result.routeKey}: ${JSON.stringify(result.mismatches)}`]
    }),
  ).toEqual([])
})

test('job parity evidence maps every gate to executable verification tests', async () => {
  const coverage = await import('./reviewServingRouteParityCoverage.ts')
  const evidence = await import('./reviewServingRouteParityEvidence.ts')
  const coverageKeys = coverage.reviewServingJobParityCoverage.map(getRouteKey)
  const evidenceKeys = evidence.reviewServingJobParityEvidence.map(getRouteKey)
  const missingGateEvidence = evidence.reviewServingJobParityEvidence.flatMap((entry) => {
    return coverage.reviewServingJobParityGates.flatMap((gate) => {
      const gateCovered = entry.evidenceGates.includes(gate)
      const caseCovered = entry.evidenceCases.some((evidenceCase) => {
        return evidenceCase.coveredGates.includes(gate) && evidenceCase.evidence.length > 0
      })

      return gateCovered && caseCovered ? [] : [`${getRouteKey(entry)}: ${gate}`]
    })
  })
  const missingVerification = evidence.reviewServingJobParityEvidence.flatMap((entry) => {
    return entry.verificationTests.flatMap((verificationTest) => {
      return existsSync(verificationTest) ? [] : [`${getRouteKey(entry)}: ${verificationTest}`]
    })
  })

  expect([...new Set(evidenceKeys)].sort()).toEqual([...new Set(coverageKeys)].sort())
  expect(missingGateEvidence).toEqual([])
  expect(missingVerification).toEqual([])
})

test('browser review-flow freshness diagnostics evidence covers executable freshness and snapshot states', async () => {
  const evidence = await import('./reviewServingRouteParityEvidence.ts')
  const freshnessStates = evidence.reviewServingBrowserFreshnessDiagnosticsEvidence.map((entry) => {
    return entry.expectedFreshness
  })
  const snapshotStatuses = evidence.reviewServingBrowserFreshnessDiagnosticsEvidence.map((entry) => {
    return entry.expectedSnapshotStatus
  })
  const missingVerification = evidence.reviewServingBrowserFreshnessDiagnosticsEvidence.flatMap((entry) => {
    return entry.verificationTests.flatMap((verificationTest) => {
      return (verificationTest as string) !== 'src/server/reviewServing/reviewServingRouteParityEvidence.test.ts'
        && existsSync(verificationTest)
        ? []
        : [`${entry.productRoute}: ${entry.expectedSnapshotStatus}: ${verificationTest}`]
    })
  })

  expect([...new Set(freshnessStates)].sort()).toEqual(['indexing', 'stale', 'unavailable'])
  expect([...new Set(snapshotStatuses)].sort()).toEqual(['candidate', 'failed', 'missing', 'retired'])
  expect(missingVerification).toEqual([])
})
