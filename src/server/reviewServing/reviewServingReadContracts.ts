import {
  isReviewServingReadContractKey,
  type NamedReviewFastCountKey,
  type ReviewServingFilterKey,
  type ReviewServingListMode,
  type ReviewServingProjectionComponent,
  type ReviewServingReadContract,
  type ReviewServingReadContractKey,
  reviewServingReadContractKeys,
} from './reviewServingContracts.ts'

type ContractInput = Omit<
  ReviewServingReadContract,
  'allowsTempSpill' | 'maxEstimatedResultBytes' | 'maxResultRows'
> & {allowsTempSpill?: boolean; maxEstimatedResultBytes?: number; maxResultRows?: number}

const baseComponents = ['display', 'projectScope', 'selectedImport', 'payload'] as const
const llmComponents = [...baseComponents, 'llmStatus', 'posting', 'summary'] as const
const humanComponents = [...baseComponents, 'humanStatus', 'posting', 'summary'] as const
const bothComponents = [...baseComponents, 'llmStatus', 'humanStatus', 'posting', 'summary'] as const
const queueComponents = [
  'judgmentInputContent',
  'projectScope',
  'selectedImport',
  'llmStatus',
  'queue',
  'summary',
] as const
const defaultRowFilters = ['duplicateFlag', 'importRoute', 'publicationYear', 'searchTokenPrefix'] as const
const defaultReviewCounts = ['review.list.total', 'review.list.filteredTotal'] as const
const reviewArticleServingTable = 'mart.review_article_serving_v4'
const reviewCountServingTable = 'mart.review_article_count_serving_v4'
const reviewFacetServingTable = 'mart.review_filter_facet_serving_v4'
const reviewQueueServingTable = 'mart.review_unassessed_queue_serving_v4'
const reviewSearchServingTable = 'mart.review_title_search_serving_v4'

const defineContract = (input: ContractInput): ReviewServingReadContract => {
  return {
    ...input,
    allowsTempSpill: input.allowsTempSpill ?? false,
    maxEstimatedResultBytes: input.maxEstimatedResultBytes ?? 2_000_000,
    maxResultRows: input.maxResultRows ?? input.maxPageSize,
  }
}

const rowContract = (input: {
  allowedFilters: readonly ReviewServingFilterKey[]
  key: ReviewServingReadContractKey
  listMode: ReviewServingListMode
  namedFastCounts: readonly NamedReviewFastCountKey[]
  requiredComponents: readonly ReviewServingProjectionComponent[]
}) => {
  return defineContract({
    allowedFilters: input.allowedFilters,
    cursorFields: ['sort_key', 'article_id'],
    freshnessBehavior: 'requireReadySnapshot',
    key: input.key,
    listMode: input.listMode,
    maxPageSize: 100,
    namedFastCounts: input.namedFastCounts,
    optionalComponents: ['search'],
    physicalAccessStrategy: 'orderedPrefix',
    requiredComponents: input.requiredComponents,
    searchMode: 'tokenPrefix',
    servingTable: reviewArticleServingTable,
    sort: {direction: 'desc', fields: ['sort_key', 'article_id']},
    workloadClass: 'foregroundReviewRows',
  })
}

export const reviewServingReadContractList = [
  rowContract({
    allowedFilters: [...defaultRowFilters, 'llmStatus', 'promptAnswer'],
    key: 'review.llm.rows',
    listMode: 'llm',
    namedFastCounts: [...defaultReviewCounts, 'review.llm.assessedByPrompt'],
    requiredComponents: llmComponents,
  }),
  defineContract({
    allowedFilters: [...defaultRowFilters, 'llmStatus', 'promptAnswer'],
    cursorFields: [],
    freshnessBehavior: 'requireReadySnapshot',
    key: 'review.llm.count',
    listMode: 'llm',
    maxPageSize: 1,
    maxResultRows: 1,
    namedFastCounts: [...defaultReviewCounts, 'review.llm.assessedByPrompt', 'review.llm.unassessedByPrompt'],
    optionalComponents: [],
    physicalAccessStrategy: 'summaryLookup',
    requiredComponents: ['llmStatus', 'posting', 'summary'],
    searchMode: 'none',
    servingTable: reviewCountServingTable,
    sort: {direction: 'asc', fields: ['summary_key']},
    workloadClass: 'foregroundReviewCount',
  }),
  rowContract({
    allowedFilters: [...defaultRowFilters, 'humanStatus', 'promptAnswer'],
    key: 'review.human.rows',
    listMode: 'human',
    namedFastCounts: [...defaultReviewCounts, 'review.human.reviewedByPrompt'],
    requiredComponents: humanComponents,
  }),
  defineContract({
    allowedFilters: [...defaultRowFilters, 'humanStatus', 'promptAnswer'],
    cursorFields: [],
    freshnessBehavior: 'requireReadySnapshot',
    key: 'review.human.count',
    listMode: 'human',
    maxPageSize: 1,
    maxResultRows: 1,
    namedFastCounts: [...defaultReviewCounts, 'review.human.reviewedByPrompt'],
    optionalComponents: [],
    physicalAccessStrategy: 'summaryLookup',
    requiredComponents: ['humanStatus', 'posting', 'summary'],
    searchMode: 'none',
    servingTable: reviewCountServingTable,
    sort: {direction: 'asc', fields: ['summary_key']},
    workloadClass: 'foregroundReviewCount',
  }),
  rowContract({
    allowedFilters: [...defaultRowFilters, 'conflictFlag', 'humanStatus', 'llmStatus', 'promptAnswer'],
    key: 'review.both.rows',
    listMode: 'both',
    namedFastCounts: [...defaultReviewCounts, 'review.both.conflictByPrompt'],
    requiredComponents: bothComponents,
  }),
  defineContract({
    allowedFilters: [...defaultRowFilters, 'conflictFlag', 'humanStatus', 'llmStatus', 'promptAnswer'],
    cursorFields: [],
    freshnessBehavior: 'requireReadySnapshot',
    key: 'review.both.count',
    listMode: 'both',
    maxPageSize: 1,
    maxResultRows: 1,
    namedFastCounts: [...defaultReviewCounts, 'review.both.conflictByPrompt'],
    optionalComponents: [],
    physicalAccessStrategy: 'summaryLookup',
    requiredComponents: ['llmStatus', 'humanStatus', 'posting', 'summary'],
    searchMode: 'none',
    servingTable: reviewCountServingTable,
    sort: {direction: 'asc', fields: ['summary_key']},
    workloadClass: 'foregroundReviewCount',
  }),
  rowContract({
    allowedFilters: ['importRoute', 'publicationYear', 'queueKind', 'searchTokenPrefix'],
    key: 'review.unassessed.rows',
    listMode: 'unassessed',
    namedFastCounts: ['review.queue.unassessedReady', 'review.llm.unassessedByPrompt'],
    requiredComponents: queueComponents,
  }),
  defineContract({
    allowedFilters: ['importRoute', 'publicationYear', 'queueKind'],
    cursorFields: [],
    freshnessBehavior: 'requireReadySnapshot',
    key: 'review.unassessed.count',
    listMode: 'unassessed',
    maxPageSize: 1,
    maxResultRows: 1,
    namedFastCounts: ['review.queue.unassessedReady', 'review.llm.unassessedByPrompt'],
    optionalComponents: [],
    physicalAccessStrategy: 'summaryLookup',
    requiredComponents: ['queue', 'summary'],
    searchMode: 'none',
    servingTable: reviewCountServingTable,
    sort: {direction: 'asc', fields: ['summary_key']},
    workloadClass: 'foregroundReviewCount',
  }),
  defineContract({
    allowedFilters: [
      'conflictFlag',
      'duplicateFlag',
      'humanStatus',
      'importRoute',
      'llmStatus',
      'promptAnswer',
      'publicationYear',
    ],
    cursorFields: [],
    freshnessBehavior: 'requireReadySnapshot',
    key: 'review.filters.facets',
    listMode: null,
    maxPageSize: 1,
    maxResultRows: 128,
    namedFastCounts: [
      'review.filter.duplicateFlag',
      'review.filter.importRoute',
      'review.filter.promptAnswer',
      'review.filter.publicationYear',
    ],
    optionalComponents: [],
    physicalAccessStrategy: 'summaryLookup',
    requiredComponents: ['posting', 'summary'],
    searchMode: 'none',
    servingTable: reviewFacetServingTable,
    sort: {direction: 'asc', fields: ['facet_key', 'facet_value']},
    workloadClass: 'foregroundReviewFacet',
  }),
  defineContract({
    allowedFilters: ['promptAnswer'],
    cursorFields: [],
    freshnessBehavior: 'requireReadySnapshot',
    key: 'review.prompt.badges',
    listMode: null,
    maxPageSize: 1,
    maxResultRows: 512,
    namedFastCounts: [
      'review.both.conflictByPrompt',
      'review.human.reviewedByPrompt',
      'review.llm.assessedByPrompt',
      'review.llm.unassessedByPrompt',
    ],
    optionalComponents: [],
    physicalAccessStrategy: 'summaryLookup',
    requiredComponents: ['llmStatus', 'humanStatus', 'summary'],
    searchMode: 'none',
    servingTable: reviewCountServingTable,
    sort: {direction: 'asc', fields: ['prompt_id', 'summary_key']},
    workloadClass: 'foregroundReviewCount',
  }),
  defineContract({
    allowedFilters: ['queueKind'],
    cursorFields: ['priority_bucket', 'sort_key', 'article_id'],
    freshnessBehavior: 'requireReadySnapshot',
    key: 'review.queue.unassessed',
    listMode: 'unassessed',
    maxPageSize: 100,
    namedFastCounts: ['review.queue.unassessedReady'],
    optionalComponents: [],
    physicalAccessStrategy: 'queueOrdering',
    requiredComponents: ['queue'],
    searchMode: 'none',
    servingTable: reviewQueueServingTable,
    sort: {direction: 'asc', fields: ['priority_bucket', 'sort_key', 'article_id']},
    workloadClass: 'foregroundReviewQueue',
  }),
  defineContract({
    allowedFilters: [...defaultRowFilters, 'conflictFlag', 'humanStatus', 'llmStatus', 'promptAnswer', 'queueKind'],
    cursorFields: ['sort_key', 'article_id'],
    freshnessBehavior: 'requireReadySnapshot',
    key: 'review.bulk.selection',
    listMode: null,
    maxEstimatedResultBytes: 500_000,
    maxPageSize: 1,
    maxResultRows: 0,
    namedFastCounts: [],
    optionalComponents: ['search'],
    physicalAccessStrategy: 'jobCriteria',
    requiredComponents: ['projectScope', 'posting', 'summary'],
    searchMode: 'tokenPrefix',
    servingTable: 'app.review_bulk_operation_job',
    sort: {direction: 'asc', fields: ['article_id']},
    workloadClass: 'bulkReviewJob',
  }),
  defineContract({
    allowedFilters: [...defaultRowFilters, 'conflictFlag', 'humanStatus', 'llmStatus', 'promptAnswer'],
    cursorFields: ['sort_key', 'article_id'],
    freshnessBehavior: 'requireReadySnapshot',
    key: 'review.export.selection',
    listMode: null,
    maxEstimatedResultBytes: 500_000,
    maxPageSize: 1,
    maxResultRows: 0,
    namedFastCounts: [],
    optionalComponents: ['search'],
    physicalAccessStrategy: 'jobCriteria',
    requiredComponents: ['projectScope', 'posting', 'payload'],
    searchMode: 'tokenPrefix',
    servingTable: 'app.review_bulk_operation_job',
    sort: {direction: 'asc', fields: ['article_id']},
    workloadClass: 'bulkReviewJob',
  }),
  defineContract({
    allowedFilters: [...defaultRowFilters, 'conflictFlag', 'humanStatus', 'llmStatus', 'promptAnswer'],
    cursorFields: ['sort_key', 'article_id'],
    freshnessBehavior: 'requireReadySnapshot',
    key: 'review.pdf.selection',
    listMode: null,
    maxEstimatedResultBytes: 500_000,
    maxPageSize: 1,
    maxResultRows: 0,
    namedFastCounts: [],
    optionalComponents: ['search'],
    physicalAccessStrategy: 'jobCriteria',
    requiredComponents: ['projectScope', 'posting', 'payload'],
    searchMode: 'tokenPrefix',
    servingTable: 'app.review_bulk_operation_job',
    sort: {direction: 'asc', fields: ['article_id']},
    workloadClass: 'bulkReviewJob',
  }),
  defineContract({
    allowedFilters: ['searchTokenPrefix'],
    cursorFields: ['token', 'article_id'],
    freshnessBehavior: 'requireReadySnapshot',
    key: 'review.search.tokenPrefix',
    listMode: null,
    maxPageSize: 50,
    namedFastCounts: [],
    optionalComponents: [],
    physicalAccessStrategy: 'tokenPrefixIndex',
    requiredComponents: ['search'],
    searchMode: 'tokenPrefix',
    servingTable: reviewSearchServingTable,
    sort: {direction: 'asc', fields: ['token', 'article_id']},
    workloadClass: 'foregroundReviewSearch',
  }),
  defineContract({
    allowedFilters: ['searchTokenPrefix'],
    cursorFields: [],
    freshnessBehavior: 'asyncUnavailable',
    key: 'review.search.substringAsync',
    listMode: null,
    maxEstimatedResultBytes: 100_000,
    maxPageSize: 1,
    maxResultRows: 0,
    namedFastCounts: [],
    optionalComponents: ['search'],
    physicalAccessStrategy: 'jobCriteria',
    requiredComponents: ['search'],
    searchMode: 'substringAsync',
    servingTable: 'app.review_search_job',
    sort: {direction: 'asc', fields: ['article_id']},
    workloadClass: 'bulkReviewJob',
  }),
] satisfies readonly ReviewServingReadContract[]

export const reviewServingReadContracts = reviewServingReadContractList.reduce<
  Record<ReviewServingReadContractKey, ReviewServingReadContract>
>(
  (contracts, contract) => {
    return {...contracts, [contract.key]: contract}
  },
  {} as Record<ReviewServingReadContractKey, ReviewServingReadContract>,
)

export const getReviewServingReadContract = (contractKey: string) => {
  return isReviewServingReadContractKey(contractKey) ? reviewServingReadContracts[contractKey] : null
}

export const getMissingReviewServingReadContractKeys = () => {
  return reviewServingReadContractKeys.filter((contractKey) => {
    return reviewServingReadContracts[contractKey] === undefined
  })
}
