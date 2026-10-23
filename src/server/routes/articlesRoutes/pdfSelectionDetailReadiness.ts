import {isActiveReviewServingSnapshotDetailReady} from '../../reviewServing/reviewBulkOperationService.ts'

export const getPdfDetailPendingResponse = () => {
  return {
    availability: 'pending',
    detailReadiness: 'indexing',
    error: 'PDF selection details are still indexing',
    success: false,
  }
}

export const isPdfSelectionDetailReady = async (input: {projectId: string; reviewConfigHash: string | null}) => {
  return isActiveReviewServingSnapshotDetailReady(input)
}
