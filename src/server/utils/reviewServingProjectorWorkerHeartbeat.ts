import {runReviewServingProjectorWorker} from '../workers/reviewServingProjectorWorker.ts'
import {parseDuckdbMemoryLimitToMiB} from './duckdbMemoryLimit.ts'
import {env, getDefaultReviewServingRebuildChunkBatchMaxRssBytes} from './env.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {registerDuckdbOwnerDemotionHandler, shouldCurrentServerRunMaintenanceLoops} from './serverRuntimeRole.ts'

type ReviewServingProjectorWorkerHeartbeatOptions = {
  maxCompletedRebuildChunksPerRun?: number | null
  maxRunMs?: number | null
  pollIntervalMs?: number
  rebuildChunkBatchMaxRssBytes?: number
  rebuildChunkBatchSize?: number
  restartDelayMs?: number
}

const reviewServingProjectorWorkerLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const reviewServingProjectorWorkerWarningLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const reviewServingProjectorWorkerComponent = 'reviewServingProjectorWorker'
const defaultReviewServingProjectorWorkerHeartbeatBatchSize = 2
const lowMemoryMaintenanceDuckdbLimitMiB = 6400
const lowMemoryReviewServingProjectorWorkerMaxCompletedChunksPerRun = 16
const lowMemoryReviewServingProjectorWorkerRestartDelayMs = 5_000

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const logReviewServingProjectorWorkerError = (error: unknown) => {
  return reviewServingProjectorWorkerWarningLogger.warn(
    'review-serving-projector-worker',
    '[reviewServingProjectorWorker] background loop failed',
    {component: reviewServingProjectorWorkerComponent, errorMessage: getErrorMessage(error), event: 'loopFailed'},
  )
}

const getReviewServingProjectorWorkerMaxRunMs = (options: ReviewServingProjectorWorkerHeartbeatOptions) => {
  return options.maxRunMs === undefined ? null : options.maxRunMs
}

const getLowMemoryReviewServingProjectorWorkerMaxCompletedChunksPerRun = () => {
  const duckdbLimitMiB = parseDuckdbMemoryLimitToMiB(env.DUCKDB_MEMORY_LIMIT)

  return duckdbLimitMiB !== null && duckdbLimitMiB <= lowMemoryMaintenanceDuckdbLimitMiB
    ? lowMemoryReviewServingProjectorWorkerMaxCompletedChunksPerRun
    : null
}

const getReviewServingProjectorWorkerMaxCompletedChunksPerRun = (
  options: ReviewServingProjectorWorkerHeartbeatOptions,
) => {
  return options.maxCompletedRebuildChunksPerRun === undefined
    ? getLowMemoryReviewServingProjectorWorkerMaxCompletedChunksPerRun()
    : options.maxCompletedRebuildChunksPerRun
}

const getReviewServingProjectorWorkerRebuildChunkBatchMaxRssBytes = (
  options: ReviewServingProjectorWorkerHeartbeatOptions,
) => {
  return (
    options.rebuildChunkBatchMaxRssBytes
    ?? env.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES
    ?? getDefaultReviewServingRebuildChunkBatchMaxRssBytes()
  )
}

const shouldRecycleDuckdbBeforeReviewServingProjectorRestart = (
  options: ReviewServingProjectorWorkerHeartbeatOptions,
) => {
  const maxRssBytes = getReviewServingProjectorWorkerRebuildChunkBatchMaxRssBytes(options)

  return maxRssBytes > 0 && process.memoryUsage().rss >= maxRssBytes
}

const shouldRestartMaintenanceWorkerAfterHighRssDuckdbRecycle = () => {
  return process.env.FORSKA_RUNTIME_SERVICE === 'maintenance-worker-server'
}

const recycleDuckdbBeforeReviewServingProjectorRestart = async (
  options: ReviewServingProjectorWorkerHeartbeatOptions,
) => {
  if (!shouldRecycleDuckdbBeforeReviewServingProjectorRestart(options)) {
    return
  }

  const maxRssBytes = getReviewServingProjectorWorkerRebuildChunkBatchMaxRssBytes(options)
  const rssBytes = process.memoryUsage().rss

  reviewServingProjectorWorkerWarningLogger.warn(
    'review-serving-projector.heartbeat-recycle-duckdb',
    '[reviewServingProjectorWorker] recycling DuckDB before bounded loop restart',
    {maxRssBytes, rssBytes},
  )
  const {closeDuckdbService} = await import('./duckdbService.ts')
  await closeDuckdbService({checkpointBeforeClose: false, releaseOwnerLease: false})
  globalThis.Bun.gc(true)

  const rssBytesAfterRecycle = process.memoryUsage().rss

  if (rssBytesAfterRecycle < maxRssBytes || !shouldRestartMaintenanceWorkerAfterHighRssDuckdbRecycle()) {
    return
  }

  reviewServingProjectorWorkerWarningLogger.warn(
    'review-serving-projector.heartbeat-high-rss-process-restart',
    '[reviewServingProjectorWorker] restarting maintenance worker after DuckDB recycle left RSS above cap',
    {maxRssBytes, rssBytesAfterRecycle},
  )
  return process.exit(0)
}

export const startReviewServingProjectorWorkerHeartbeat = (
  options: ReviewServingProjectorWorkerHeartbeatOptions = {},
) => {
  if (!shouldCurrentServerRunMaintenanceLoops()) {
    return () => {}
  }

  const controller = new AbortController()
  let stopped = false
  let activeLoopController: AbortController | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null

  reviewServingProjectorWorkerLogger.log(
    'review-serving-projector-worker:loop-start',
    '[reviewServingProjectorWorker] background loop starting',
    {
      component: reviewServingProjectorWorkerComponent,
      event: 'loopStart',
      pollIntervalMs: options.pollIntervalMs ?? null,
      rebuildChunkBatchMaxRssBytes:
        options.rebuildChunkBatchMaxRssBytes
        ?? env.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_MAX_RSS_BYTES
        ?? getDefaultReviewServingRebuildChunkBatchMaxRssBytes(),
      rebuildChunkBatchSize:
        options.rebuildChunkBatchSize
        ?? env.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE
        ?? defaultReviewServingProjectorWorkerHeartbeatBatchSize,
      maxCompletedRebuildChunksPerRun: getReviewServingProjectorWorkerMaxCompletedChunksPerRun(options),
      maxRunMs: getReviewServingProjectorWorkerMaxRunMs(options),
      startCount: 1,
    },
  )

  const scheduleRestart = (delayMs: number, keepProcessAlive: boolean) => {
    if (stopped || controller.signal.aborted) {
      return
    }

    restartTimer = setTimeout(startLoop, delayMs)
    if (!keepProcessAlive) {
      restartTimer.unref()
    }
  }

  const startLoop = () => {
    if (stopped || controller.signal.aborted) {
      return
    }

    const loopController = new AbortController()
    const maxCompletedRebuildChunksPerRun = getReviewServingProjectorWorkerMaxCompletedChunksPerRun(options)
    const maxRunMs = getReviewServingProjectorWorkerMaxRunMs(options)
    const restartDelayMs = options.restartDelayMs ?? lowMemoryReviewServingProjectorWorkerRestartDelayMs
    let endedByMaxRun = false
    let maxRunTimer: ReturnType<typeof setTimeout> | null = null
    const abortActiveLoop = () => {
      loopController.abort()
    }

    activeLoopController = loopController
    controller.signal.addEventListener('abort', abortActiveLoop, {once: true})

    if (maxRunMs !== null && maxRunMs > 0) {
      maxRunTimer = setTimeout(() => {
        endedByMaxRun = true
        loopController.abort()
      }, maxRunMs)
      maxRunTimer.unref()
    }

    void runReviewServingProjectorWorker({
      pollIntervalMs: options.pollIntervalMs,
      rebuildChunkBatchMaxRssBytes: getReviewServingProjectorWorkerRebuildChunkBatchMaxRssBytes(options),
      rebuildChunkBatchSize:
        options.rebuildChunkBatchSize
        ?? env.FORSKA_REVIEW_SERVING_REBUILD_CHUNK_BATCH_SIZE
        ?? defaultReviewServingProjectorWorkerHeartbeatBatchSize,
      maxCompletedRebuildChunksPerRun,
      signal: loopController.signal,
    })
      .then(async (result) => {
        if (result?.reason === 'nativeHeavyChunkCompleted') {
          await recycleDuckdbBeforeReviewServingProjectorRestart(options)
          scheduleRestart(restartDelayMs, true)
          return
        }

        if (endedByMaxRun || maxCompletedRebuildChunksPerRun !== null) {
          await recycleDuckdbBeforeReviewServingProjectorRestart(options)
          scheduleRestart(restartDelayMs, true)
        }
      })
      .catch((error) => {
        logReviewServingProjectorWorkerError(error)

        if (stopped || controller.signal.aborted) {
          return
        }

        scheduleRestart(options.pollIntervalMs ?? 0, false)
      })
      .finally(() => {
        controller.signal.removeEventListener('abort', abortActiveLoop)
        if (maxRunTimer !== null) {
          clearTimeout(maxRunTimer)
        }
        if (activeLoopController === loopController) {
          activeLoopController = null
        }
      })
  }

  startLoop()

  const stop = () => {
    stopped = true
    if (restartTimer) {
      clearTimeout(restartTimer)
    }
    activeLoopController?.abort()
    controller.abort()
  }

  registerDuckdbOwnerDemotionHandler(() => {
    stop()
  })
  process.once('exit', stop)

  return stop
}
