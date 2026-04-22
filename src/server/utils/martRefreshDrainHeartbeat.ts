import {parseDuckdbMemoryLimitToMiB} from './duckdbMemoryLimit.ts'
import {startProjectMartLargeRebuildHeartbeat} from './projectMartLargeRebuildHeartbeat.ts'
import {startProjectMartRefreshWorkerHeartbeat} from './projectMartRefreshWorkerHeartbeat.ts'

type MartRefreshDrainHeartbeatOptions = {intervalMs?: number}

const lowMemoryMartRefreshWorkerDuckdbLimitMiB = 6400

const shouldRunMartRefreshDrainHeartbeat = () => {
  const workerDuckdbMemoryLimitMiB = parseDuckdbMemoryLimitToMiB(process.env.DUCKDB_MEMORY_LIMIT)
  return workerDuckdbMemoryLimitMiB === null || workerDuckdbMemoryLimitMiB > lowMemoryMartRefreshWorkerDuckdbLimitMiB
}

export const startMartRefreshDrainHeartbeat = (options: MartRefreshDrainHeartbeatOptions = {}) => {
  if (!shouldRunMartRefreshDrainHeartbeat()) {
    return () => {}
  }

  const stopProjectMartRefreshWorker = startProjectMartRefreshWorkerHeartbeat({pollIntervalMs: options.intervalMs})
  const stopProjectMartLargeRebuild = startProjectMartLargeRebuildHeartbeat({pollIntervalMs: options.intervalMs})

  return () => {
    stopProjectMartRefreshWorker()
    stopProjectMartLargeRebuild()
  }
}
