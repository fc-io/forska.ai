export const reviewServingProjectionComponents = [
  'display',
  'search',
  'judgmentInputContent',
  'projectScope',
  'selectedImport',
  'llmStatus',
  'humanStatus',
  'queue',
  'posting',
  'summary',
  'payload',
] as const

export type ReviewServingProjectionComponent = (typeof reviewServingProjectionComponents)[number]

export const reviewServingChangeKinds = [
  'article.display.updated',
  'article.searchText.updated',
  'article.judgmentInput.updated',
  'importRoute.article.added',
  'importRoute.article.removed',
  'importRoute.article.rankFields.updated',
  'projectScope.article.added',
  'projectScope.article.removed',
  'judgment.llm.created',
  'judgment.llm.updated',
  'judgment.llm.deleted',
  'judgment.human.updated',
  'prompt.config.updated',
  'project.reviewConfig.updated',
] as const

export type ReviewServingChangeKind = (typeof reviewServingChangeKinds)[number]

export const reviewServingListModes = ['llm', 'human', 'both', 'unassessed'] as const

export type ReviewServingListMode = (typeof reviewServingListModes)[number]

export const reviewServingWorkloadClasses = [
  'foregroundReviewRows',
  'foregroundReviewCount',
  'foregroundReviewFacet',
  'foregroundReviewQueue',
  'foregroundReviewSearch',
  'bulkReviewJob',
  'reviewProjector',
  'reviewMaintenance',
] as const

export type ReviewServingWorkloadClass = (typeof reviewServingWorkloadClasses)[number]

export const reviewServingFilterKeys = [
  'articleId',
  'duplicateFlag',
  'conflictFlag',
  'humanStatus',
  'importRoute',
  'llmStatus',
  'promptAnswer',
  'publicationYear',
  'queueKind',
  'searchTokenPrefix',
] as const

export type ReviewServingFilterKey = (typeof reviewServingFilterKeys)[number]

export const namedReviewFastCountKeys = [
  'review.list.total',
  'review.list.filteredTotal',
  'review.llm.assessedByPrompt',
  'review.llm.unassessedByPrompt',
  'review.human.reviewedByPrompt',
  'review.both.conflictByPrompt',
  'review.queue.unassessedReady',
  'review.filter.duplicateFlag',
  'review.filter.importRoute',
  'review.filter.promptAnswer',
  'review.filter.publicationYear',
] as const

export type NamedReviewFastCountKey = (typeof namedReviewFastCountKeys)[number]

export const reviewServingReadContractKeys = [
  'review.llm.rows',
  'review.llm.count',
  'review.human.rows',
  'review.human.count',
  'review.both.rows',
  'review.both.count',
  'review.unassessed.rows',
  'review.unassessed.count',
  'review.filters.facets',
  'review.prompt.badges',
  'review.queue.unassessed',
  'review.bulk.selection',
  'review.export.selection',
  'review.pdf.selection',
  'review.search.tokenPrefix',
  'review.search.substringAsync',
] as const

export type ReviewServingReadContractKey = (typeof reviewServingReadContractKeys)[number]

export type ReviewServingFreshnessState = 'ready' | 'indexing' | 'stale' | 'unavailable'

export type ReviewServingCountAvailability = 'ready' | 'stale' | 'unavailable' | 'async'

export type ReviewServingSearchAvailability = 'ready' | 'indexing' | 'unavailable' | 'async'

export type ReviewServingPhysicalAccessStrategy =
  | 'jobCriteria'
  | 'keyedLookup'
  | 'orderedPrefix'
  | 'postingIntersection'
  | 'queueOrdering'
  | 'summaryLookup'
  | 'tokenPrefixIndex'

export type ReviewServingFreshnessBehavior = 'allowStaleSnapshot' | 'asyncUnavailable' | 'requireReadySnapshot'

export type ReviewServingSearchMode = 'none' | 'substringAsync' | 'tokenPrefix'

export type ReviewServingSortDirection = 'asc' | 'desc'

export type ReviewServingNamedSummaryDefinition = {
  key: NamedReviewFastCountKey
  kind: 'count' | 'facet'
  requiredComponents: readonly ReviewServingProjectionComponent[]
  summaryDefinitionVersion: string
}

export type ReviewServingReadContract = {
  key: ReviewServingReadContractKey
  allowedFilters: readonly ReviewServingFilterKey[]
  allowsTempSpill: boolean
  cursorFields: readonly string[]
  freshnessBehavior: ReviewServingFreshnessBehavior
  listMode: ReviewServingListMode | null
  maxEstimatedResultBytes: number
  maxPageSize: number
  maxResultRows: number
  namedFastCounts: readonly NamedReviewFastCountKey[]
  optionalComponents: readonly ReviewServingProjectionComponent[]
  physicalAccessStrategy: ReviewServingPhysicalAccessStrategy
  requiredComponents: readonly ReviewServingProjectionComponent[]
  searchMode: ReviewServingSearchMode
  servingTable: string
  sort: {direction: ReviewServingSortDirection; fields: readonly string[]}
  workloadClass: ReviewServingWorkloadClass
}

export type ReviewServingCountState =
  | {availability: 'async'; jobId: string | null; key: NamedReviewFastCountKey; reason: string}
  | {availability: 'ready'; key: NamedReviewFastCountKey; snapshotId: string; value: number}
  | {availability: 'stale'; key: NamedReviewFastCountKey; snapshotId: string; value: number}
  | {availability: 'unavailable'; key: NamedReviewFastCountKey; reason: string}

export type ReviewServingSearchState =
  | {availability: 'async'; jobId: string | null; reason: string}
  | {availability: 'indexing'; reason: string}
  | {availability: 'ready'; snapshotId: string}
  | {availability: 'unavailable'; reason: string}

const isOneOf = <T extends string>(values: readonly T[], value: string): value is T => {
  return (values as readonly string[]).includes(value)
}

export const isReviewServingProjectionComponent = (value: string): value is ReviewServingProjectionComponent => {
  return isOneOf(reviewServingProjectionComponents, value)
}

export const isReviewServingChangeKind = (value: string): value is ReviewServingChangeKind => {
  return isOneOf(reviewServingChangeKinds, value)
}

export const isReviewServingReadContractKey = (value: string): value is ReviewServingReadContractKey => {
  return isOneOf(reviewServingReadContractKeys, value)
}

export const isNamedReviewFastCountKey = (value: string): value is NamedReviewFastCountKey => {
  return isOneOf(namedReviewFastCountKeys, value)
}

export const isReviewServingWorkloadClass = (value: string): value is ReviewServingWorkloadClass => {
  return isOneOf(reviewServingWorkloadClasses, value)
}

export const namedReviewFastCountDefinitions: Record<NamedReviewFastCountKey, ReviewServingNamedSummaryDefinition> = {
  'review.both.conflictByPrompt': {
    key: 'review.both.conflictByPrompt',
    kind: 'count',
    requiredComponents: ['llmStatus', 'humanStatus', 'summary'],
    summaryDefinitionVersion: 'review-both-conflict-by-prompt:v1',
  },
  'review.filter.duplicateFlag': {
    key: 'review.filter.duplicateFlag',
    kind: 'facet',
    requiredComponents: ['display', 'selectedImport', 'summary'],
    summaryDefinitionVersion: 'review-filter-duplicate-flag:v1',
  },
  'review.filter.importRoute': {
    key: 'review.filter.importRoute',
    kind: 'facet',
    requiredComponents: ['projectScope', 'selectedImport', 'summary'],
    summaryDefinitionVersion: 'review-filter-import-route:v1',
  },
  'review.filter.promptAnswer': {
    key: 'review.filter.promptAnswer',
    kind: 'facet',
    requiredComponents: ['llmStatus', 'humanStatus', 'summary'],
    summaryDefinitionVersion: 'review-filter-prompt-answer:v1',
  },
  'review.filter.publicationYear': {
    key: 'review.filter.publicationYear',
    kind: 'facet',
    requiredComponents: ['display', 'summary'],
    summaryDefinitionVersion: 'review-filter-publication-year:v1',
  },
  'review.human.reviewedByPrompt': {
    key: 'review.human.reviewedByPrompt',
    kind: 'count',
    requiredComponents: ['humanStatus', 'summary'],
    summaryDefinitionVersion: 'review-human-reviewed-by-prompt:v1',
  },
  'review.list.filteredTotal': {
    key: 'review.list.filteredTotal',
    kind: 'count',
    requiredComponents: ['posting', 'summary'],
    summaryDefinitionVersion: 'review-list-filtered-total:v1',
  },
  'review.list.total': {
    key: 'review.list.total',
    kind: 'count',
    requiredComponents: ['summary'],
    summaryDefinitionVersion: 'review-list-total:v1',
  },
  'review.llm.assessedByPrompt': {
    key: 'review.llm.assessedByPrompt',
    kind: 'count',
    requiredComponents: ['llmStatus', 'summary'],
    summaryDefinitionVersion: 'review-llm-assessed-by-prompt:v1',
  },
  'review.llm.unassessedByPrompt': {
    key: 'review.llm.unassessedByPrompt',
    kind: 'count',
    requiredComponents: ['llmStatus', 'queue', 'summary'],
    summaryDefinitionVersion: 'review-llm-unassessed-by-prompt:v1',
  },
  'review.queue.unassessedReady': {
    key: 'review.queue.unassessedReady',
    kind: 'count',
    requiredComponents: ['queue', 'summary'],
    summaryDefinitionVersion: 'review-queue-unassessed-ready:v1',
  },
}
