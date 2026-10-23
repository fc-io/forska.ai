import type {ReviewServingDiagnostics} from '../../../reviewServing/reviewServingDiagnosticsRepository.ts'

export const getHasPendingReviewServingWork = (diagnostics: ReviewServingDiagnostics) => {
  return (
    diagnostics.dirtyWork.pendingCount
      + diagnostics.dirtyWork.runningCount
      + diagnostics.rebuildChunks.pendingCount
      + diagnostics.rebuildChunks.runningCount
    > 0
  )
}
