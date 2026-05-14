import {
  recordRequestAttemptCloseoutBackfillFailure,
  type RequestAttemptCloseoutDatabaseRunner,
  runRequestAttemptCloseoutBackfillCycle,
} from '../services/requestAttemptCloseoutService.ts'
import {writeRuntimeFailureLogEvent} from './runtimeLogger.ts'
import {
  canCurrentServerOwnDuckdb,
  registerDuckdbOwnerDemotionHandler,
  shouldCurrentServerRunMaintenanceLoops,
} from './serverRuntimeRole.ts'

type RequestAttemptCloseoutBackfillSchedulerOptions = {
  batchSize?: number
  intervalMs?: number
  runner?: RequestAttemptCloseoutDatabaseRunner
}

const requestAttemptCloseoutBackfillSchedulerIntervalMs = 30_000
const requestAttemptCloseoutBackfillSchedulerBatchSize = 1000

const shouldRunRequestAttemptCloseoutBackfillScheduler = () => {
  return canCurrentServerOwnDuckdb() && shouldCurrentServerRunMaintenanceLoops()
}

const getRequestAttemptCloseoutBackfillSchedulerErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)

  return message.trim().length > 0 ? message : 'Unknown request attempt closeout backfill scheduler failure'
}

const logRequestAttemptCloseoutBackfillSchedulerFailure = ({
  error,
  failureRecordingError,
}: {
  error: unknown
  failureRecordingError: unknown
}) => {
  const errorMessage = getRequestAttemptCloseoutBackfillSchedulerErrorMessage(error)
  const failureRecordingErrorMessage = failureRecordingError
    ? getRequestAttemptCloseoutBackfillSchedulerErrorMessage(failureRecordingError)
    : null

  writeRuntimeFailureLogEvent({
    attrs: {error, errorMessage, failureRecordingError, failureRecordingErrorMessage},
    event: 'request-attempt-closeout-backfill.scheduler.failure',
    message: `[requestAttemptCloseoutBackfill] scheduler wake failed: ${errorMessage}`,
    terminalArgs: [errorMessage],
  })
}

const recordRequestAttemptCloseoutBackfillSchedulerFailure = async ({
  error,
  runner,
}: {
  error: unknown
  runner?: RequestAttemptCloseoutDatabaseRunner
}): Promise<unknown> => {
  try {
    await recordRequestAttemptCloseoutBackfillFailure({error, runner})
    return null
  } catch (failureRecordingError) {
    return failureRecordingError
  }
}

export const startRequestAttemptCloseoutBackfillScheduler = (
  options: RequestAttemptCloseoutBackfillSchedulerOptions = {},
) => {
  if (!shouldRunRequestAttemptCloseoutBackfillScheduler()) {
    return () => {}
  }

  let running = false
  let stopped = false
  let timeout: ReturnType<typeof setTimeout> | null = null

  const intervalMs = options.intervalMs ?? requestAttemptCloseoutBackfillSchedulerIntervalMs
  const batchSize = options.batchSize ?? requestAttemptCloseoutBackfillSchedulerBatchSize

  const scheduleNextWake = () => {
    if (stopped) {
      return
    }

    timeout = setTimeout(() => {
      void runWake()
    }, intervalMs)
    timeout.unref()
  }

  const runWake = async () => {
    if (stopped || running) {
      return
    }

    if (!shouldRunRequestAttemptCloseoutBackfillScheduler()) {
      scheduleNextWake()
      return
    }

    running = true

    try {
      const result = await runRequestAttemptCloseoutBackfillCycle({batchSize, runner: options.runner})

      if (result.completed) {
        stop()
      }
    } catch (error) {
      const failureRecordingError = await recordRequestAttemptCloseoutBackfillSchedulerFailure({
        error,
        runner: options.runner,
      })

      logRequestAttemptCloseoutBackfillSchedulerFailure({error, failureRecordingError})
    } finally {
      running = false
      scheduleNextWake()
    }
  }

  const stop = () => {
    stopped = true

    if (timeout !== null) {
      clearTimeout(timeout)
      timeout = null
    }
  }

  scheduleNextWake()
  registerDuckdbOwnerDemotionHandler(() => {
    stop()
  })
  process.once('exit', stop)

  return stop
}
