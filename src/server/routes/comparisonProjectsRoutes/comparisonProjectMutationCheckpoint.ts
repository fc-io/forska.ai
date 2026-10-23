import {getMaintenanceDuckdbWorkloadContext} from '../../utils/duckdbService.ts'
import {
  type ConflictResolutionSaveBaseDiagnostic,
  getConflictResolutionSaveErrorDiagnostic,
  getConflictResolutionSaveMemorySnapshot,
  getConflictResolutionSaveRuntimeDiagnostic,
  logConflictResolutionSavePhase,
} from './comparisonProjectConflictResolutionSaveDiagnostics.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'

export const checkpointComparisonProjectMutation = async (diagnostic?: ConflictResolutionSaveBaseDiagnostic) => {
  if (diagnostic) {
    logConflictResolutionSavePhase('deferred-checkpoint:start', diagnostic)
  }
  await appDatabaseService.maintenance('checkpoint', getMaintenanceDuckdbWorkloadContext('comparisonProjectMutation'))
  if (diagnostic) {
    logConflictResolutionSavePhase('deferred-checkpoint:complete', diagnostic)
  }
}

const deferredComparisonProjectConflictResolutionCheckpointDelayMs = 1000
let deferredComparisonProjectConflictResolutionCheckpoint: ReturnType<typeof setTimeout> | null = null

export const scheduleComparisonProjectConflictResolutionCheckpoint = (
  diagnostic: ConflictResolutionSaveBaseDiagnostic,
) => {
  if (deferredComparisonProjectConflictResolutionCheckpoint !== null) {
    return
  }

  deferredComparisonProjectConflictResolutionCheckpoint = setTimeout(() => {
    deferredComparisonProjectConflictResolutionCheckpoint = null
    void checkpointComparisonProjectMutation(diagnostic).catch((error) => {
      console.error('[comparison-projects] conflict-resolution checkpoint failed', {
        ...diagnostic,
        error: getConflictResolutionSaveErrorDiagnostic(error),
        memory: getConflictResolutionSaveMemorySnapshot(),
        runtime: getConflictResolutionSaveRuntimeDiagnostic(),
      })
    })
  }, deferredComparisonProjectConflictResolutionCheckpointDelayMs)
  deferredComparisonProjectConflictResolutionCheckpoint.unref?.()
}
