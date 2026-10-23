import {defaultReadableReviewServingComponents} from '../../../reviewServing/reviewServingContracts.ts'
import {getReviewServingDiagnostics} from '../../../reviewServing/reviewServingDiagnosticsRepository.ts'
import {getActiveOrLastKnownGoodReviewServingSnapshotManifest} from '../../../reviewServing/reviewServingManifestRepository.ts'
import {promoteReviewServingProjectorSnapshot} from '../../../reviewServing/reviewServingProjectorWriter.ts'
import {readReviewServingRows} from '../../../reviewServing/reviewServingReader.ts'
import {capActiveReviewServingRebuildRequestPriorityForProject} from '../../../reviewServing/reviewServingRebuildRequestRepository.ts'
import {requestReviewServingV4Rebuild} from '../../../reviewServing/reviewServingV4RebuildRequestService.ts'
import {getActiveDuckdbExclusiveWorkSnapshot} from '../../../utils/duckdbExclusiveWork.ts'
import {isReviewServingProjectorPaused} from '../../../utils/reviewServingProjectorPause.ts'
import {shouldDisableServerMutationWork} from '../../../utils/serverMutationMode.ts'
import {foregroundReviewServingRepairPriority} from './foregroundReviewServingRepairPriority.ts'
import {getHasActiveEnrichmentMissingSnapshotRepair} from './getHasActiveEnrichmentMissingSnapshotRepair.ts'
import {getHasLegacyRequiredBootstrapEnrichmentCandidate} from './getHasLegacyRequiredBootstrapEnrichmentCandidate.ts'
import {getHasOverprioritizedMissingSnapshotRepair} from './getHasOverprioritizedMissingSnapshotRepair.ts'
import {getHasPendingReviewServingWork} from './getHasPendingReviewServingWork.ts'
import {getHasRecentReviewServingProgress} from './getHasRecentReviewServingProgress.ts'
import {getHasReviewServingStateThatCanProgress} from './getHasReviewServingStateThatCanProgress.ts'
import {getLatestCandidateSnapshotId} from './getLatestCandidateSnapshotId.ts'
import {getLatestTimestamp} from './getLatestTimestamp.ts'
import {getReviewsWarningsCoverage} from './getReviewsWarningsCoverage.ts'
import {getReviewsWarningsPayloadData} from './getReviewsWarningsPayloadData.ts'
import {getReviewWarningsScopeState} from './getReviewWarningsScopeState.ts'
import {getReviewWarningsWorkloadContext} from './getReviewWarningsWorkloadContext.ts'
import {requestReviewsWarningsEnrichments} from './requestReviewsWarningsEnrichments.ts'

const stalledForegroundReviewServingRepairPriority = 10_000

const getNonNegativeDifference = (total: number, claimed: number) => {
  return Math.max(0, total - claimed)
}

const isUsableReviewServingWarningSnapshot = (status: string) => {
  return status === 'active' || status === 'retired'
}

export const getReviewsWarningsPayload = async (input: {
  includeDiagnosticDetails: boolean
  projectId: string
  reviewConfigHash: string | null
}) => {
  const {includeDiagnosticDetails, projectId, reviewConfigHash} = input
  const routeDiagnosticWorkloadContext = getReviewWarningsWorkloadContext(projectId, 'servingDiagnostics')
  const warningSnapshot = await readReviewServingRows({
    allowStale: true,
    contractKey: 'review.warning.snapshot',
    estimatedResultRows: 1,
    includeDiagnosticDetails,
    limit: 1,
    metadataOnly: true,
    projectId,
    routeDiagnosticWorkloadContext,
    reviewConfigHash,
  })
  const {enabledPromptCount, hasAnyArticlesInScope, totalArticleCount} = await getReviewWarningsScopeState(projectId)
  const coverageManifest = await getActiveOrLastKnownGoodReviewServingSnapshotManifest({
    componentStateMode: 'available',
    projectId,
    requiredComponents: defaultReadableReviewServingComponents,
    reviewConfigHash,
    workloadContext: getReviewWarningsWorkloadContext(projectId, 'coverageManifest'),
  })
  const coverage = await getReviewsWarningsCoverage({
    manifest: coverageManifest,
    projectId,
    reviewConfigHash,
    totalArticleCount,
  })
  const servingDiagnostics =
    warningSnapshot.diagnostics.diagnostics
    ?? (await getReviewServingDiagnostics({
      includeDetails: includeDiagnosticDetails,
      projectId,
      reviewConfigHash,
      workloadContext: routeDiagnosticWorkloadContext,
    }))
  const hasReviewServingRows =
    warningSnapshot.status === 'accepted'
    && isUsableReviewServingWarningSnapshot(warningSnapshot.diagnostics.manifest.status)
  const hasEmptyReviewServingRows = hasReviewServingRows && totalArticleCount > 0 && coverage.rowReadyArticleCount === 0
  const hasReadableReviewServingRows = hasReviewServingRows && !hasEmptyReviewServingRows
  const pendingCandidateSnapshotActivationCount = hasReadableReviewServingRows
    ? 0
    : getNonNegativeDifference(
        servingDiagnostics.snapshot.candidateCount,
        servingDiagnostics.snapshot.invalidCandidateCount,
      )
  const shouldPrioritizeMissingSnapshotRepair =
    !hasReadableReviewServingRows && enabledPromptCount > 0 && hasAnyArticlesInScope
  const hasUnreadableActiveWarningSnapshot =
    hasEmptyReviewServingRows
    || (warningSnapshot.status === 'rejected'
      && warningSnapshot.reason === 'missingRequiredComponentState'
      && warningSnapshot.diagnostics.manifest.status === 'active')
  const expiredRebuildChunkLeaseCount = Math.min(
    servingDiagnostics.rebuildChunks.runningCount,
    servingDiagnostics.rebuildChunks.expiredLeaseCount,
  )
  const lastProgressedAt = getLatestTimestamp(
    servingDiagnostics.dirtyWork.updatedAt,
    servingDiagnostics.rebuildChunks.updatedAt,
    servingDiagnostics.snapshot.activeUpdatedAt,
  )
  const isServerMutationWorkDisabled = shouldDisableServerMutationWork()
  const reviewServingProjectorPaused = isReviewServingProjectorPaused()
  const activeDuckdbExclusiveWork = getActiveDuckdbExclusiveWorkSnapshot()
  const queuedRebuildChunkCount = servingDiagnostics.rebuildChunks.claimableCount
  const totalQueuedRebuildChunkCount = servingDiagnostics.rebuildChunks.pendingCount + expiredRebuildChunkLeaseCount
  const inFlightRebuildChunkCount = getNonNegativeDifference(
    servingDiagnostics.rebuildChunks.runningCount,
    expiredRebuildChunkLeaseCount,
  )

  const hasRecentProgress = getHasRecentReviewServingProgress(lastProgressedAt)
  const hasReviewServingStateThatCanProgress = getHasReviewServingStateThatCanProgress(servingDiagnostics)
  const hasPendingReviewServingWork = getHasPendingReviewServingWork(servingDiagnostics)
  const hasCurrentConfigSnapshot =
    servingDiagnostics.snapshot.activeCount > 0 || servingDiagnostics.snapshot.candidateCount > 0
  const shouldSeedCurrentConfigMissingSnapshot = shouldPrioritizeMissingSnapshotRepair && !hasCurrentConfigSnapshot
  const shouldAttemptCandidatePromotion =
    !isServerMutationWorkDisabled
    && !reviewServingProjectorPaused
    && shouldPrioritizeMissingSnapshotRepair
    && servingDiagnostics.snapshot.candidateCount > 0
  if (shouldAttemptCandidatePromotion) {
    const candidateSnapshotId = await getLatestCandidateSnapshotId({projectId, reviewConfigHash})
    if (candidateSnapshotId !== null) {
      await promoteReviewServingProjectorSnapshot({projectId, reviewConfigHash, snapshotId: candidateSnapshotId}).catch(
        () => {
          return undefined
        },
      )
    }
  }
  const hasLegacyRequiredBootstrapEnrichmentCandidate = shouldPrioritizeMissingSnapshotRepair
    ? await getHasLegacyRequiredBootstrapEnrichmentCandidate({projectId, reviewConfigHash})
    : false
  const hasActiveEnrichmentMissingSnapshotRepair = shouldPrioritizeMissingSnapshotRepair
    ? await getHasActiveEnrichmentMissingSnapshotRepair({projectId, reviewConfigHash})
    : false
  const hasStalePendingCandidateActivationWork =
    pendingCandidateSnapshotActivationCount > 0
    && !hasRecentProgress
    && servingDiagnostics.rebuildChunks.claimableCount > 0
  const shouldRequestForegroundRepair =
    !isServerMutationWorkDisabled
    && !reviewServingProjectorPaused
    && shouldPrioritizeMissingSnapshotRepair
    && (pendingCandidateSnapshotActivationCount === 0
      || hasStalePendingCandidateActivationWork
      || hasActiveEnrichmentMissingSnapshotRepair
      || hasLegacyRequiredBootstrapEnrichmentCandidate
      || shouldSeedCurrentConfigMissingSnapshot
      || hasUnreadableActiveWarningSnapshot)
    && (!hasRecentProgress
      || hasActiveEnrichmentMissingSnapshotRepair
      || hasLegacyRequiredBootstrapEnrichmentCandidate
      || shouldSeedCurrentConfigMissingSnapshot
      || hasUnreadableActiveWarningSnapshot)
    && (!hasReviewServingStateThatCanProgress || hasPendingReviewServingWork || hasUnreadableActiveWarningSnapshot)

  if (shouldRequestForegroundRepair) {
    const priority = hasRecentProgress
      ? foregroundReviewServingRepairPriority
      : stalledForegroundReviewServingRepairPriority
    await requestReviewServingV4Rebuild({
      pageFirstOnly: true,
      priority,
      projectId,
      reason: 'missingReviewServingSnapshot',
    }).catch(() => {
      return undefined
    })
  }

  const hasOverprioritizedMissingSnapshotRepair =
    !isServerMutationWorkDisabled && !reviewServingProjectorPaused && hasReadableReviewServingRows
      ? await getHasOverprioritizedMissingSnapshotRepair(projectId)
      : false

  if (hasOverprioritizedMissingSnapshotRepair) {
    await capActiveReviewServingRebuildRequestPriorityForProject({
      priority: foregroundReviewServingRepairPriority,
      projectId,
      reason: 'missingReviewServingSnapshot',
    }).catch(() => {
      return undefined
    })
  }

  await requestReviewsWarningsEnrichments({
    coverage,
    hasReadableReviewServingRows,
    isServerMutationWorkDisabled,
    projectId,
    reviewServingProjectorPaused,
  })

  return getReviewsWarningsPayloadData({
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
  })
}
