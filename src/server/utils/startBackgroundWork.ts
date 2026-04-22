import {startDuckdbOwnerConnectionHeartbeat} from './duckdbOwnerConnectionHeartbeat.ts'
import {startMartRefreshDrainHeartbeat} from './martRefreshDrainHeartbeat.ts'
import {shouldCurrentServerRunMaintenanceLoops, startServerRuntimeRoleMonitor} from './serverRuntimeRole.ts'

const startMaintenanceBackgroundWork = () => {
  if (!shouldCurrentServerRunMaintenanceLoops()) {
    return
  }

  startMartRefreshDrainHeartbeat()
}

export const startBackgroundWork = () => {
  startServerRuntimeRoleMonitor()
  startDuckdbOwnerConnectionHeartbeat()
  startMaintenanceBackgroundWork()
}
