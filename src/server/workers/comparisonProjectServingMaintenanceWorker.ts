import {getComparisonProjectServingRebuildService} from '../services/comparisonProjectServingRebuildService.ts'
import {getDuckdbAppendRuntimeMetrics, getDuckdbQueueRuntimeMetricsSnapshot} from '../utils/duckdbService.ts'

type ComparisonProjectServingMaintenanceWorkerDependencies = {
  getAppendQueueDepth: () => number
  getForegroundQueueDepth: () => number
  rebuildNextUnavailableComparisonProjectServing: ReturnType<
    typeof getComparisonProjectServingRebuildService
  >['rebuildNextUnavailableComparisonProjectServing']
}

type ComparisonProjectServingMaintenanceWorkerResult =
  | {comparisonProjectId: null; reason: 'foreground-work-active'; status: 'idle'}
  | {comparisonProjectId: null; reason: 'no-unavailable-project'; status: 'idle'}
  | {comparisonProjectId: string; rebuilt: boolean; status: 'processed'}

const getDefaultComparisonProjectServingMaintenanceWorkerDependencies =
  (): ComparisonProjectServingMaintenanceWorkerDependencies => {
    return {
      getAppendQueueDepth: () => {
        return getDuckdbAppendRuntimeMetrics().queueDepth
      },
      getForegroundQueueDepth: () => {
        return getDuckdbQueueRuntimeMetricsSnapshot().main.queueDepth
      },
      rebuildNextUnavailableComparisonProjectServing:
        getComparisonProjectServingRebuildService().rebuildNextUnavailableComparisonProjectServing,
    }
  }

export const runComparisonProjectServingMaintenanceWorkerOnce = async (
  dependencies: Partial<ComparisonProjectServingMaintenanceWorkerDependencies> = {},
): Promise<ComparisonProjectServingMaintenanceWorkerResult> => {
  const workerDependencies = {...getDefaultComparisonProjectServingMaintenanceWorkerDependencies(), ...dependencies}

  if (workerDependencies.getForegroundQueueDepth() > 0 || workerDependencies.getAppendQueueDepth() > 0) {
    return {comparisonProjectId: null, reason: 'foreground-work-active', status: 'idle'}
  }

  const result = await workerDependencies.rebuildNextUnavailableComparisonProjectServing()

  return result.comparisonProjectId === null
    ? {comparisonProjectId: null, reason: 'no-unavailable-project', status: 'idle'}
    : {comparisonProjectId: result.comparisonProjectId, rebuilt: result.rebuilt, status: 'processed'}
}

export type {ComparisonProjectServingMaintenanceWorkerResult}
