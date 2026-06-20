import {existsSync} from 'node:fs'

import {expect, mock, test} from 'bun:test'

import {
  namedReviewFastCountDefinitions,
  type NamedReviewFastCountKey,
  type ReviewServingProjectionComponent,
  type ReviewServingReadContract,
} from './reviewServingContracts.ts'
import type {ReviewServingReaderRequest} from './reviewServingReader.ts'

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

const getCaseKey = (request: ReviewServingReaderRequest) => {
  return request.namedCountKey ? `${request.contractKey}:${request.namedCountKey}` : request.contractKey
}

const getSqlFixtureKey = (request: ReviewServingReaderRequest) => {
  return request.namedCountKey ? `namedCount:${request.namedCountKey}` : request.contractKey
}

const containsSql = (statement: string, value: string) => {
  return statement.includes(value)
}

const countListModeByKey: Partial<Record<NamedReviewFastCountKey, string>> = {
  'review.both.conflictByPrompt': 'both',
  'review.human.reviewedByPrompt': 'human',
  'review.llm.assessedByPrompt': 'llm',
  'review.llm.unassessedByPrompt': 'unassessed',
  'review.queue.unassessedReady': 'unassessed',
}

const getNamedCountSqlMatch = (
  statement: string,
  contract: ReviewServingReadContract,
  request: ReviewServingReaderRequest,
) => {
  if (contract.servingTable !== 'mart.review_article_count_serving_v4' || !request.namedCountKey) {
    return true
  }

  const summaryDefinition = namedReviewFastCountDefinitions[request.namedCountKey]
  const listModeKey = countListModeByKey[request.namedCountKey] ?? contract.listMode ?? 'global'

  return [
    containsSql(statement, `list_mode_key = '${listModeKey}'`),
    containsSql(statement, `count_kind = '${request.namedCountKey}'`),
    containsSql(statement, `summary_definition_version = '${summaryDefinition.summaryDefinitionVersion}'`),
    containsSql(statement, `filter_key = '${request.countFilterKey}'`),
  ].every((check) => {
    return check
  })
}

const getFacetSqlMatch = (
  statement: string,
  contract: ReviewServingReadContract,
  request: ReviewServingReaderRequest,
) => {
  if (contract.servingTable !== 'mart.review_filter_facet_serving_v4') {
    return true
  }

  const facetDefinitionVersions = contract.namedFastCounts
    .map((countKey) => {
      return namedReviewFastCountDefinitions[countKey]
    })
    .filter((definition) => {
      return definition.kind === 'facet'
    })
    .map((definition) => {
      return definition.summaryDefinitionVersion
    })
  const facetKind = contract.key === 'review.human.filters.facets' ? 'human' : 'review'

  return [
    containsSql(statement, `facet_kind = '${facetKind}'`),
    containsSql(statement, `summary_identity = '${request.countFilterKey}'`),
    containsSql(statement, 'summary_definition_version'),
    facetDefinitionVersions.every((version) => {
      return containsSql(statement, `'${version}'`)
    }),
  ].every((check) => {
    return check
  })
}

const getAsyncSearchSqlMatch = (
  statement: string,
  contract: ReviewServingReadContract,
  request: ReviewServingReaderRequest,
) => {
  if (contract.servingTable !== 'app.review_search_job') {
    return true
  }

  return [
    containsSql(statement, `search_mode = '${contract.searchMode}'`),
    containsSql(statement, `search_text = '${request.searchText}'`),
    containsSql(statement, `filter_signature = '${request.jobFilterSignature}'`),
    containsSql(statement, `search_identity IS NOT DISTINCT FROM 'search-identity'`),
    containsSql(statement, `project_scope_identity = 'projectScope-identity'`),
    containsSql(statement, `review_config_hash IS NOT DISTINCT FROM '${request.reviewConfigHash}'`),
    containsSql(statement, `snapshot_id IS NOT DISTINCT FROM '${request.snapshotId}'`),
  ].every((check) => {
    return check
  })
}

const getPayloadKindSqlMatch = (statement: string, contract: ReviewServingReadContract) => {
  if (
    contract.key === 'review.detail.humanJudgments'
    || contract.key === 'review.human.list.judgments'
    || contract.key === 'review.both.list.humanJudgments'
  ) {
    return containsSql(statement, "payload_kind = 'human'")
  }

  if (
    contract.key === 'review.detail.judgments'
    || contract.key === 'review.llm.list.judgments'
    || contract.key === 'review.both.list.judgments'
  ) {
    return containsSql(statement, "payload_kind = 'llm'")
  }

  return true
}

const getContractSqlMatch = (
  statement: string,
  contract: ReviewServingReadContract,
  request: ReviewServingReaderRequest,
) => {
  const checks = [
    containsSql(statement, `FROM ${contract.servingTable} WHERE`),
    contract.servingTable === 'app.review_bulk_operation_job'
      ? containsSql(statement, `job_kind = '${contract.key}'`)
      : true,
    getAsyncSearchSqlMatch(statement, contract, request),
    getNamedCountSqlMatch(statement, contract, request),
    getFacetSqlMatch(statement, contract, request),
    contract.servingTable === 'mart.review_filter_option_serving_v4' && request.filterOptionIdentity
      ? containsSql(statement, `'${request.filterOptionIdentity}'`)
      : true,
    contract.physicalAccessStrategy === 'articleSetLookup' ? containsSql(statement, 'article_id IN') : true,
    contract.physicalAccessStrategy !== 'articleSetLookup' ? !containsSql(statement, 'article_id IN') : true,
    contract.physicalAccessStrategy === 'keyedLookup' && contract.allowedFilters.includes('articleId')
      ? containsSql(statement, "article_id = 'article-1'")
      : true,
    contract.physicalAccessStrategy !== 'keyedLookup' ? !containsSql(statement, "article_id = 'article-1'") : true,
    contract.physicalAccessStrategy === 'queueOrdering' ? containsSql(statement, "queue_kind = 'unassessed'") : true,
    contract.listMode && contract.physicalAccessStrategy !== 'queueOrdering'
      ? containsSql(statement, `list_mode_key = '${contract.listMode}'`)
      : true,
    contract.physicalAccessStrategy === 'postingIntersection' && request.listMode
      ? containsSql(statement, `list_mode_key = '${request.listMode}'`)
      : true,
    contract.physicalAccessStrategy === 'tokenPrefixIndex' ? containsSql(statement, 'starts_with(token,') : true,
    getPayloadKindSqlMatch(statement, contract),
    contract.servingTable === 'app.review_serving_snapshot_manifest'
      ? containsSql(statement, `LIMIT ${request.limit}`)
      : true,
    contract.key === 'review.warning.snapshot' || contract.key === 'review.health.snapshot'
      ? containsSql(statement, "snapshot_status IN ('active', 'retired')")
      : true,
  ]

  return checks.every((check) => {
    return check
  })
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
  const contracts = await import('./reviewServingReadContracts.ts')
  const evidence = await import('./reviewServingRouteParityEvidence.ts')
  const evidenceCases = evidence.reviewServingRouteParityEvidence.flatMap((entry) => {
    return entry.cases
  })
  const rowByContractKey = new Map(
    evidenceCases.map((caseInput) => {
      return [getSqlFixtureKey(caseInput.request), caseInput.expectedRows]
    }),
  )

  return {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
        if (
          (statement.includes('snapshot_id AS snapshotId') || statement.includes('snapshot_id AS snapshot_id'))
          && statement.includes('AND snapshot_id =')
        ) {
          return [getSnapshotRow()] as T[]
        }

        if (!statement.includes("snapshot_status IN ('active', 'retired')")) {
          return getDiagnosticsRows(statement) as T[]
        }
      }

      const matchedCase = evidenceCases.find((caseInput) => {
        const contract = contracts.getReviewServingReadContract(caseInput.request.contractKey)

        return contract ? getContractSqlMatch(statement, contract, caseInput.request) : false
      })

      return (matchedCase ? rowByContractKey.get(getSqlFixtureKey(matchedCase.request)) : []) as T[]
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
      return entry.contractKeys.flatMap((contractKey) => {
        const contract = contracts.getReviewServingReadContract(contractKey)
        const namedCountKeys =
          contract?.servingTable === 'mart.review_article_count_serving_v4' ? contract.namedFastCounts : [null]

        return namedCountKeys.map((namedCountKey) => {
          return namedCountKey
            ? `${getRouteKey(entry)} ${contractKey}:${namedCountKey}`
            : `${getRouteKey(entry)} ${contractKey}`
        })
      })
    })
  const actualContractCases = evidence.reviewServingRouteParityEvidence.flatMap((entry) => {
    return entry.cases.map((caseInput) => {
      return `${entry.routeKey} ${getCaseKey(caseInput.request)}`
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
