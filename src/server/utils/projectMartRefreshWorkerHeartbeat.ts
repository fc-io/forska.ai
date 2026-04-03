import {runProjectMartRefreshWorker} from '../workers/projectMartRefreshWorker.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {registerWriterDemotionHandler, shouldCurrentServerRunWriterWork} from './serverRuntimeRole.ts'

type ProjectMartRefreshWorkerHeartbeatOptions = {pollIntervalMs?: number}

const projectMartRefreshWorkerLogger = createRateLimitedLogger({windowMs: 30_000})

const logProjectMartRefreshWorkerError = (error: unknown) => {
  return projectMartRefreshWorkerLogger.warn(
    'project-mart-refresh-worker',
    '[projectMartRefreshWorker] background loop failed',
    error,
  )
}

export const startProjectMartRefreshWorkerHeartbeat = (options: ProjectMartRefreshWorkerHeartbeatOptions = {}) => {
  if (!shouldCurrentServerRunWriterWork()) {
    return () => {}
  }

  const controller = new AbortController()

  console.log('[projectMartRefreshWorker] background loop starting')

  void runProjectMartRefreshWorker({pollIntervalMs: options.pollIntervalMs, signal: controller.signal}).catch(
    logProjectMartRefreshWorkerError,
  )

  const stop = () => {
    controller.abort()
  }

  registerWriterDemotionHandler(() => {
    stop()
  })
  process.once('exit', stop)

  return stop
}
