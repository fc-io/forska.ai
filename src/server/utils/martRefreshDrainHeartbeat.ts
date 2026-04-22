import {shouldCurrentRuntimeRunMartRefreshDrain} from './martRefreshDrainEligibility.ts'
import {startProjectMartLargeRebuildHeartbeat} from './projectMartLargeRebuildHeartbeat.ts'
import {startProjectMartRefreshWorkerHeartbeat} from './projectMartRefreshWorkerHeartbeat.ts'

type MartRefreshDrainHeartbeatOptions = {intervalMs?: number}

export const startMartRefreshDrainHeartbeat = (options: MartRefreshDrainHeartbeatOptions = {}) => {
  if (!shouldCurrentRuntimeRunMartRefreshDrain()) {
    return () => {}
  }

  const stopProjectMartRefreshWorker = startProjectMartRefreshWorkerHeartbeat({pollIntervalMs: options.intervalMs})
  const stopProjectMartLargeRebuild = startProjectMartLargeRebuildHeartbeat({pollIntervalMs: options.intervalMs})

  return () => {
    stopProjectMartRefreshWorker()
    stopProjectMartLargeRebuild()
  }
}
