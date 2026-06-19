import {Effect} from 'effect'

import {runReviewBulkOperationWorker} from '../workers/reviewBulkOperationWorker.ts'
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

const runReviewBulkOperationWorkerEffect = (input: {pollIntervalMs?: number; signal: AbortSignal}) => {
  return Effect.tryPromise(() => {
    return runReviewBulkOperationWorker({pollIntervalMs: input.pollIntervalMs, signal: input.signal})
  })
}

export const startReviewBulkOperationWorkerHeartbeat = (options: ReviewBulkOperationWorkerHeartbeatOptions = {}) => {
  if (!shouldCurrentServerRunMaintenanceLoops()) {
    return () => {}
  }

  const controller = new AbortController()
  let stopped = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null

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

  const startLoop = () => {
    void Effect.runPromise(
      runReviewBulkOperationWorkerEffect({pollIntervalMs: options.pollIntervalMs, signal: controller.signal}),
    ).catch((error) => {
      logReviewBulkOperationWorkerError(error)

      if (stopped || controller.signal.aborted) {
        return
      }

      restartTimer = setTimeout(startLoop, options.pollIntervalMs ?? 0)
      restartTimer.unref()
    })
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
