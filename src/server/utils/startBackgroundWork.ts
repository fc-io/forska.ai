import {startDuckdbOwnerConnectionHeartbeat} from './duckdbOwnerConnectionHeartbeat.ts'
import {startMartRefreshDrainHeartbeat} from './martRefreshDrainHeartbeat.ts'
import {startServerRuntimeRoleMonitor} from './serverRuntimeRole.ts'

export const startBackgroundWork = () => {
  startServerRuntimeRoleMonitor()
  startDuckdbOwnerConnectionHeartbeat()
  startMartRefreshDrainHeartbeat()
}
