import type {ReviewServingDiagnostics} from '../../../reviewServing/reviewServingDiagnosticsRepository.ts'

export const getHasReviewServingStateThatCanProgress = (diagnostics: ReviewServingDiagnostics) => {
  return (
    diagnostics.dirtyWork.failedCount
      + diagnostics.dirtyWork.pendingCount
      + diagnostics.dirtyWork.runningCount
      + diagnostics.quarantine.unresolvedOutboxCount
      + diagnostics.rebuildChunks.blockedOverBudgetCount
      + diagnostics.rebuildChunks.failedCount
      + diagnostics.rebuildChunks.pendingCount
      + diagnostics.rebuildChunks.quarantinedCount
      + diagnostics.rebuildChunks.runningCount
      + diagnostics.snapshot.activeCount
    > 0
  )
}
