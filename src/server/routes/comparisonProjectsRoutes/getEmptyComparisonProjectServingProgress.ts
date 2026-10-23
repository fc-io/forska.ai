import type {ComparisonProjectServingProgress} from '../../services/comparisonProjectServingRebuildService.ts'

export const getEmptyComparisonProjectServingProgress = (): ComparisonProjectServingProgress => {
  return {
    completedAt: null,
    failedAt: null,
    generation: null,
    lastError: null,
    lastProgressedAt: null,
    phase: null,
    phaseStartedAt: null,
    stagedArticleCount: 0,
    stagedCellCount: 0,
    stagedFilterMemberCount: 0,
    stagedFilterStatsCount: 0,
    startedAt: null,
    totalArticleCount: null,
    totalCellCount: null,
  }
}
