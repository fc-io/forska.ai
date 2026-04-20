import {runProjectMartRefreshWorker} from '../workers/projectMartRefreshWorker.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {registerWriterDemotionHandler, shouldCurrentServerRunWriterWork} from './serverRuntimeRole.ts'

type ProjectMartRefreshWorkerHeartbeatOptions = {pollIntervalMs?: number}

const projectMartRefreshWorkerLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const projectMartRefreshWorkerWarningLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const projectMartRefreshWorkerComponent = 'projectMartRefreshWorker'

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const logProjectMartRefreshWorkerError = (error: unknown) => {
  return projectMartRefreshWorkerWarningLogger.warn(
    'project-mart-refresh-worker',
    '[projectMartRefreshWorker] background loop failed',
    {component: projectMartRefreshWorkerComponent, errorMessage: getErrorMessage(error), event: 'loopFailed'},
  )
}

export const startProjectMartRefreshWorkerHeartbeat = (options: ProjectMartRefreshWorkerHeartbeatOptions = {}) => {
  if (!shouldCurrentServerRunWriterWork()) {
    return () => {}
  }

  const controller = new AbortController()

  projectMartRefreshWorkerLogger.log(
    'project-mart-refresh-worker:loop-start',
    '[projectMartRefreshWorker] background loop starting',
    {
      component: projectMartRefreshWorkerComponent,
      event: 'loopStart',
      pollIntervalMs: options.pollIntervalMs ?? null,
      startCount: 1,
    },
  )

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
