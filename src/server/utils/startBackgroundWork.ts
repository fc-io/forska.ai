import {startDuckdbOwnerConnectionHeartbeat} from './duckdbOwnerConnectionHeartbeat.ts'
import {startReviewBulkOperationWorkerHeartbeat} from './reviewBulkOperationWorkerHeartbeat.ts'
import {startReviewServingProjectorWorkerHeartbeat} from './reviewServingProjectorWorkerHeartbeat.ts'
import {shouldCurrentServerRunMaintenanceLoops, startServerRuntimeRoleMonitor} from './serverRuntimeRole.ts'
import {startRequestAttemptCloseoutBackfillScheduler} from './startRequestAttemptCloseoutBackfillScheduler.ts'

const startMaintenanceBackgroundWork = () => {
  if (!shouldCurrentServerRunMaintenanceLoops()) {
    return
  }

  startRequestAttemptCloseoutBackfillScheduler()
  startReviewBulkOperationWorkerHeartbeat()
  startReviewServingProjectorWorkerHeartbeat()
}

export const startBackgroundWork = () => {
  startServerRuntimeRoleMonitor()
  startDuckdbOwnerConnectionHeartbeat()
  startMaintenanceBackgroundWork()
}
