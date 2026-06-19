import {startDuckdbOwnerConnectionHeartbeat} from './duckdbOwnerConnectionHeartbeat.ts'
import {shouldCurrentRuntimeRunMartRefreshDrain} from './martRefreshDrainEligibility.ts'
import {startProjectMartLargeRebuildHeartbeat} from './projectMartLargeRebuildHeartbeat.ts'
import {startProjectMartRefreshWorkerHeartbeat} from './projectMartRefreshWorkerHeartbeat.ts'
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

  if (!shouldCurrentRuntimeRunMartRefreshDrain()) {
    return
  }

  startProjectMartRefreshWorkerHeartbeat()
  startProjectMartLargeRebuildHeartbeat()
  startReviewServingProjectorWorkerHeartbeat()
}

export const startBackgroundWork = () => {
  startServerRuntimeRoleMonitor()
  startDuckdbOwnerConnectionHeartbeat()
  startMaintenanceBackgroundWork()
}
