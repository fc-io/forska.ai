import {runReviewServingProjectorWorker} from '../workers/reviewServingProjectorWorker.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {registerDuckdbOwnerDemotionHandler, shouldCurrentServerRunMaintenanceLoops} from './serverRuntimeRole.ts'

type ReviewServingProjectorWorkerHeartbeatOptions = {pollIntervalMs?: number}

const reviewServingProjectorWorkerLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const reviewServingProjectorWorkerWarningLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const reviewServingProjectorWorkerComponent = 'reviewServingProjectorWorker'

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

export const startReviewServingProjectorWorkerHeartbeat = (
  options: ReviewServingProjectorWorkerHeartbeatOptions = {},
) => {
  if (!shouldCurrentServerRunMaintenanceLoops()) {
    return () => {}
  }

  const controller = new AbortController()
  let stopped = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null

  reviewServingProjectorWorkerLogger.log(
    'review-serving-projector-worker:loop-start',
    '[reviewServingProjectorWorker] background loop starting',
    {
      component: reviewServingProjectorWorkerComponent,
      event: 'loopStart',
      pollIntervalMs: options.pollIntervalMs ?? null,
      startCount: 1,
    },
  )

  const startLoop = () => {
    void runReviewServingProjectorWorker({pollIntervalMs: options.pollIntervalMs, signal: controller.signal}).catch(
      (error) => {
        logReviewServingProjectorWorkerError(error)

        if (stopped || controller.signal.aborted) {
          return
        }

        restartTimer = setTimeout(startLoop, options.pollIntervalMs ?? 0)
        restartTimer.unref()
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
