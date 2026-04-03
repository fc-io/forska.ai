import {startProjectMartLargeRebuildHeartbeat} from './projectMartLargeRebuildHeartbeat.ts'
import {startProjectMartRefreshWorkerHeartbeat} from './projectMartRefreshWorkerHeartbeat.ts'

type MartRefreshDrainHeartbeatOptions = {intervalMs?: number}

export const startMartRefreshDrainHeartbeat = (options: MartRefreshDrainHeartbeatOptions = {}) => {
  const stopProjectMartRefreshWorker = startProjectMartRefreshWorkerHeartbeat({pollIntervalMs: options.intervalMs})
  const stopProjectMartLargeRebuild = startProjectMartLargeRebuildHeartbeat({pollIntervalMs: options.intervalMs})

  return () => {
    stopProjectMartRefreshWorker()
    stopProjectMartLargeRebuild()
  }
}
