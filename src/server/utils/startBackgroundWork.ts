import {startDuckdbOwnerConnectionHeartbeat} from './duckdbOwnerConnectionHeartbeat.ts'
import {startReviewBulkOperationWorkerHeartbeat} from './reviewBulkOperationWorkerHeartbeat.ts'
import {startReviewServingProjectorWorkerHeartbeat} from './reviewServingProjectorWorkerHeartbeat.ts'
import {shouldDisableServerMutationWork} from './serverMutationMode.ts'
import {
  registerDuckdbOwnerDemotionHandler,
  registerDuckdbOwnerPromotionHandler,
  shouldCurrentServerRunMaintenanceLoops,
  startServerRuntimeRoleMonitor,
} from './serverRuntimeRole.ts'
import {startRequestAttemptCloseoutBackfillScheduler} from './startRequestAttemptCloseoutBackfillScheduler.ts'

let maintenanceBackgroundWorkStops: Array<() => void> | null = null

const startMaintenanceBackgroundWork = () => {
  if (!shouldCurrentServerRunMaintenanceLoops()) {
    return
  }

  if (maintenanceBackgroundWorkStops !== null) {
    return
  }

  maintenanceBackgroundWorkStops = [
    startRequestAttemptCloseoutBackfillScheduler(),
    startReviewBulkOperationWorkerHeartbeat(),
    startReviewServingProjectorWorkerHeartbeat(),
  ]
}

const stopMaintenanceBackgroundWork = () => {
  const stops = maintenanceBackgroundWorkStops
  maintenanceBackgroundWorkStops = null

  stops?.forEach((stop) => {
    stop()
  })
}

export const startBackgroundWork = () => {
  if (shouldDisableServerMutationWork()) {
    return
  }

  startServerRuntimeRoleMonitor()
  startDuckdbOwnerConnectionHeartbeat()
  registerDuckdbOwnerPromotionHandler(() => {
    startMaintenanceBackgroundWork()
  })
  registerDuckdbOwnerDemotionHandler(() => {
    stopMaintenanceBackgroundWork()
  })
  startMaintenanceBackgroundWork()
}
