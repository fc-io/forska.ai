import type {DuckdbWorkloadContext, DuckdbWorkloadFallbackIntent} from '../utils/duckdbService.ts'
import type {
  NamedReviewFastCountKey,
  ReviewServingBulkState,
  ReviewServingCountState,
  ReviewServingFreshnessBehavior,
  ReviewServingFreshnessState,
  ReviewServingReadContract,
  ReviewServingRouteBudgetKey,
  ReviewServingSearchMode,
  ReviewServingSearchState,
  ReviewServingWorkloadClass,
} from './reviewServingContracts.ts'
import {isNamedReviewFastCountKey} from './reviewServingContracts.ts'
import {getReviewServingReadContract} from './reviewServingReadContracts.ts'

export type ReviewServingAdmissionSearchMode = ReviewServingSearchMode | 'substringSync'

export type ReviewServingAdmissionRequest = {
  allowStale?: boolean
  contractKey: string
  countState?: ReviewServingCountState | null
  estimatedResultBytes?: number
  estimatedResultRows?: number
  jobState?: ReviewServingBulkState | null
  namedCountKey?: string
  pageSize?: number
  projectId?: string
  requiresTempSpill?: boolean
  searchState?: ReviewServingSearchState | null
  searchMode?: ReviewServingAdmissionSearchMode
  snapshotFreshness?: ReviewServingFreshnessState
  workloadClass: string
}

export type ReviewServingAdmissionDecision = 'accepted' | 'rejected'

export type ReviewServingAdmissionRejectionReason =
  | 'estimatedResultBytesOverLimit'
  | 'estimatedResultRowsOverLimit'
  | 'invalidBudgetValue'
  | 'pageSizeOverLimit'
  | 'searchModeMismatch'
  | 'staleSnapshotRequired'
  | 'synchronousSubstringSearchUnavailable'
  | 'tempSpillNotAllowed'
  | 'unregisteredContract'
  | 'unsupportedCountShape'
  | 'workloadClassMismatch'

export type ReviewServingAdmissionNumericBudgetDecision = {
  accepted: boolean
  budgetKey: Extract<ReviewServingRouteBudgetKey, 'maxEstimatedResultBytes' | 'maxPageSize' | 'maxResultRows'>
  limit: number | null
  rejectionReason: ReviewServingAdmissionRejectionReason | null
  requested: number | null
}

export type ReviewServingAdmissionTempSpillBudgetDecision = {
  accepted: boolean
  budgetKey: Extract<ReviewServingRouteBudgetKey, 'allowsTempSpill'>
  limit: boolean | null
  rejectionReason: ReviewServingAdmissionRejectionReason | null
  requested: boolean
}

export type ReviewServingAdmissionRouteBudgetDiagnostics = {
  estimatedResultBytes: ReviewServingAdmissionNumericBudgetDecision
  pageSize: ReviewServingAdmissionNumericBudgetDecision
  resultRows: ReviewServingAdmissionNumericBudgetDecision
  tempSpill: ReviewServingAdmissionTempSpillBudgetDecision
}

export type ReviewServingAdmissionFreshnessDiagnostics = {
  allowStale: boolean
  behavior: ReviewServingFreshnessBehavior | null
  accepted: boolean
  snapshotFreshness: ReviewServingFreshnessState | null
}

export type ReviewServingAdmissionCountDiagnostics = {
  requestedKey: string | null
  state: ReviewServingCountState | null
  supported: boolean
}

export type ReviewServingAdmissionSearchDiagnostics = {
  registeredMode: ReviewServingSearchMode | null
  requestedMode: ReviewServingAdmissionSearchMode | null
  state: ReviewServingSearchState | null
  synchronousSubstringRejected: boolean
}

export type ReviewServingAdmissionJobDiagnostics = {state: ReviewServingBulkState | null}

export type ReviewServingAdmissionWorkloadClassDiagnostics = {
  matches: boolean
  registered: ReviewServingWorkloadClass | null
  requested: string
}

export type ReviewServingAdmissionDiagnostics = {
  contractKey: string
  count: ReviewServingAdmissionCountDiagnostics
  decision: ReviewServingAdmissionDecision
  freshness: ReviewServingAdmissionFreshnessDiagnostics
  job: ReviewServingAdmissionJobDiagnostics
  rejectionReason: ReviewServingAdmissionRejectionReason | null
  routeBudget: ReviewServingAdmissionRouteBudgetDiagnostics
  search: ReviewServingAdmissionSearchDiagnostics
  workloadClass: ReviewServingAdmissionWorkloadClassDiagnostics
}

export type ReviewServingAdmissionResult =
  | {
      admitted: true
      contract: ReviewServingReadContract
      diagnostics: ReviewServingAdmissionDiagnostics
      status: 'accepted'
    }
  | {
      admitted: false
      contract: ReviewServingReadContract | null
      diagnostics: ReviewServingAdmissionDiagnostics
      reason: ReviewServingAdmissionRejectionReason
      status: 'rejected'
    }

export type ReviewServingDuckdbWorkloadAdmissionResult =
  | {
      admitted: true
      contract: ReviewServingReadContract
      diagnostics: ReviewServingAdmissionDiagnostics
      status: 'accepted'
      workloadContext: DuckdbWorkloadContext
    }
  | {
      admitted: false
      contract: ReviewServingReadContract | null
      diagnostics: ReviewServingAdmissionDiagnostics
      reason: ReviewServingAdmissionRejectionReason
      status: 'rejected'
    }

const hasNamedCount = (contract: ReviewServingReadContract, namedCountKey: NamedReviewFastCountKey) => {
  return contract.namedFastCounts.includes(namedCountKey)
}

const isSupportedNamedCount = (contract: ReviewServingReadContract, namedCountKey: string | undefined): boolean => {
  if (namedCountKey === undefined) {
    return true
  }

  return isNamedReviewFastCountKey(namedCountKey) && hasNamedCount(contract, namedCountKey)
}

const isFreshnessAccepted = (
  contract: ReviewServingReadContract | null,
  request: ReviewServingAdmissionRequest,
): boolean => {
  if (!contract) {
    return false
  }

  return contract.freshnessBehavior === 'requireReadySnapshot' && request.snapshotFreshness !== 'ready'
    ? request.allowStale === true
    : true
}

const getNonStaleDuckdbFallbackIntent = (request: ReviewServingAdmissionRequest): DuckdbWorkloadFallbackIntent => {
  return request.searchMode === 'substringAsync' ? 'async' : 'reject'
}

const getDuckdbFallbackIntent = (request: ReviewServingAdmissionRequest): DuckdbWorkloadFallbackIntent => {
  return request.allowStale ? 'serveStale' : getNonStaleDuckdbFallbackIntent(request)
}

const getDuckdbWorkloadContext = (
  contract: ReviewServingReadContract,
  request: ReviewServingAdmissionRequest,
): DuckdbWorkloadContext => {
  return {
    allowsTempSpill: contract.allowsTempSpill,
    fallbackIntent: getDuckdbFallbackIntent(request),
    maxResultBytes: contract.maxEstimatedResultBytes,
    maxResultRows: contract.maxResultRows,
    projectId: request.projectId,
    routeOrJobKey: contract.key,
    workloadClass: contract.workloadClass,
  }
}

const getNumericBudgetDecision = ({
  budgetKey,
  limit,
  minimum,
  rejectionReason,
  requested,
}: {
  budgetKey: ReviewServingAdmissionNumericBudgetDecision['budgetKey']
  limit: number | null
  minimum: number
  rejectionReason: ReviewServingAdmissionRejectionReason
  requested: number | undefined
}): ReviewServingAdmissionNumericBudgetDecision => {
  const normalizedRequested = requested ?? null
  const invalidValue =
    normalizedRequested !== null && (!Number.isFinite(normalizedRequested) || normalizedRequested < minimum)
  const accepted = limit !== null && !invalidValue && (normalizedRequested ?? 0) <= limit

  return {
    accepted,
    budgetKey,
    limit,
    rejectionReason: !accepted && limit !== null ? (invalidValue ? 'invalidBudgetValue' : rejectionReason) : null,
    requested: normalizedRequested,
  }
}

const hasInvalidNumericBudgetInput = (requested: number | undefined, minimum: number) => {
  return requested !== undefined && (!Number.isFinite(requested) || requested < minimum)
}

const getTempSpillBudgetDecision = (
  contract: ReviewServingReadContract | null,
  request: ReviewServingAdmissionRequest,
): ReviewServingAdmissionTempSpillBudgetDecision => {
  const requested = request.requiresTempSpill ?? false
  const limit = contract?.allowsTempSpill ?? null
  const accepted = limit !== null && (!requested || limit)

  return {
    accepted,
    budgetKey: 'allowsTempSpill',
    limit,
    rejectionReason: !accepted && limit !== null ? 'tempSpillNotAllowed' : null,
    requested,
  }
}

const getRouteBudgetDiagnostics = (
  contract: ReviewServingReadContract | null,
  request: ReviewServingAdmissionRequest,
): ReviewServingAdmissionRouteBudgetDiagnostics => {
  return {
    estimatedResultBytes: getNumericBudgetDecision({
      budgetKey: 'maxEstimatedResultBytes',
      limit: contract?.maxEstimatedResultBytes ?? null,
      minimum: 0,
      rejectionReason: 'estimatedResultBytesOverLimit',
      requested: request.estimatedResultBytes,
    }),
    pageSize: getNumericBudgetDecision({
      budgetKey: 'maxPageSize',
      limit: contract?.maxPageSize ?? null,
      minimum: 1,
      rejectionReason: 'pageSizeOverLimit',
      requested: request.pageSize,
    }),
    resultRows: getNumericBudgetDecision({
      budgetKey: 'maxResultRows',
      limit: contract?.maxResultRows ?? null,
      minimum: 0,
      rejectionReason: 'estimatedResultRowsOverLimit',
      requested: request.estimatedResultRows,
    }),
    tempSpill: getTempSpillBudgetDecision(contract, request),
  }
}

const getCountDiagnostics = (
  contract: ReviewServingReadContract | null,
  request: ReviewServingAdmissionRequest,
): ReviewServingAdmissionCountDiagnostics => {
  return {
    requestedKey: request.namedCountKey ?? null,
    state: request.countState ?? null,
    supported: contract ? isSupportedNamedCount(contract, request.namedCountKey) : false,
  }
}

const getFreshnessDiagnostics = (
  contract: ReviewServingReadContract | null,
  request: ReviewServingAdmissionRequest,
): ReviewServingAdmissionFreshnessDiagnostics => {
  return {
    accepted: isFreshnessAccepted(contract, request),
    allowStale: request.allowStale === true,
    behavior: contract?.freshnessBehavior ?? null,
    snapshotFreshness: request.snapshotFreshness ?? null,
  }
}

const getSearchDiagnostics = (
  contract: ReviewServingReadContract | null,
  request: ReviewServingAdmissionRequest,
): ReviewServingAdmissionSearchDiagnostics => {
  return {
    registeredMode: contract?.searchMode ?? null,
    requestedMode: request.searchMode ?? null,
    state: request.searchState ?? null,
    synchronousSubstringRejected: request.searchMode === 'substringSync',
  }
}

const isSearchModeAccepted = (contract: ReviewServingReadContract, request: ReviewServingAdmissionRequest) => {
  const requestedMode = request.searchMode ?? 'none'

  return requestedMode === 'none' || requestedMode === contract.searchMode
}

const getWorkloadClassDiagnostics = (
  contract: ReviewServingReadContract | null,
  request: ReviewServingAdmissionRequest,
): ReviewServingAdmissionWorkloadClassDiagnostics => {
  return {
    matches: contract?.workloadClass === request.workloadClass,
    registered: contract?.workloadClass ?? null,
    requested: request.workloadClass,
  }
}

const getAdmissionRejectionReason = (
  contract: ReviewServingReadContract | null,
  request: ReviewServingAdmissionRequest,
): ReviewServingAdmissionRejectionReason | null => {
  if (!contract) {
    return 'unregisteredContract'
  }

  if (contract.workloadClass !== request.workloadClass) {
    return 'workloadClassMismatch'
  }

  if (
    hasInvalidNumericBudgetInput(request.pageSize, 1)
    || hasInvalidNumericBudgetInput(request.estimatedResultRows, 0)
    || hasInvalidNumericBudgetInput(request.estimatedResultBytes, 0)
  ) {
    return 'invalidBudgetValue'
  }

  if ((request.pageSize ?? 0) > contract.maxPageSize) {
    return 'pageSizeOverLimit'
  }

  if ((request.estimatedResultRows ?? 0) > contract.maxResultRows) {
    return 'estimatedResultRowsOverLimit'
  }

  if ((request.estimatedResultBytes ?? 0) > contract.maxEstimatedResultBytes) {
    return 'estimatedResultBytesOverLimit'
  }

  if ((request.requiresTempSpill ?? false) && !contract.allowsTempSpill) {
    return 'tempSpillNotAllowed'
  }

  if (request.searchMode === 'substringSync') {
    return 'synchronousSubstringSearchUnavailable'
  }

  if (!isSearchModeAccepted(contract, request)) {
    return 'searchModeMismatch'
  }

  if (!isSupportedNamedCount(contract, request.namedCountKey)) {
    return 'unsupportedCountShape'
  }

  if (!isFreshnessAccepted(contract, request)) {
    return 'staleSnapshotRequired'
  }

  return null
}

const getAdmissionDiagnostics = (
  contract: ReviewServingReadContract | null,
  request: ReviewServingAdmissionRequest,
  rejectionReason: ReviewServingAdmissionRejectionReason | null,
): ReviewServingAdmissionDiagnostics => {
  return {
    contractKey: request.contractKey,
    count: getCountDiagnostics(contract, request),
    decision: rejectionReason ? 'rejected' : 'accepted',
    freshness: getFreshnessDiagnostics(contract, request),
    job: {state: request.jobState ?? null},
    rejectionReason,
    routeBudget: getRouteBudgetDiagnostics(contract, request),
    search: getSearchDiagnostics(contract, request),
    workloadClass: getWorkloadClassDiagnostics(contract, request),
  }
}

const evaluateReviewServingAdmission = (request: ReviewServingAdmissionRequest) => {
  const contract = getReviewServingReadContract(request.contractKey)
  const rejectionReason = getAdmissionRejectionReason(contract, request)
  const diagnostics = getAdmissionDiagnostics(contract, request, rejectionReason)

  return {contract, diagnostics, rejectionReason}
}

export const getReviewServingAdmissionDiagnostics = (
  request: ReviewServingAdmissionRequest,
): ReviewServingAdmissionDiagnostics => {
  return evaluateReviewServingAdmission(request).diagnostics
}

export const admitReviewServingRequest = (request: ReviewServingAdmissionRequest): ReviewServingAdmissionResult => {
  const {contract, diagnostics, rejectionReason} = evaluateReviewServingAdmission(request)

  if (rejectionReason) {
    return {admitted: false, contract, diagnostics, reason: rejectionReason, status: 'rejected'}
  }

  return {admitted: true, contract: contract as ReviewServingReadContract, diagnostics, status: 'accepted'}
}

export const admitReviewServingDuckdbWorkload = (
  request: ReviewServingAdmissionRequest,
): ReviewServingDuckdbWorkloadAdmissionResult => {
  const admission = admitReviewServingRequest(request)

  return admission.admitted
    ? {
        admitted: true,
        contract: admission.contract,
        diagnostics: admission.diagnostics,
        status: admission.status,
        workloadContext: getDuckdbWorkloadContext(admission.contract, request),
      }
    : admission
}
