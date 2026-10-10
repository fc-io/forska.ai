import {getComparisonProjectServingRebuildService} from '../services/comparisonProjectServingRebuildService.ts'
import {runComparisonProjectServingMaintenanceWorkerOnce} from '../workers/comparisonProjectServingMaintenanceWorker.ts'
import {createRateLimitedLogger} from './rateLimitedLogger.ts'
import {registerDuckdbOwnerDemotionHandler, shouldCurrentServerRunMaintenanceLoops} from './serverRuntimeRole.ts'

type ComparisonProjectServingMaintenanceWorkerHeartbeatOptions = {pollIntervalMs?: number}

const comparisonProjectServingMaintenanceWorkerLogger = createRateLimitedLogger({sink: 'file-only', windowMs: 30_000})
const comparisonProjectServingMaintenanceWorkerWarningLogger = createRateLimitedLogger({sink: 'both', windowMs: 30_000})
const comparisonProjectServingMaintenanceWorkerComponent = 'comparisonProjectServingMaintenanceWorker'
const defaultPollIntervalMs = 30_000

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const getProcessStartedAt = () => {
  return new Date(Date.now() - process.uptime() * 1000)
}

const logComparisonProjectServingMaintenanceWorkerError = (error: unknown) => {
  return comparisonProjectServingMaintenanceWorkerWarningLogger.warn(
    'comparison-project-serving-maintenance-worker',
    '[comparisonProjectServingMaintenanceWorker] background loop failed',
    {
      component: comparisonProjectServingMaintenanceWorkerComponent,
      errorMessage: getErrorMessage(error),
      event: 'loopFailed',
    },
  )
}

export const startComparisonProjectServingMaintenanceWorkerHeartbeat = (
  options: ComparisonProjectServingMaintenanceWorkerHeartbeatOptions = {},
) => {
  if (!shouldCurrentServerRunMaintenanceLoops()) {
    return () => {}
  }

  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs
  let stopped = false
  let running = false
  let timer: ReturnType<typeof setInterval> | null = null

  comparisonProjectServingMaintenanceWorkerLogger.log(
    'comparison-project-serving-maintenance-worker:loop-start',
    '[comparisonProjectServingMaintenanceWorker] background loop starting',
    {component: comparisonProjectServingMaintenanceWorkerComponent, event: 'loopStart', pollIntervalMs},
  )

  const runWake = async () => {
    if (stopped || running || !shouldCurrentServerRunMaintenanceLoops()) {
      return
    }

    running = true
    try {
      const result = await runComparisonProjectServingMaintenanceWorkerOnce()

      if (result.status === 'processed') {
        comparisonProjectServingMaintenanceWorkerLogger.log(
          `comparison-project-serving-maintenance-worker:processed:${result.comparisonProjectId}`,
          '[comparisonProjectServingMaintenanceWorker] processed comparison project serving rebuild',
          {
            comparisonProjectId: result.comparisonProjectId,
            component: comparisonProjectServingMaintenanceWorkerComponent,
            event: 'processed',
            rebuilt: result.rebuilt,
          },
        )
      }

      if (result.status === 'idle' && result.reason === 'judgment-context-backfill-failed') {
        comparisonProjectServingMaintenanceWorkerWarningLogger.warn(
          `comparison-project-serving-maintenance-worker:judgment-context-failed:${result.comparisonProjectId}:${result.generation}`,
          `[comparisonProjectServingMaintenanceWorker] judgment context backfill failed for comparison project ${result.comparisonProjectId} generation ${result.generation}`,
          {
            attempts: result.attempts,
            comparisonProjectId: result.comparisonProjectId,
            component: comparisonProjectServingMaintenanceWorkerComponent,
            errorMessage: result.errorMessage,
            event: 'judgmentContextBackfillFailed',
            generation: result.generation,
            nextAttemptAt: result.nextAttemptAt?.toISOString() ?? null,
          },
        )
      }

      if (result.status === 'backfilled') {
        comparisonProjectServingMaintenanceWorkerLogger.log(
          `comparison-project-serving-maintenance-worker:judgment-context:${result.comparisonProjectId}:${result.generation}`,
          '[comparisonProjectServingMaintenanceWorker] backfilled comparison judgment context for the active generation',
          {
            comparisonProjectId: result.comparisonProjectId,
            component: comparisonProjectServingMaintenanceWorkerComponent,
            event: 'judgmentContextBackfilled',
            generation: result.generation,
            judgmentContextId: result.judgmentContextId,
          },
        )
      }
    } catch (error) {
      logComparisonProjectServingMaintenanceWorkerError(error)
    } finally {
      running = false
    }
  }

  const releaseOrphanedClaims = async () => {
    try {
      const releasedComparisonProjectIds =
        await getComparisonProjectServingRebuildService().releaseComparisonProjectServingClaimsProgressedBefore(
          getProcessStartedAt(),
        )

      if (releasedComparisonProjectIds.length > 0) {
        comparisonProjectServingMaintenanceWorkerLogger.log(
          'comparison-project-serving-maintenance-worker:orphaned-claims-released',
          '[comparisonProjectServingMaintenanceWorker] released comparison serving claims left by a previous process',
          {
            comparisonProjectIds: releasedComparisonProjectIds,
            component: comparisonProjectServingMaintenanceWorkerComponent,
            event: 'orphanedClaimsReleased',
          },
        )
      }
    } catch (error) {
      logComparisonProjectServingMaintenanceWorkerError(error)
    }
  }

  void releaseOrphanedClaims().then(runWake)
  timer = setInterval(() => {
    void runWake()
  }, pollIntervalMs)
  timer.unref()

  const stop = () => {
    stopped = true
    if (timer !== null) {
      clearInterval(timer)
    }
  }

  registerDuckdbOwnerDemotionHandler(() => {
    stop()
  })
  process.once('exit', stop)

  return stop
}
