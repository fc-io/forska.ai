import type {ReviewServingReadContract} from './reviewServingContracts.ts'
import type {ReviewServingReaderRequest, ReviewServingReaderResult} from './reviewServingReader.ts'
import {
  type ReviewServingJobParityGate,
  reviewServingJobParityGates,
  type ReviewServingRouteParityGate,
  reviewServingRouteParityGates,
} from './reviewServingRouteParityCoverage.ts'
import type {ReviewServingRouteParityRunnerInput} from './reviewServingRouteParityRunner.ts'

type SemanticRouteRow = {articleId: string; routeKey: string; semantic: string}

type RouteEvidenceInput = ReviewServingRouteParityRunnerInput<SemanticRouteRow> & {
  evidenceGates: readonly ReviewServingRouteParityGate[]
}

type JobEvidenceInput = {
  evidenceCases: readonly string[]
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

const validServingSql =
  'SELECT article_id FROM mart.review_article_serving_v4 WHERE project_id = $projectId AND snapshot_id = $snapshotId ORDER BY sort_key DESC LIMIT $limit'

const getRouteKey = (method: 'GET' | 'POST', productRoute: string) => {
  return `${method} ${productRoute}`
}

const getRequest = (contractKey: ReviewServingReaderRequest['contractKey']): ReviewServingReaderRequest => {
  return {contractKey, limit: 2, projectId: 'project-1', reviewConfigHash: 'config-1', snapshotId: 'snapshot-active'}
}

const getRows = (routeKey: string) => {
  return [{articleId: 'article-1', routeKey, semantic: 'current-behavior-sample'}]
}

const getAcceptedResult = (rows: readonly SemanticRouteRow[]): ReviewServingReaderResult<SemanticRouteRow> => {
  return {
    contract: {} as ReviewServingReadContract,
    diagnostics: {
      admission: {
        contractKey: 'review.llm.rows',
        count: {
          requestedFilterKey: 'project:project-1',
          requestedKey: 'review.list.total',
          state: {
            availability: 'ready',
            filterKey: 'project:project-1',
            key: 'review.list.total',
            snapshotId: 'snapshot-active',
            value: rows.length,
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
          pageSize: {accepted: true, budgetKey: 'maxPageSize', limit: 100, rejectionReason: null, requested: 2},
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
        servingIdentity: {accepted: true, projectId: 'project-1', snapshotId: 'snapshot-active'},
        workloadClass: {matches: true, registered: 'foregroundReviewRows', requested: 'foregroundReviewRows'},
      },
      contractKey: 'review.llm.rows',
      cursor: {reason: null, valid: true},
      diagnostics: null,
      filterSignature: 'filters:project-1',
      manifest: {
        freshness: 'ready',
        lastError: null,
        projectId: 'project-1',
        snapshotId: 'snapshot-active',
        status: 'active',
      },
      missingRequiredComponents: [],
      rejectionReason: null,
      sqlShapeViolations: [],
    },
    getCursorForRow: (row) => {
      return typeof row.articleId === 'string' ? `cursor:${row.articleId}` : 'cursor:unknown'
    },
    rows: [...rows],
    sql: validServingSql,
    status: 'accepted',
  }
}

const routeEvidence = (input: {
  contractKey: ReviewServingReaderRequest['contractKey']
  method: 'GET' | 'POST'
  productRoute: string
}): RouteEvidenceInput => {
  const routeKey = getRouteKey(input.method, input.productRoute)
  const rows = getRows(routeKey)

  return {
    cases: [
      {
        currentBehaviorRows: async () => {
          return rows
        },
        expectedCursorValid: true,
        expectedFreshness: 'ready',
        expectedNamedCountState: {
          availability: 'ready',
          filterKey: 'project:project-1',
          key: 'review.list.total',
          snapshotId: 'snapshot-active',
        },
        expectedRows: rows,
        maxCurrentBehaviorBytes: 50_000,
        maxCurrentBehaviorRows: 2,
        maxLatencyMs: 1_000,
        maxResultBytes: 50_000,
        name: `${routeKey} semantic fixture and sampled current behavior`,
        request: getRequest(input.contractKey),
      },
    ],
    evidenceGates: reviewServingRouteParityGates,
    reader: async () => {
      return getAcceptedResult(rows)
    },
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
      'durable job row is persisted with job kind and request identity',
      'worker consumes selection with keyset batches instead of foreground all-id payloads',
      'article-id-only paths enforce per-request caps',
      'filter/search criteria persist filter signatures and snapshot semantics',
      'foreground response returns job metadata instead of hydrated article payloads',
    ],
    evidenceGates: reviewServingJobParityGates,
    method: input.method,
    productRoute: input.productRoute,
    verificationTests: input.verificationTests,
  }
}

export const reviewServingRouteParityEvidence = [
  routeEvidence({contractKey: 'review.llm.rows', method: 'POST', productRoute: '/api/articlesreviews'}),
  routeEvidence({contractKey: 'review.llm.count', method: 'POST', productRoute: '/api/articlesreviewscount'}),
  routeEvidence({contractKey: 'review.human.rows', method: 'POST', productRoute: '/api/articlesreviewshuman'}),
  routeEvidence({contractKey: 'review.both.rows', method: 'POST', productRoute: '/api/articlesreviewsboth'}),
  routeEvidence({
    contractKey: 'review.unassessed.rows',
    method: 'POST',
    productRoute: '/api/articlesreviewsunassessed',
  }),
  routeEvidence({contractKey: 'review.filters.facets', method: 'GET', productRoute: '/api/articlesreviewsfilters'}),
  routeEvidence({
    contractKey: 'review.human.filters.facets',
    method: 'GET',
    productRoute: '/api/articlesreviewshumanfilters',
  }),
  routeEvidence({contractKey: 'review.detail.row', method: 'POST', productRoute: '/api/projectsreview'}),
  routeEvidence({contractKey: 'review.warning.snapshot', method: 'POST', productRoute: '/api/projectsreviewswarnings'}),
  routeEvidence({contractKey: 'review.health.snapshot', method: 'POST', productRoute: '/api/projectsreviewshealth'}),
  routeEvidence({
    contractKey: 'review.prompt.preview',
    method: 'GET',
    productRoute: '/api/projects/:id/prompts/:promptId/preview',
  }),
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
    verificationTests: ['src/server/reviewServing/reviewServingRouteParityEvidence.test.ts'],
  },
  {
    browserSurface: 'review-flow-route-diagnostics',
    expectedFreshness: 'unavailable',
    expectedSnapshotStatus: 'missing',
    productRoute: '/api/articlesreviews',
    verificationTests: ['src/server/reviewServing/reviewServingLlmReviewRouteService.test.ts'],
  },
] as const satisfies readonly ReviewServingFreshnessDiagnosticsEvidenceCase[]
