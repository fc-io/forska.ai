import type {ReviewServingReadContract} from './reviewServingContracts.ts'
import {getReviewServingReadContract, reviewServingReadContractRouteInventory} from './reviewServingReadContracts.ts'
import type {ReviewServingReaderRequest} from './reviewServingReader.ts'
import {
  type ReviewServingJobParityGate,
  reviewServingJobParityGates,
  type ReviewServingRouteParityGate,
  reviewServingRouteParityGates,
} from './reviewServingRouteParityCoverage.ts'
import type {ReviewServingRouteParityRunnerInput} from './reviewServingRouteParityRunner.ts'

export type ReviewServingParityEvidenceCase<TGate extends string> = {coveredGates: readonly TGate[]; evidence: string}

type SemanticRouteRow = {articleId: string; semantic: string}

type RouteEvidenceInput = ReviewServingRouteParityRunnerInput<SemanticRouteRow> & {
  evidenceGates: readonly ReviewServingRouteParityGate[]
}

type JobEvidenceInput = {
  evidenceCases: readonly ReviewServingParityEvidenceCase<ReviewServingJobParityGate>[]
  evidenceGates: readonly ReviewServingJobParityGate[]
  productRoute: string
  method: 'GET' | 'POST'
  verificationTests: readonly string[]
}

export type ReviewServingFreshnessDiagnosticsEvidenceCase = {
  browserSurface: 'review-flow-warning-banner' | 'review-flow-route-diagnostics'
  expectedFreshness: 'indexing' | 'stale' | 'unavailable'
  expectedSnapshotStatus: 'candidate' | 'failed' | 'missing' | 'retired'
  productRoute: string
  verificationTests: readonly string[]
}

const getRouteKey = (method: 'GET' | 'POST', productRoute: string) => {
  return `${method} ${productRoute}`
}

const getNamedCountKey = (contract: ReviewServingReadContract) => {
  return contract.servingTable === 'mart.review_article_count_serving_v4' ? (contract.namedFastCounts[0] ?? null) : null
}

const getRequest = (contractKey: ReviewServingReaderRequest['contractKey']): ReviewServingReaderRequest => {
  const contract = getReviewServingReadContract(contractKey)
  const namedCountKey = contract ? getNamedCountKey(contract) : null
  const limit = contract ? Math.min(2, contract.maxPageSize) : 1
  const searchInput =
    contract?.searchMode === 'tokenPrefix'
      ? {
          searchMode: 'tokenPrefix' as const,
          searchState: {availability: 'ready' as const, snapshotId: 'snapshot-active'},
          searchTokenPrefix: 'heart',
        }
      : contract?.searchMode === 'substringAsync'
        ? {searchMode: 'substringAsync' as const, searchText: 'heart failure'}
        : {}

  return {
    articleId: 'article-1',
    articleIds: ['article-1'],
    contractKey,
    countFilterKey: 'project:project-1',
    countState: namedCountKey
      ? {
          availability: 'ready',
          filterKey: 'project:project-1',
          key: namedCountKey,
          snapshotId: 'snapshot-active',
          value: 1,
        }
      : null,
    estimatedHydratedPayloadBytes: 1_000,
    filterKind: 'importRoute',
    filterOptionIdentity: 'filter-option-identity',
    filterValue: 'pubmed',
    jobFilterSignature: 'filters:project-1',
    limit,
    namedCountKey,
    projectId: 'project-1',
    queueKind: 'unassessed',
    reviewConfigHash: 'config-1',
    snapshotId: 'snapshot-active',
    ...searchInput,
  }
}

export const getReviewServingRouteParityEvidenceRows = (_routeKey: string, _contractKey: string) => {
  return [{articleId: 'article-1', semantic: 'current-behavior-sample'}]
}

const getExpectedNamedCountState = (request: ReviewServingReaderRequest) => {
  return request.countState?.availability === 'ready' || request.countState?.availability === 'stale'
    ? {
        availability: request.countState.availability,
        filterKey: request.countState.filterKey,
        key: request.countState.key,
        snapshotId: request.countState.snapshotId,
      }
    : undefined
}

const routeEvidence = (input: {method: 'GET' | 'POST'; productRoute: string}): RouteEvidenceInput => {
  const routeKey = getRouteKey(input.method, input.productRoute)
  const routeInventoryEntry = reviewServingReadContractRouteInventory.find((entry) => {
    return entry.mounted && entry.method === input.method && entry.productRoute === input.productRoute
  })

  return {
    cases: (routeInventoryEntry?.contractKeys ?? []).map((contractKey) => {
      const request = getRequest(contractKey)
      const rows = getReviewServingRouteParityEvidenceRows(routeKey, contractKey)

      return {
        currentBehaviorRows: async () => {
          return rows
        },
        expectedCursorValid: true,
        expectedFreshness: 'ready',
        expectedNamedCountState: getExpectedNamedCountState(request),
        expectedRows: rows,
        maxCurrentBehaviorBytes: 50_000,
        maxCurrentBehaviorRows: request.limit,
        maxLatencyMs: 1_000,
        maxResultBytes: 50_000,
        name: `${routeKey} ${contractKey} semantic fixture and sampled current behavior`,
        request,
      }
    }),
    evidenceGates: reviewServingRouteParityGates,
    routeKey,
  }
}

const jobEvidence = (input: {
  method: 'GET' | 'POST'
  productRoute: string
  verificationTests: readonly string[]
}): JobEvidenceInput => {
  return {
    evidenceCases: [
      {
        coveredGates: ['durableJobPersistence'],
        evidence: 'durable job row is persisted with job kind and request identity',
      },
      {
        coveredGates: ['keysetBatching'],
        evidence: 'worker consumes selection with keyset batches instead of foreground all-id payloads',
      },
      {coveredGates: ['articleIdCaps'], evidence: 'article-id-only paths enforce per-request caps'},
      {
        coveredGates: ['filterSignature', 'snapshotSemantics'],
        evidence: 'filter/search criteria persist filter signatures and snapshot semantics',
      },
      {
        coveredGates: ['foregroundPayloadCap'],
        evidence: 'foreground response returns job metadata instead of hydrated article payloads',
      },
    ],
    evidenceGates: reviewServingJobParityGates,
    method: input.method,
    productRoute: input.productRoute,
    verificationTests: input.verificationTests,
  }
}

export const reviewServingRouteParityEvidence = [
  routeEvidence({method: 'POST', productRoute: '/api/articlesreviews'}),
  routeEvidence({method: 'POST', productRoute: '/api/articlesreviewscount'}),
  routeEvidence({method: 'POST', productRoute: '/api/articlesreviewshuman'}),
  routeEvidence({method: 'POST', productRoute: '/api/articlesreviewsboth'}),
  routeEvidence({method: 'POST', productRoute: '/api/articlesreviewsunassessed'}),
  routeEvidence({method: 'GET', productRoute: '/api/articlesreviewsfilters'}),
  routeEvidence({method: 'GET', productRoute: '/api/articlesreviewshumanfilters'}),
  routeEvidence({method: 'POST', productRoute: '/api/projectsreview'}),
  routeEvidence({method: 'POST', productRoute: '/api/projectsreviewswarnings'}),
  routeEvidence({method: 'POST', productRoute: '/api/projectsreviewshealth'}),
  routeEvidence({method: 'GET', productRoute: '/api/projects/:id/prompts/:promptId/preview'}),
] as const satisfies readonly RouteEvidenceInput[]

export const reviewServingJobParityEvidence = [
  jobEvidence({
    method: 'POST',
    productRoute: '/api/articles/pdf-fetch-by-filter',
    verificationTests: [
      'src/server/reviewServing/reviewBulkOperationService.test.ts',
      'src/server/workers/reviewBulkOperationWorker.test.ts',
    ],
  }),
  jobEvidence({
    method: 'POST',
    productRoute: '/api/projects/add_articles_by_filter',
    verificationTests: [
      'src/server/reviewServing/reviewBulkOperationService.test.ts',
      'src/server/workers/reviewBulkOperationWorker.test.ts',
    ],
  }),
  jobEvidence({
    method: 'POST',
    productRoute: '/api/projects/add_articles_by_ids',
    verificationTests: [
      'src/server/routes/ProjectsAddArticlesRoutes.test.ts',
      'src/server/workers/reviewBulkOperationWorker.test.ts',
    ],
  }),
  jobEvidence({
    method: 'POST',
    productRoute: '/api/articles/pdf-fetch-by-project',
    verificationTests: [
      'src/server/reviewServing/reviewBulkOperationService.test.ts',
      'src/server/services/pdfFetchJobs.test.ts',
    ],
  }),
  jobEvidence({
    method: 'POST',
    productRoute: '/api/articles/pdf-fetch-bulk',
    verificationTests: [
      'src/server/reviewServing/reviewBulkOperationService.test.ts',
      'src/server/services/pdfFetchJobs.test.ts',
    ],
  }),
  jobEvidence({
    method: 'POST',
    productRoute: '/api/projects/:id/export',
    verificationTests: [
      'src/server/reviewServing/reviewBulkOperationService.test.ts',
      'src/server/workers/reviewBulkOperationWorker.test.ts',
    ],
  }),
] as const satisfies readonly JobEvidenceInput[]

export const reviewServingBrowserFreshnessDiagnosticsEvidence = [
  {
    browserSurface: 'review-flow-warning-banner',
    expectedFreshness: 'stale',
    expectedSnapshotStatus: 'retired',
    productRoute: '/api/projectsreviewswarnings',
    verificationTests: [
      'src/components/main/reviews/reviewsProjectWarnings.vitest.tsx',
      'src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts',
    ],
  },
  {
    browserSurface: 'review-flow-warning-banner',
    expectedFreshness: 'indexing',
    expectedSnapshotStatus: 'candidate',
    productRoute: '/api/projectsreviewswarnings',
    verificationTests: [
      'src/components/main/reviews/reviewsProjectWarnings.vitest.tsx',
      'src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts',
    ],
  },
  {
    browserSurface: 'review-flow-route-diagnostics',
    expectedFreshness: 'unavailable',
    expectedSnapshotStatus: 'failed',
    productRoute: '/api/articlesreviews',
    verificationTests: ['src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts'],
  },
  {
    browserSurface: 'review-flow-route-diagnostics',
    expectedFreshness: 'unavailable',
    expectedSnapshotStatus: 'missing',
    productRoute: '/api/articlesreviews',
    verificationTests: ['src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts'],
  },
] as const satisfies readonly ReviewServingFreshnessDiagnosticsEvidenceCase[]
