import {startMartRefreshDrainHeartbeat} from './martRefreshDrainHeartbeat.ts'
import {startServerRuntimeRoleMonitor} from './serverRuntimeRole.ts'
import {startWriterConnectionHeartbeat} from './writerConnectionHeartbeat.ts'

export const startBackgroundWork = () => {
  startServerRuntimeRoleMonitor()
  startWriterConnectionHeartbeat()
  startMartRefreshDrainHeartbeat()
}
