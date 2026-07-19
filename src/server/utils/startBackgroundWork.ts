import {startComparisonProjectServingMaintenanceWorkerHeartbeat} from './comparisonProjectServingMaintenanceWorkerHeartbeat.ts'
import {parseDuckdbMemoryLimitToMiB} from './duckdbMemoryLimit.ts'
import {startDuckdbOwnerConnectionHeartbeat} from './duckdbOwnerConnectionHeartbeat.ts'
import {
  closeDuckdbService,
  getDuckdbAppendRuntimeMetrics,
  getDuckdbQueueRuntimeMetricsSnapshot,
} from './duckdbService.ts'
import {env, getDefaultReviewServingRebuildChunkBatchMaxRssBytes} from './env.ts'
import {startReviewBulkOperationWorkerHeartbeat} from './reviewBulkOperationWorkerHeartbeat.ts'
import {
  clearReviewServingProjectorPauseMarker,
  getReviewServingProjectorPauseMarkerPath,
  getReviewServingProjectorPauseMarkerState,
  isReviewServingProjectorPaused,
} from './reviewServingProjectorPause.ts'
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
const lowMemoryReviewServingProjectorWorkerMaxRunMs = 60_000
const lowMemoryReviewServingProjectorWorkerRestartDelayMs = 5_000
const reviewServingProjectorPauseRecoveryPollIntervalMs = 30_000
const reviewServingProjectorPauseRecoveryMinAgeMs = 5 * 60_000
const reviewServingProjectorPauseRecoveryQueueResampleDelayMs = 250
const reviewServingProjectorPauseRecoveryDuckdbRecycleCooldownMs = 60_000

const getPositiveIntegerEnv = (key: string, fallback: number) => {
  const value = Number(process.env[key])

  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

const shouldDeferNonessentialDuckdbMaintenanceWork = () => {
  const duckdbLimitMiB = parseDuckdbMemoryLimitToMiB(env.DUCKDB_MEMORY_LIMIT)

  return duckdbLimitMiB !== null && duckdbLimitMiB <= lowMemoryMaintenanceDuckdbLimitMiB
}

const getReviewServingProjectorWorkerHeartbeatOptions = () => {
  return shouldDeferNonessentialDuckdbMaintenanceWork()
    ? {
        maxCompletedRebuildChunksPerRun: lowMemoryReviewServingProjectorWorkerMaxCompletedChunksPerRun,
        maxRunMs: lowMemoryReviewServingProjectorWorkerMaxRunMs,
        restartDelayMs: lowMemoryReviewServingProjectorWorkerRestartDelayMs,
      }
    : {}
}

const getReviewServingProjectorPauseRecoveryMaxRssBytes = () => {
  return (
    env.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES ?? getDefaultReviewServingRebuildChunkBatchMaxRssBytes()
  )
}

const getReviewServingProjectorPauseRecoveryQueueState = () => {
  const queueMetrics = getDuckdbQueueRuntimeMetricsSnapshot()
  const appendMetrics = getDuckdbAppendRuntimeMetrics()

  return {
    appendQueueDepth: appendMetrics.queueDepth,
    backgroundQueueDepth: queueMetrics.background.queueDepth,
    foregroundQueueDepth: queueMetrics.main.queueDepth,
  }
}

const getHasActiveReviewServingProjectorPauseRecoveryQueueWork = (
  queueState: ReturnType<typeof getReviewServingProjectorPauseRecoveryQueueState>,
) => {
  return queueState.foregroundQueueDepth > 0 || queueState.backgroundQueueDepth > 0 || queueState.appendQueueDepth > 0
}

const shouldRecoverReviewServingProjectorPause = async () => {
  const pauseMarkerState = getReviewServingProjectorPauseMarkerState()

  if (!pauseMarkerState.exists) {
    return {pauseMarkerState, recover: true as const}
  }

  const nowMs = Date.now()
  const markerAgeMs = nowMs - pauseMarkerState.updatedAtMs
  const minAgeMs = getPositiveIntegerEnv(
    'FORSKA_REVIEW_SERVING_PROJECTOR_PAUSE_RECOVERY_MIN_AGE_MS',
    reviewServingProjectorPauseRecoveryMinAgeMs,
  )

  if (markerAgeMs < minAgeMs) {
    return {pauseMarkerState, reason: 'marker-too-new' as const, recover: false as const}
  }

  let queueState = getReviewServingProjectorPauseRecoveryQueueState()
  let resampledQueueState: typeof queueState | null = null

  if (getHasActiveReviewServingProjectorPauseRecoveryQueueWork(queueState)) {
    await sleep(
      getPositiveIntegerEnv(
        'FORSKA_REVIEW_SERVING_PROJECTOR_PAUSE_RECOVERY_QUEUE_RESAMPLE_DELAY_MS',
        reviewServingProjectorPauseRecoveryQueueResampleDelayMs,
      ),
    )
    resampledQueueState = getReviewServingProjectorPauseRecoveryQueueState()
    queueState = resampledQueueState
  }

  if (getHasActiveReviewServingProjectorPauseRecoveryQueueWork(queueState)) {
    return {
      ...queueState,
      pauseMarkerState,
      reason: 'duckdb-work-active' as const,
      recover: false as const,
      resampledQueueState,
    }
  }

  const rssBytes = process.memoryUsage().rss
  const maxRssBytes = getReviewServingProjectorPauseRecoveryMaxRssBytes()

  if (rssBytes >= maxRssBytes) {
    return {maxRssBytes, pauseMarkerState, reason: 'rss-above-cap' as const, recover: false as const, rssBytes}
  }

  return {pauseMarkerState, recover: true as const}
}

const startReviewServingProjectorPauseRecoveryHeartbeat = (startProjector: () => void) => {
  let stopped = false
  let running = false
  let recovered = false
  let lastDuckdbRecycleAtMs = 0
  let initialTimer: ReturnType<typeof setTimeout> | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  const runWake = async () => {
    if (stopped || running || recovered || !shouldCurrentServerRunMaintenanceLoops()) {
      return
    }

    running = true
    try {
      const recoveryState = await shouldRecoverReviewServingProjectorPause()

      if (!recoveryState.recover) {
        const nowMs = Date.now()
        const duckdbRecycleCooldownMs = getPositiveIntegerEnv(
          'FORSKA_REVIEW_SERVING_PROJECTOR_PAUSE_RECOVERY_DUCKDB_RECYCLE_COOLDOWN_MS',
          reviewServingProjectorPauseRecoveryDuckdbRecycleCooldownMs,
        )

        if (recoveryState.reason === 'rss-above-cap' && nowMs - lastDuckdbRecycleAtMs >= duckdbRecycleCooldownMs) {
          lastDuckdbRecycleAtMs = nowMs
          writeRuntimeOperatorLogEvent({
            attrs: recoveryState,
            event: 'review-serving-projector.pause-recovery-recycle-duckdb',
            message: '[reviewServingProjectorWorker] recycling DuckDB before auto-resuming paused projector',
            severity: 'WARN',
          })
          await closeDuckdbService({checkpointBeforeClose: false, releaseOwnerLease: false})
          globalThis.Bun.gc(true)
          return
        }

        writeRuntimeOperatorLogEvent({
          attrs: recoveryState,
          event: 'review-serving-projector.pause-recovery-wait',
          message: '[reviewServingProjectorWorker] waiting to auto-resume paused projector',
          severity: 'INFO',
        })
        return
      }

      if (recoveryState.pauseMarkerState.exists) {
        clearReviewServingProjectorPauseMarker()
      }

      recovered = true
      writeRuntimeOperatorLogEvent({
        attrs: {markerPath: recoveryState.pauseMarkerState.markerPath},
        event: 'review-serving-projector.pause-recovered',
        message: '[reviewServingProjectorWorker] auto-resuming after recovery pause',
        severity: 'WARN',
      })
      startProjector()
      stop()
    } finally {
      running = false
    }
  }

  const stop = () => {
    stopped = true
    if (initialTimer !== null) {
      clearTimeout(initialTimer)
    }
    if (timer !== null) {
      clearInterval(timer)
    }
  }

  initialTimer = setTimeout(() => {
    void runWake()
  }, 0)
  initialTimer.unref()
  timer = setInterval(
    () => {
      void runWake()
    },
    getPositiveIntegerEnv(
      'FORSKA_REVIEW_SERVING_PROJECTOR_PAUSE_RECOVERY_POLL_INTERVAL_MS',
      reviewServingProjectorPauseRecoveryPollIntervalMs,
    ),
  )
  timer.unref()

  return stop
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

  const startReviewServingProjector = () => {
    maintenanceBackgroundWorkStops?.push(
      startReviewServingProjectorWorkerHeartbeat(getReviewServingProjectorWorkerHeartbeatOptions()),
    )
  }

  maintenanceBackgroundWorkStops = [
    ...(shouldDeferNonessentialDuckdbMaintenanceWork() ? [] : [startRequestAttemptCloseoutBackfillScheduler()]),
    ...(shouldDeferNonessentialDuckdbMaintenanceWork() ? [] : [startReviewBulkOperationWorkerHeartbeat()]),
    startComparisonProjectServingMaintenanceWorkerHeartbeat(),
    ...(reviewServingProjectorPaused
      ? [startReviewServingProjectorPauseRecoveryHeartbeat(startReviewServingProjector)]
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
