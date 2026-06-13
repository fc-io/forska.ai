import type {
  NamedReviewFastCountKey,
  ReviewServingFreshnessState,
  ReviewServingReadContract,
  ReviewServingSearchMode,
} from './reviewServingContracts.ts'
import {isNamedReviewFastCountKey} from './reviewServingContracts.ts'
import {getReviewServingReadContract} from './reviewServingReadContracts.ts'

export type ReviewServingAdmissionSearchMode = ReviewServingSearchMode | 'substringSync'

export type ReviewServingAdmissionRequest = {
  allowStale?: boolean
  contractKey: string
  estimatedResultBytes?: number
  namedCountKey?: string
  pageSize?: number
  requiresTempSpill?: boolean
  searchMode?: ReviewServingAdmissionSearchMode
  snapshotFreshness?: ReviewServingFreshnessState
  workloadClass: string
}

export type ReviewServingAdmissionRejectionReason =
  | 'estimatedResultBytesOverLimit'
  | 'pageSizeOverLimit'
  | 'staleSnapshotRequired'
  | 'synchronousSubstringSearchUnavailable'
  | 'tempSpillNotAllowed'
  | 'unregisteredContract'
  | 'unsupportedCountShape'
  | 'workloadClassMismatch'

export type ReviewServingAdmissionResult =
  | {admitted: true; contract: ReviewServingReadContract}
  | {admitted: false; contract: ReviewServingReadContract | null; reason: ReviewServingAdmissionRejectionReason}

const hasNamedCount = (contract: ReviewServingReadContract, namedCountKey: NamedReviewFastCountKey) => {
  return contract.namedFastCounts.includes(namedCountKey)
}

const getUnsupportedCountResult = (
  contract: ReviewServingReadContract,
  namedCountKey: string | undefined,
): ReviewServingAdmissionResult | null => {
  if (namedCountKey === undefined) {
    return null
  }

  return isNamedReviewFastCountKey(namedCountKey) && hasNamedCount(contract, namedCountKey)
    ? null
    : {admitted: false, contract, reason: 'unsupportedCountShape'}
}

export const admitReviewServingRequest = (request: ReviewServingAdmissionRequest): ReviewServingAdmissionResult => {
  const contract = getReviewServingReadContract(request.contractKey)

  if (!contract) {
    return {admitted: false, contract: null, reason: 'unregisteredContract'}
  }

  const unsupportedCountResult = getUnsupportedCountResult(contract, request.namedCountKey)

  if (contract.workloadClass !== request.workloadClass) {
    return {admitted: false, contract, reason: 'workloadClassMismatch'}
  }

  if ((request.pageSize ?? 0) > contract.maxPageSize) {
    return {admitted: false, contract, reason: 'pageSizeOverLimit'}
  }

  if ((request.estimatedResultBytes ?? 0) > contract.maxEstimatedResultBytes) {
    return {admitted: false, contract, reason: 'estimatedResultBytesOverLimit'}
  }

  if ((request.requiresTempSpill ?? false) && !contract.allowsTempSpill) {
    return {admitted: false, contract, reason: 'tempSpillNotAllowed'}
  }

  if (request.searchMode === 'substringSync') {
    return {admitted: false, contract, reason: 'synchronousSubstringSearchUnavailable'}
  }

  if (unsupportedCountResult) {
    return unsupportedCountResult
  }

  if (
    contract.freshnessBehavior === 'requireReadySnapshot'
    && request.snapshotFreshness !== 'ready'
    && !request.allowStale
  ) {
    return {admitted: false, contract, reason: 'staleSnapshotRequired'}
  }

  return {admitted: true, contract}
}
