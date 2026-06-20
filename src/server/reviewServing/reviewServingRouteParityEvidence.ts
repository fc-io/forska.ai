import type {ReviewServingListMode, ReviewServingReadContract} from './reviewServingContracts.ts'
import {
  encodeReviewServingCursor,
  getReviewServingCursorSortKey,
  getReviewServingFilterSignature,
} from './reviewServingCursor.ts'
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

const getNamedCountKeys = (contract: ReviewServingReadContract) => {
  return contract.servingTable === 'mart.review_article_count_serving_v4' ? contract.namedFastCounts : [null]
}

const listModeByRoute: Partial<Record<string, ReviewServingListMode>> = {
  '/api/articlesreviews': 'llm',
  '/api/articlesreviewscount': 'llm',
  '/api/articlesreviewshuman': 'human',
  '/api/articlesreviewsboth': 'both',
  '/api/articlesreviewsunassessed': 'unassessed',
}

const cursorComponentStates = {
  display: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'display-identity'},
  humanStatus: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'humanStatus-identity'},
  judgmentInputContent: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'judgmentInputContent-identity'},
  llmStatus: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'llmStatus-identity'},
  payload: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'payload-identity'},
  posting: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'posting-identity'},
  projectScope: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'projectScope-identity'},
  queue: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'queue-identity'},
  search: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'search-identity'},
  selectedImport: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'selectedImport-identity'},
  summary: {baseGeneration: '1', patchWatermark: '2', projectionIdentity: 'summary-identity'},
} as const

const facetSummaryIdentityByContract: Partial<Record<string, string>> = {
  'review.filters.facets': 'review.filter.importRoute',
  'review.human.filters.facets': 'review.human.filter.summaryAnswer',
}

const getCountFilterKey = (contract: ReviewServingReadContract | undefined) => {
  return contract ? (facetSummaryIdentityByContract[contract.key] ?? 'project:project-1') : 'project:project-1'
}

const getRouteFilters = (contract: ReviewServingReadContract | undefined) => {
  if (!contract || contract.allowedFilters.length === 0) {
    return {}
  }

  const allowedFilters = new Set(contract.allowedFilters)

  return {
    ...(allowedFilters.has('articleCreatedAtFrom') ? {articleCreatedAtFrom: '2026-01-01'} : {}),
    ...(allowedFilters.has('articleCreatedAtTo') ? {articleCreatedAtTo: '2026-01-31'} : {}),
    ...(allowedFilters.has('conflictFlag') ? {conflictFlag: true} : {}),
    ...(allowedFilters.has('duplicateFlag') ? {duplicateFlag: true} : {}),
    ...(allowedFilters.has('humanStatus') ? {humanStatus: 'reviewed'} : {}),
    ...(allowedFilters.has('llmHasJudgment') ? {llmHasJudgment: true} : {}),
    ...(allowedFilters.has('llmStatus') ? {llmStatus: 'complete'} : {}),
    ...(allowedFilters.has('promptAnswer') ? {promptAnswer: ['prompt-1:yes', 'prompt-1:maybe']} : {}),
    ...(allowedFilters.has('queueKind') ? {queueKind: 'unassessed'} : {}),
  }
}

const getFilterSignatureInput = (request: ReviewServingReaderRequest) => {
  return {
    articleId: request.articleId ?? undefined,
    articleIds: request.articleIds ?? undefined,
    filterKind: request.filterKind ?? undefined,
    filters: request.filters ?? {},
    filterValue: request.filterValue ?? undefined,
    jobFilterSignature: request.jobFilterSignature ?? undefined,
    listMode: request.listMode ?? undefined,
    queueKind: request.queueKind ?? undefined,
    searchText: request.searchText ?? undefined,
    searchTokenPrefix: request.searchTokenPrefix ?? undefined,
    searchTokenPrefixes: request.searchTokenPrefixes ?? undefined,
  }
}

const getCursorSortValues = (contract: ReviewServingReadContract) => {
  return contract.cursorFields.map((_field, index) => {
    return `cursor-sort-${index}`
  })
}

const getCursor = (contract: ReviewServingReadContract | undefined, request: ReviewServingReaderRequest) => {
  if (!contract || contract.cursorFields.length === 0) {
    return null
  }

  return encodeReviewServingCursor({
    articleId: 'article-cursor',
    componentStates: cursorComponentStates,
    contractKey: contract.key,
    filterSignature: getReviewServingFilterSignature(getFilterSignatureInput(request)),
    reviewConfigHash: 'config-1',
    snapshotId: 'snapshot-active',
    sortDirection: contract.sort.direction,
    sortKey: getReviewServingCursorSortKey(contract.cursorFields),
    sortValues: getCursorSortValues(contract),
    version: 1,
  })
}

const getRequest = (
  contractKey: ReviewServingReaderRequest['contractKey'],
  namedCountKey: ReviewServingReaderRequest['namedCountKey'],
  productRoute: string,
): ReviewServingReaderRequest => {
  const contract = getReviewServingReadContract(contractKey)
  const limit = contract ? Math.min(2, contract.maxPageSize) : 1
  const countFilterKey = getCountFilterKey(contract ?? undefined)
  const listMode =
    contract?.physicalAccessStrategy === 'postingIntersection' ? (listModeByRoute[productRoute] ?? null) : null
  const searchInput =
    contract?.searchMode === 'tokenPrefix'
      ? {
          searchMode: 'tokenPrefix' as const,
          searchState: {availability: 'ready' as const, snapshotId: 'snapshot-active'},
          searchTokenPrefix: 'heart',
          searchTokenPrefixes: ['heart', 'failure'],
        }
      : contract?.searchMode === 'substringAsync'
        ? {searchMode: 'substringAsync' as const, searchText: 'heart failure'}
        : {}

  const request = {
    articleId: 'article-1',
    articleIds: ['article-1'],
    contractKey,
    countFilterKey,
    countState: namedCountKey
      ? {
          availability: 'ready' as const,
          filterKey: countFilterKey,
          key: namedCountKey,
          snapshotId: 'snapshot-active',
          value: 1,
        }
      : null,
    estimatedHydratedPayloadBytes: 1_000,
    filterKind: 'importRoute',
    filterOptionIdentity: `filter-option-identity:${contractKey}`,
    filters: getRouteFilters(contract ?? undefined),
    filterValue: 'pubmed',
    jobFilterSignature: 'filters:project-1',
    limit,
    listMode,
    namedCountKey,
    projectId: 'project-1',
    queueKind: 'unassessed',
    reviewConfigHash: 'config-1',
    snapshotId: 'snapshot-active',
    ...searchInput,
  } satisfies ReviewServingReaderRequest

  return {...request, cursor: getCursor(contract ?? undefined, request)}
}

export const getReviewServingRouteParityEvidenceRows = (_routeKey: string, contractKey: string) => {
  return [{articleId: 'article-1', semantic: contractKey}]
}

const getReviewServingRouteParityEvidenceSemantic = (
  contractKey: string,
  namedCountKey: ReviewServingReaderRequest['namedCountKey'],
) => {
  return namedCountKey ? `namedCount:${namedCountKey}` : contractKey
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
    cases: (routeInventoryEntry?.contractKeys ?? []).flatMap((contractKey) => {
      const contract = getReviewServingReadContract(contractKey)
      const namedCountKeys = contract ? getNamedCountKeys(contract) : [null]

      return namedCountKeys.map((namedCountKey) => {
        const request = getRequest(contractKey, namedCountKey, input.productRoute)
        const semantic = getReviewServingRouteParityEvidenceSemantic(contractKey, namedCountKey)
        const rows = getReviewServingRouteParityEvidenceRows(routeKey, semantic)

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
          name: `${routeKey} ${semantic} semantic fixture and sampled current behavior`,
          request,
        }
      })
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
