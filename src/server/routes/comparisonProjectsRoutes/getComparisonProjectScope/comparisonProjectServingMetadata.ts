import type {ComparisonProjectServingStatus} from '../../../../db/schemaTypes.ts'
import type {
  ComparisonProjectServingProgress,
  ComparisonProjectServingStatusRow,
} from '../../../services/comparisonProjectServingRebuildService.ts'
import {getEmptyComparisonProjectServingProgress} from '../getEmptyComparisonProjectServingProgress.ts'

const getComparisonProjectServingUpdatedAt = (status: ComparisonProjectServingStatusRow) => {
  return (
    status.generationUpdatedAt ?? status.servingCompletedAt ?? status.servingFailedAt ?? status.servingStartedAt ?? null
  )
}

export const getArchivedComparisonProjectServingMetadata = () => {
  return {
    activeGeneration: null,
    judgmentContextId: null,
    isServingReady: false,
    servingProgress: getEmptyComparisonProjectServingProgress(),
    servingStatus: 'missing' as const,
    servingUpdatedAt: null,
  }
}

const getComparisonProjectServingMetadataStatus = (
  status: ComparisonProjectServingStatusRow,
): ComparisonProjectServingStatus => {
  return status.servingStatus === 'ready' && status.activeGeneration === null
    ? 'stale'
    : status.servingStatus === 'missing'
      ? 'refreshing'
      : status.servingStatus
}

const getComparisonProjectServingProgress = (
  status: ComparisonProjectServingStatusRow,
): ComparisonProjectServingProgress => {
  return {
    completedAt: status.servingCompletedAt,
    failedAt: status.servingFailedAt,
    generation: status.servingGeneration,
    lastError: status.servingError,
    lastProgressedAt: status.servingLastProgressedAt ?? null,
    phase: status.servingPhase ?? null,
    phaseStartedAt: status.servingPhaseStartedAt ?? null,
    stagedArticleCount: status.servingStagedArticleCount ?? 0,
    stagedCellCount: status.servingStagedCellCount ?? 0,
    stagedFilterMemberCount: status.servingStagedFilterMemberCount ?? 0,
    stagedFilterStatsCount: status.servingStagedFilterStatsCount ?? 0,
    startedAt: status.servingStartedAt,
    totalArticleCount: status.servingTotalArticleCount ?? null,
    totalCellCount: status.servingTotalCellCount ?? null,
  }
}

export const getComparisonProjectServingMetadata = (status: ComparisonProjectServingStatusRow) => {
  const servingStatus = getComparisonProjectServingMetadataStatus(status)

  return {
    activeGeneration: status.activeGeneration,
    judgmentContextId: status.activeGeneration === null ? null : (status.activeJudgmentContextId ?? null),
    isServingReady: servingStatus === 'ready' && status.activeGeneration !== null,
    servingProgress: getComparisonProjectServingProgress(status),
    servingStatus,
    servingUpdatedAt: getComparisonProjectServingUpdatedAt(status),
  }
}
