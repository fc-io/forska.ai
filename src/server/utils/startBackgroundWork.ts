import {startDuckdbOwnerConnectionHeartbeat} from './duckdbOwnerConnectionHeartbeat.ts'
import {shouldCurrentRuntimeRunMartRefreshDrain} from './martRefreshDrainEligibility.ts'
import {startProjectMartLargeRebuildHeartbeat} from './projectMartLargeRebuildHeartbeat.ts'
import {startProjectMartRefreshWorkerHeartbeat} from './projectMartRefreshWorkerHeartbeat.ts'
import {shouldCurrentServerRunMaintenanceLoops, startServerRuntimeRoleMonitor} from './serverRuntimeRole.ts'

const startMaintenanceBackgroundWork = () => {
  if (!shouldCurrentServerRunMaintenanceLoops() || !shouldCurrentRuntimeRunMartRefreshDrain()) {
    return
  }

  startProjectMartRefreshWorkerHeartbeat()
  startProjectMartLargeRebuildHeartbeat()
}

export const startBackgroundWork = () => {
  startServerRuntimeRoleMonitor()
  startDuckdbOwnerConnectionHeartbeat()
  startMaintenanceBackgroundWork()
}
