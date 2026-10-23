import type {ReviewServingDiagnostics} from '../../../reviewServing/reviewServingDiagnosticsRepository.ts'
import {readReviewServingRows} from '../../../reviewServing/reviewServingReader.ts'
import {getActiveDuckdbExclusiveWorkSnapshot} from '../../../utils/duckdbExclusiveWork.ts'
import {getLatestTimestamp} from './getLatestTimestamp.ts'
import {getReviewsIndexingMaintenanceStatus} from './getReviewsIndexingMaintenanceStatus.ts'
import {getReviewsIndexingProgressState} from './getReviewsIndexingProgressState.ts'
import {getReviewsIndexingStatus} from './getReviewsIndexingStatus.ts'
import {getReviewsWarningsCoverage} from './getReviewsWarningsCoverage.ts'

type ReviewsIndexingBlockedReason =
  | 'duckdb_exclusive_work_active'
  | 'operator_intervention_required'
  | 'paused_by_policy'
  | 'quarantine_barrier'
  | 'waiting_for_maintenance_worker'
  | null

const getOldestTimestamp = (...values: Array<string | null>) => {
  const timestampValues = values.filter((value): value is string => {
    return typeof value === 'string' && value !== ''
  })

  return timestampValues.reduce<string | null>((oldestValue, value) => {
    if (oldestValue === null) {
      return value
    }

    return new Date(value).getTime() < new Date(oldestValue).getTime() ? value : oldestValue
  }, null)
}

export const getReviewsWarningsPayloadData = ({
  activeDuckdbExclusiveWork,
  coverage,
  enabledPromptCount,
  hasAnyArticlesInScope,
  hasReadableReviewServingRows,
  hasRecentProgress,
  hasReviewServingRows,
  inFlightRebuildChunkCount,
  isServerMutationWorkDisabled,
  lastProgressedAt,
  pendingCandidateSnapshotActivationCount,
  projectId,
  queuedRebuildChunkCount,
  reviewServingProjectorPaused,
  servingDiagnostics,
  totalQueuedRebuildChunkCount,
  warningSnapshot,
}: {
  activeDuckdbExclusiveWork: ReturnType<typeof getActiveDuckdbExclusiveWorkSnapshot>
  coverage: Awaited<ReturnType<typeof getReviewsWarningsCoverage>>
  enabledPromptCount: number
  hasAnyArticlesInScope: boolean
  hasReadableReviewServingRows: boolean
  hasRecentProgress: boolean
  hasReviewServingRows: boolean
  inFlightRebuildChunkCount: number
  isServerMutationWorkDisabled: boolean
  lastProgressedAt: ReturnType<typeof getLatestTimestamp>
  pendingCandidateSnapshotActivationCount: number
  projectId: string
  queuedRebuildChunkCount: number
  reviewServingProjectorPaused: boolean
  servingDiagnostics: ReviewServingDiagnostics
  totalQueuedRebuildChunkCount: number
  warningSnapshot: Awaited<ReturnType<typeof readReviewServingRows>>
}) => {
  const pendingRebuildChunkCount = totalQueuedRebuildChunkCount + inFlightRebuildChunkCount
  const terminalRebuildChunkCount =
    servingDiagnostics.rebuildChunks.blockedOverBudgetCount
    + servingDiagnostics.rebuildChunks.failedCount
    + servingDiagnostics.rebuildChunks.quarantinedCount
  const terminalDirtyWorkCount = servingDiagnostics.dirtyWork.failedCount
  const terminalQuarantineCount = servingDiagnostics.quarantine.quarantinedOutboxCount
  const terminalSnapshotCount = servingDiagnostics.snapshot.failedCount
  const terminalWorkFailureCount = terminalRebuildChunkCount + terminalDirtyWorkCount + terminalQuarantineCount
  const pendingDirtyWorkCount =
    servingDiagnostics.dirtyWork.pendingCount
    + servingDiagnostics.dirtyWork.runningCount
    + servingDiagnostics.quarantine.retryableOutboxCount
  const queuedRefreshCount = queuedRebuildChunkCount + servingDiagnostics.dirtyWork.pendingCount
  const inFlightRefreshCount = inFlightRebuildChunkCount + servingDiagnostics.dirtyWork.runningCount
  const pendingRefreshCount = pendingRebuildChunkCount + pendingDirtyWorkCount + pendingCandidateSnapshotActivationCount
  const claimableRefreshCount = queuedRebuildChunkCount + servingDiagnostics.dirtyWork.pendingCount
  const eligibleConsumerCount =
    claimableRefreshCount > 0
    && !isServerMutationWorkDisabled
    && !reviewServingProjectorPaused
    && activeDuckdbExclusiveWork === null
      ? 1
      : 0
  const hasBlockedCandidateSnapshot =
    servingDiagnostics.snapshot.invalidCandidateCount > 0 && pendingRebuildChunkCount === 0
  const hasLiveRefreshWork = pendingRefreshCount > 0 || inFlightRefreshCount > 0 || claimableRefreshCount > 0
  const hasHistoricalMaintenanceFailures = terminalWorkFailureCount + terminalSnapshotCount > 0
  const hasActionableMaintenanceFailures =
    terminalWorkFailureCount > 0 && (!hasReviewServingRows || (terminalQuarantineCount > 0 && hasLiveRefreshWork))
  const hasBlockedLiveMaintenanceWork =
    hasLiveRefreshWork
    && (reviewServingProjectorPaused
      || isServerMutationWorkDisabled
      || activeDuckdbExclusiveWork !== null
      || hasBlockedCandidateSnapshot
      || terminalQuarantineCount > 0)
  const maintenanceStatus = getReviewsIndexingMaintenanceStatus({
    hasActionableFailures: hasActionableMaintenanceFailures,
    hasBlockedLiveWork: hasBlockedLiveMaintenanceWork,
    hasLiveRefreshWork,
  })
  const baseIndexingStatus = getReviewsIndexingStatus({
    enabledPromptCount,
    hasActionableFailures: hasActionableMaintenanceFailures,
    hasAnyArticlesInScope,
    hasBlockedCandidateSnapshot,
    hasReviewServingRows,
    isReviewServingProjectorPaused: reviewServingProjectorPaused,
    isServerMutationWorkDisabled,
    pendingRefreshCount,
    runningRefreshCount: inFlightRefreshCount,
  })
  const shouldBlockForDuckdbExclusiveWork =
    activeDuckdbExclusiveWork !== null
    && enabledPromptCount > 0
    && hasAnyArticlesInScope
    && (pendingRefreshCount > 0 || !hasReviewServingRows)
  const indexingStatus = shouldBlockForDuckdbExclusiveWork ? 'blocked' : baseIndexingStatus
  const hasRecentVisibleProgress =
    pendingRefreshCount > 0 && inFlightRefreshCount === 0 && eligibleConsumerCount > 0 && hasRecentProgress
  const progressState = getReviewsIndexingProgressState({
    claimableRefreshCount,
    hasRecentProgress: hasRecentVisibleProgress,
    inFlightRefreshCount,
    status: indexingStatus,
  })
  const blockedReason: ReviewsIndexingBlockedReason = shouldBlockForDuckdbExclusiveWork
    ? 'duckdb_exclusive_work_active'
    : indexingStatus === 'failed' && servingDiagnostics.quarantine.quarantinedOutboxCount > 0
      ? 'quarantine_barrier'
      : indexingStatus === 'blocked' && hasBlockedCandidateSnapshot
        ? 'operator_intervention_required'
        : indexingStatus === 'blocked' && reviewServingProjectorPaused
          ? 'paused_by_policy'
          : indexingStatus === 'blocked' && isServerMutationWorkDisabled
            ? 'waiting_for_maintenance_worker'
            : null
  return {
    data: {
      projectId,
      enabledPromptCount,
      scope: {hasAnyArticlesInScope},
      indexing: {
        activeConsumerCount: inFlightRefreshCount > 0 || hasRecentVisibleProgress ? 1 : 0,
        activeWorkCount: inFlightRefreshCount,
        articleRefreshesPerMinute: null,
        blockedReason,
        cleanup: {inFlightGenerationCleanupCount: 0, lastProgressedAt: null},
        coverage,
        eligibleConsumerCount,
        eligibleConsumerPresent: eligibleConsumerCount > 0,
        inFlightArticleRefreshCount: 0,
        inFlightProjectRefreshCount: inFlightRefreshCount,
        inFlightRefreshCount,
        lastProgressedAt,
        lastProcessedAt: servingDiagnostics.snapshot.activeUpdatedAt,
        lastStartedAt: null,
        maintenance: {
          hasActionableFailures: hasActionableMaintenanceFailures,
          hasHistoricalFailures: hasHistoricalMaintenanceFailures,
          status: maintenanceStatus,
          terminalDirtyWorkCount,
          terminalQuarantineCount,
          terminalRebuildChunkCount,
          terminalSnapshotCount,
        },
        oldestQueuedAt: getOldestTimestamp(
          servingDiagnostics.dirtyWork.oldestQueuedAt,
          servingDiagnostics.rebuildChunks.oldestQueuedAt,
        ),
        pendingArticleRefreshCount: 0,
        pendingProjectRefreshCount: pendingRefreshCount,
        pendingRefreshCount,
        projectRefreshesPerMinute: null,
        queuedArticleRefreshCount: 0,
        queuedProjectRefreshCount: queuedRefreshCount,
        queuedRefreshCount,
        quarantinedArticleRefreshCount: 0,
        quarantinedArticles: [],
        progressState,
        recoveryContext: null,
        recoveryMode: 'none',
        requiredConsumerRole: 'maintenance-worker',
        retryAfterAt: null,
        search: servingDiagnostics.search,
        serving: {
          diagnostics: servingDiagnostics,
          manifest: warningSnapshot.diagnostics.manifest,
          readable: hasReadableReviewServingRows,
          usable: hasReviewServingRows,
        },
        status: indexingStatus,
      },
    },
  }
}
