import {comparisonProjectServingRebuildService} from './comparisonProjectRouteServices.ts'

const getComparisonProjectServingQueueErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

export const queueComparisonProjectServingRebuild = (comparisonProjectId: string) => {
  return comparisonProjectServingRebuildService
    .rebuildComparisonProjectServing(comparisonProjectId)
    .catch((error: unknown) => {
      console.error('[comparison-project-serving] rebuild failed', {
        comparisonProjectId,
        error: getComparisonProjectServingQueueErrorMessage(error),
      })
    })
}

export const markComparisonProjectServingStaleAndQueueRebuild = async (comparisonProjectId: string) => {
  await comparisonProjectServingRebuildService.markComparisonProjectServingStale(comparisonProjectId)
  void queueComparisonProjectServingRebuild(comparisonProjectId)
}
