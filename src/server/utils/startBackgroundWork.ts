import {existsSync} from 'node:fs'

import {parseDuckdbMemoryLimitToMiB} from './duckdbMemoryLimit.ts'
import {startDuckdbOwnerConnectionHeartbeat} from './duckdbOwnerConnectionHeartbeat.ts'
import {env} from './env.ts'
import {startReviewBulkOperationWorkerHeartbeat} from './reviewBulkOperationWorkerHeartbeat.ts'
import {startReviewServingProjectorWorkerHeartbeat} from './reviewServingProjectorWorkerHeartbeat.ts'
import {writeRuntimeOperatorLogEvent} from './runtimeLogger.ts'
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
const reviewServingProjectorPauseMarkerSuffix = '.review-serving-projector-paused'

export const getReviewServingProjectorPauseMarkerPath = (duckdbPath = env.DUCKDB_PATH) => {
  return `${duckdbPath}${reviewServingProjectorPauseMarkerSuffix}`
}

const isReviewServingProjectorPaused = () => {
  return env.DUCKDB_PATH !== ':memory:' && existsSync(getReviewServingProjectorPauseMarkerPath())
}

const shouldDeferNonessentialDuckdbMaintenanceWork = () => {
  const duckdbLimitMiB = parseDuckdbMemoryLimitToMiB(env.DUCKDB_MEMORY_LIMIT)

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

  const reviewServingProjectorPaused = isReviewServingProjectorPaused()

  if (reviewServingProjectorPaused) {
    writeRuntimeOperatorLogEvent({
      attrs: {markerPath: getReviewServingProjectorPauseMarkerPath()},
      event: 'review-serving-projector.paused',
      message: '[reviewServingProjectorWorker] paused by operator recovery marker',
      severity: 'WARN',
    })
  }

  maintenanceBackgroundWorkStops = [
    ...(shouldDeferNonessentialDuckdbMaintenanceWork() ? [] : [startRequestAttemptCloseoutBackfillScheduler()]),
    ...(shouldDeferNonessentialDuckdbMaintenanceWork() ? [] : [startReviewBulkOperationWorkerHeartbeat()]),
    ...(reviewServingProjectorPaused
      ? []
      : [startReviewServingProjectorWorkerHeartbeat(getReviewServingProjectorWorkerHeartbeatOptions())]),
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
