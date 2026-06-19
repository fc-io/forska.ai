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

export const reviewServingFreshnessStates = ['ready', 'indexing', 'stale', 'unavailable'] as const

export type ReviewServingFreshnessState = (typeof reviewServingFreshnessStates)[number]

export const reviewServingCountAvailabilityStates = ['ready', 'stale', 'unavailable', 'async'] as const

export type ReviewServingCountAvailability = (typeof reviewServingCountAvailabilityStates)[number]

export const reviewServingSearchAvailabilityStates = ['ready', 'indexing', 'unavailable', 'async'] as const

export type ReviewServingSearchAvailability = (typeof reviewServingSearchAvailabilityStates)[number]

export const reviewServingBulkJobStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const

export type ReviewServingBulkJobStatus = (typeof reviewServingBulkJobStatuses)[number]

export const reviewServingSnapshotStatuses = ['candidate', 'active', 'failed', 'retired'] as const

export type ReviewServingSnapshotStatus = (typeof reviewServingSnapshotStatuses)[number]

export const reviewServingComponentRequirements = ['required', 'optional'] as const

export type ReviewServingComponentRequirement = (typeof reviewServingComponentRequirements)[number]

export const reviewServingFilterKeys = [
  'articleCreatedAtFrom',
  'articleCreatedAtTo',
  'articleId',
  'duplicateFlag',
  'conflictFlag',
  'humanStatus',
  'importRoute',
  'llmHasJudgment',
  'llmStatus',
  'promptAnswer',
  'promptId',
  'publicationYear',
  'queueKind',
  'searchTokenPrefix',
  'sourceProject',
] as const

export type ReviewServingFilterKey = (typeof reviewServingFilterKeys)[number]

export const reviewServingPhysicalAccessStrategies = [
  'articleSetLookup',
  'jobCriteria',
  'keyedLookup',
  'orderedPrefix',
  'postingIntersection',
  'queueOrdering',
  'summaryLookup',
  'tokenPrefixIndex',
] as const

export type ReviewServingPhysicalAccessStrategy = (typeof reviewServingPhysicalAccessStrategies)[number]

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
  'review.human.filter.promptAnswer',
  'review.human.filter.summaryAnswer',
] as const

export type NamedReviewFastCountKey = (typeof namedReviewFastCountKeys)[number]

export const reviewServingReadContractKeys = [
  'review.llm.rows',
  'review.llm.rowsByArticleSet',
  'review.llm.count',
  'review.human.rows',
  'review.human.rowsByArticleSet',
  'review.human.count',
  'review.both.rows',
  'review.both.rowsByArticleSet',
  'review.both.count',
  'review.unassessed.rows',
  'review.unassessed.rowsByArticleSet',
  'review.unassessed.count',
  'review.filters.postings',
  'review.filters.facets',
  'review.filters.options',
  'review.human.filters.facets',
  'review.human.filters.options',
  'review.prompt.badges',
  'review.queue.unassessed',
  'review.detail.row',
  'review.detail.payload',
  'review.detail.judgments',
  'review.detail.humanJudgments',
  'review.llm.list.judgments',
  'review.human.list.judgments',
  'review.both.list.judgments',
  'review.both.list.humanJudgments',
  'review.health.snapshot',
  'review.warning.snapshot',
  'review.prompt.preview',
  'review.bulk.selection',
  'review.bulk.substringSelection',
  'review.export.selection',
  'review.pdf.selection',
  'review.search.tokenPrefix',
  'review.search.substringAsync',
] as const

export type ReviewServingReadContractKey = (typeof reviewServingReadContractKeys)[number]

export const reviewServingRouteBudgetKeys = [
  'allowsTempSpill',
  'maxEstimatedResultBytes',
  'maxPageSize',
  'maxResultRows',
  'timeoutMs',
] as const

export type ReviewServingRouteBudgetKey = (typeof reviewServingRouteBudgetKeys)[number]

export type ReviewServingSnapshotId = string

export type ReviewServingSnapshotPinId = string

export type ReviewServingSelectedImportSnapshotId = string

export type ReviewServingSnapshotIdentifier = {
  projectId: string
  reviewConfigHash: string | null
  snapshotId: ReviewServingSnapshotId
}

export type ReviewServingSnapshotPinIdentifier = ReviewServingSnapshotIdentifier & {pinId: ReviewServingSnapshotPinId}

export type ReviewServingRouteBudget = {
  allowsTempSpill: boolean
  maxEstimatedResultBytes: number
  maxPageSize: number
  maxResultRows: number
  timeoutMs: number
}

export type ReviewServingPhysicalFilterAccess = {
  allowedFilters: readonly ReviewServingFilterKey[]
  physicalAccessStrategy: ReviewServingPhysicalAccessStrategy
}

export type ReviewServingComponentState = {
  baseGeneration: string
  component: ReviewServingProjectionComponent
  patchWatermark: string
  projectionIdentity: string
}

export type ReviewServingRequiredComponentState = ReviewServingComponentState & {requirement: 'required'}

export type ReviewServingOptionalComponentState = ReviewServingComponentState & {requirement: 'optional'}

export type ReviewServingSnapshotComponentStates = {
  optional: readonly ReviewServingOptionalComponentState[]
  required: readonly ReviewServingRequiredComponentState[]
}

export type ReviewServingComponentRequirements = {
  optionalComponents: readonly ReviewServingProjectionComponent[]
  requiredComponents: readonly ReviewServingProjectionComponent[]
}

export type ReviewServingSnapshotState = ReviewServingSnapshotIdentifier & {
  componentStates: ReviewServingSnapshotComponentStates
  freshness: ReviewServingFreshnessState
  lastKnownGoodSnapshotId: ReviewServingSnapshotId | null
  selectedImportSnapshotId: ReviewServingSelectedImportSnapshotId | null
  status: ReviewServingSnapshotStatus
}

export type ReviewServingFreshnessBehavior = 'allowStaleSnapshot' | 'asyncUnavailable' | 'requireReadySnapshot'

export type ReviewServingSearchMode = 'none' | 'substringAsync' | 'tokenPrefix'

export type ReviewServingSortDirection = 'asc' | 'desc'

export type ReviewServingNamedSummaryDefinition = {
  key: NamedReviewFastCountKey
  kind: 'count' | 'facet'
  requiredComponents: readonly ReviewServingProjectionComponent[]
  summaryDefinitionVersion: string
}

export type ReviewServingReadContract = ReviewServingRouteBudget
  & ReviewServingPhysicalFilterAccess
  & ReviewServingComponentRequirements & {
    key: ReviewServingReadContractKey
    cursorFields: readonly string[]
    freshnessBehavior: ReviewServingFreshnessBehavior
    listMode: ReviewServingListMode | null
    namedFastCounts: readonly NamedReviewFastCountKey[]
    searchMode: ReviewServingSearchMode
    servingTable: string
    sort: {direction: ReviewServingSortDirection; fields: readonly string[]}
    workloadClass: ReviewServingWorkloadClass
  }

export type ReviewServingCountState =
  | {availability: 'async'; filterKey: string; jobId: string | null; key: NamedReviewFastCountKey; reason: string}
  | {
      availability: 'ready'
      filterKey: string
      key: NamedReviewFastCountKey
      snapshotId: ReviewServingSnapshotId
      value: number
    }
  | {
      availability: 'stale'
      filterKey: string
      key: NamedReviewFastCountKey
      snapshotId: ReviewServingSnapshotId
      value: number
    }
  | {availability: 'unavailable'; filterKey: string; key: NamedReviewFastCountKey; reason: string}

export type ReviewServingSearchState =
  | {availability: 'async'; jobId: string | null; reason: string}
  | {availability: 'indexing'; reason: string}
  | {availability: 'ready'; snapshotId: ReviewServingSnapshotId}
  | {availability: 'unavailable'; reason: string}

export type ReviewServingBulkState =
  | {
      jobId: string
      processedCount: number
      snapshotId: ReviewServingSnapshotId | null
      status: 'pending' | 'running'
      totalEstimate: number | null
    }
  | {
      jobId: string
      processedCount: number
      resultManifestId: string | null
      snapshotId: ReviewServingSnapshotId | null
      status: 'completed'
      totalEstimate: number | null
    }
  | {
      jobId: string
      lastError: string
      processedCount: number
      snapshotId: ReviewServingSnapshotId | null
      status: 'failed'
      totalEstimate: number | null
    }
  | {
      jobId: string
      lastError: string | null
      processedCount: number
      snapshotId: ReviewServingSnapshotId | null
      status: 'cancelled'
      totalEstimate: number | null
    }

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

export const isReviewServingFreshnessState = (value: string): value is ReviewServingFreshnessState => {
  return isOneOf(reviewServingFreshnessStates, value)
}

export const isReviewServingCountAvailability = (value: string): value is ReviewServingCountAvailability => {
  return isOneOf(reviewServingCountAvailabilityStates, value)
}

export const isReviewServingSearchAvailability = (value: string): value is ReviewServingSearchAvailability => {
  return isOneOf(reviewServingSearchAvailabilityStates, value)
}

export const isReviewServingSnapshotStatus = (value: string): value is ReviewServingSnapshotStatus => {
  return isOneOf(reviewServingSnapshotStatuses, value)
}

export const isReviewServingComponentRequirement = (value: string): value is ReviewServingComponentRequirement => {
  return isOneOf(reviewServingComponentRequirements, value)
}

export const isNamedReviewFastCountKey = (value: string): value is NamedReviewFastCountKey => {
  return isOneOf(namedReviewFastCountKeys, value)
}

export const isReviewServingWorkloadClass = (value: string): value is ReviewServingWorkloadClass => {
  return isOneOf(reviewServingWorkloadClasses, value)
}

export const isReviewServingPhysicalAccessStrategy = (value: string): value is ReviewServingPhysicalAccessStrategy => {
  return isOneOf(reviewServingPhysicalAccessStrategies, value)
}

export const isReviewServingBulkJobStatus = (value: string): value is ReviewServingBulkJobStatus => {
  return isOneOf(reviewServingBulkJobStatuses, value)
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
  'review.human.filter.promptAnswer': {
    key: 'review.human.filter.promptAnswer',
    kind: 'facet',
    requiredComponents: ['humanStatus', 'summary'],
    summaryDefinitionVersion: 'review-human-filter-prompt-answer:v1',
  },
  'review.human.filter.summaryAnswer': {
    key: 'review.human.filter.summaryAnswer',
    kind: 'facet',
    requiredComponents: ['humanStatus', 'summary'],
    summaryDefinitionVersion: 'review-human-filter-summary-answer:v1',
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
