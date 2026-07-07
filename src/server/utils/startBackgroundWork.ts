import {startDuckdbOwnerConnectionHeartbeat} from './duckdbOwnerConnectionHeartbeat.ts'
import {startReviewBulkOperationWorkerHeartbeat} from './reviewBulkOperationWorkerHeartbeat.ts'
import {startReviewServingProjectorWorkerHeartbeat} from './reviewServingProjectorWorkerHeartbeat.ts'
import {parseDuckdbMemoryLimitToMiB} from './duckdbMemoryLimit.ts'
import {shouldDisableServerMutationWork} from './serverMutationMode.ts'
import {
  registerDuckdbOwnerDemotionHandler,
  registerDuckdbOwnerPromotionHandler,
  shouldCurrentServerRunMaintenanceLoops,
  startServerRuntimeRoleMonitor,
} from './serverRuntimeRole.ts'
import {startRequestAttemptCloseoutBackfillScheduler} from './startRequestAttemptCloseoutBackfillScheduler.ts'

let maintenanceBackgroundWorkStops: Array<() => void> | null = null
const lowMemoryMaintenanceDuckdbLimitMiB = 6400
const lowMemoryReviewServingProjectorWorkerMaxCompletedChunksPerRun = 16
const lowMemoryReviewServingProjectorWorkerRestartDelayMs = 5_000

const shouldDeferNonessentialDuckdbMaintenanceWork = () => {
  const duckdbLimitMiB = parseDuckdbMemoryLimitToMiB(process.env.DUCKDB_MEMORY_LIMIT)

  return duckdbLimitMiB !== null && duckdbLimitMiB <= lowMemoryMaintenanceDuckdbLimitMiB
}

const getReviewServingProjectorWorkerHeartbeatOptions = () => {
  return shouldDeferNonessentialDuckdbMaintenanceWork()
    ? {
        maxCompletedRebuildChunksPerRun: lowMemoryReviewServingProjectorWorkerMaxCompletedChunksPerRun,
        restartDelayMs: lowMemoryReviewServingProjectorWorkerRestartDelayMs,
      }
    : {}
}

const startMaintenanceBackgroundWork = () => {
  if (!shouldCurrentServerRunMaintenanceLoops()) {
    return
  }

  if (maintenanceBackgroundWorkStops !== null) {
    return
  }

  maintenanceBackgroundWorkStops = [
    ...(shouldDeferNonessentialDuckdbMaintenanceWork() ? [] : [startRequestAttemptCloseoutBackfillScheduler()]),
    ...(shouldDeferNonessentialDuckdbMaintenanceWork() ? [] : [startReviewBulkOperationWorkerHeartbeat()]),
    startReviewServingProjectorWorkerHeartbeat(getReviewServingProjectorWorkerHeartbeatOptions()),
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
