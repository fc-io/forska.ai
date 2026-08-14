import {runReviewBulkOperationWorker} from '../workers/reviewBulkOperationWorker.ts'
import {hasActiveDuckdbExclusiveWork, isDuckdbExclusiveWorkAdmissionError} from './duckdbExclusiveWork.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {registerDuckdbOwnerDemotionHandler, shouldCurrentServerRunMaintenanceLoops} from './serverRuntimeRole.ts'

type ReviewBulkOperationWorkerHeartbeatOptions = {pollIntervalMs?: number}

const reviewBulkOperationWorkerLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const reviewBulkOperationWorkerWarningLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const reviewBulkOperationWorkerComponent = 'reviewBulkOperationWorker'

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const logReviewBulkOperationWorkerError = (error: unknown) => {
  return reviewBulkOperationWorkerWarningLogger.warn(
    'review-bulk-operation-worker',
    '[reviewBulkOperationWorker] background loop failed',
    {component: reviewBulkOperationWorkerComponent, errorMessage: getErrorMessage(error), event: 'loopFailed'},
  )
}

export const startReviewBulkOperationWorkerHeartbeat = (options: ReviewBulkOperationWorkerHeartbeatOptions = {}) => {
  if (!shouldCurrentServerRunMaintenanceLoops()) {
    return () => {}
  }

  const controller = new AbortController()
  let stopped = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  const exclusiveWorkPollIntervalMs = options.pollIntervalMs ?? 2_000

  reviewBulkOperationWorkerLogger.log(
    'review-bulk-operation-worker:loop-start',
    '[reviewBulkOperationWorker] background loop starting',
    {
      component: reviewBulkOperationWorkerComponent,
      event: 'loopStart',
      pollIntervalMs: options.pollIntervalMs ?? null,
      startCount: 1,
    },
  )

  let startLoop: () => void
  const scheduleRestart = (delayMs: number) => {
    if (stopped || controller.signal.aborted) {
      return
    }

    restartTimer = setTimeout(startLoop, delayMs)
    restartTimer.unref()
  }

  startLoop = () => {
    if (stopped || controller.signal.aborted) {
      return
    }

    if (hasActiveDuckdbExclusiveWork()) {
      scheduleRestart(exclusiveWorkPollIntervalMs)
      return
    }

    void runReviewBulkOperationWorker({pollIntervalMs: options.pollIntervalMs, signal: controller.signal}).catch(
      (error) => {
        if (isDuckdbExclusiveWorkAdmissionError(error)) {
          scheduleRestart(exclusiveWorkPollIntervalMs)
          return
        }

        logReviewBulkOperationWorkerError(error)

        if (stopped || controller.signal.aborted) {
          return
        }

        scheduleRestart(options.pollIntervalMs ?? 0)
      },
    )
  }

  startLoop()

  const stop = () => {
    stopped = true
    if (restartTimer) {
      clearTimeout(restartTimer)
    }
    controller.abort()
  }

  registerDuckdbOwnerDemotionHandler(() => {
    stop()
  })
  process.once('exit', stop)

  return stop
}
