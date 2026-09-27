export type DuckdbGracefulShutdownLogEntry = {
  attrs: Record<string, unknown>
  event: string
  message: string
  severity: 'ERROR' | 'INFO' | 'WARN'
  terminalArgs?: unknown[]
}

export type DuckdbGracefulShutdownDependencies = {
  checkpoint: () => Promise<void>
  closeActiveConnections: () => void
  closeRuntime: (input: {closeNative: boolean}) => Promise<void>
  closeStatementAdmission: () => void
  getWalBytes: () => number | null
  interruptActiveWork: () => void
  isIdle: () => boolean
  isRuntimeOpen: () => boolean
  log: (entry: DuckdbGracefulShutdownLogEntry) => void
  now: () => number
  stopBackgroundWork: () => Promise<unknown[]> | unknown[]
  wait: (ms: number) => Promise<void>
}

export type DuckdbGracefulShutdownTimeouts = {
  checkpointRetryIntervalMs: number
  checkpointTimeoutMs: number
  drainTimeoutMs: number
  pollIntervalMs: number
  rollbackTimeoutMs: number
}

export type DuckdbGracefulShutdownOptions = DuckdbGracefulShutdownTimeouts & {shouldCheckpoint: boolean; signal: string}

export type DuckdbGracefulShutdownDrain = 'busy' | 'idle' | 'interrupted'
export type DuckdbGracefulShutdownCheckpoint = 'completed' | 'failed' | 'skipped' | 'timed-out'
export type DuckdbGracefulShutdownResult = {
  checkpoint: DuckdbGracefulShutdownCheckpoint
  checkpointAttempts: number
  drain: DuckdbGracefulShutdownDrain
  walBytes: number | null
}

type DuckdbShutdownCheckpointOutcome = {
  attempts: number
  error: unknown
  skipReason: string | null
  status: DuckdbGracefulShutdownCheckpoint
}

export const duckdbGracefulShutdownDefaultTimeouts: DuckdbGracefulShutdownTimeouts = {
  checkpointRetryIntervalMs: 500,
  checkpointTimeoutMs: 120_000,
  drainTimeoutMs: 45_000,
  pollIntervalMs: 100,
  rollbackTimeoutMs: 15_000,
}

const retryableDuckdbShutdownCheckpointErrorFragment = 'Cannot CHECKPOINT'

const getNonNegativeIntegerEnvValue = (value: string | undefined, fallback: number) => {
  const parsedValue = Number(String(value ?? '').trim())

  return String(value ?? '').trim() !== '' && Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : fallback
}

export const getDuckdbGracefulShutdownTimeouts = (
  envValues: Record<string, string | undefined> = process.env,
): DuckdbGracefulShutdownTimeouts => {
  return {
    ...duckdbGracefulShutdownDefaultTimeouts,
    checkpointTimeoutMs: getNonNegativeIntegerEnvValue(
      envValues.FORSKA_DUCKDB_SHUTDOWN_CHECKPOINT_TIMEOUT_MS,
      duckdbGracefulShutdownDefaultTimeouts.checkpointTimeoutMs,
    ),
    drainTimeoutMs: getNonNegativeIntegerEnvValue(
      envValues.FORSKA_DUCKDB_SHUTDOWN_DRAIN_TIMEOUT_MS,
      duckdbGracefulShutdownDefaultTimeouts.drainTimeoutMs,
    ),
    rollbackTimeoutMs: getNonNegativeIntegerEnvValue(
      envValues.FORSKA_DUCKDB_SHUTDOWN_ROLLBACK_TIMEOUT_MS,
      duckdbGracefulShutdownDefaultTimeouts.rollbackTimeoutMs,
    ),
  }
}

export const getDuckdbGracefulShutdownBudgetMs = (timeouts: DuckdbGracefulShutdownTimeouts) => {
  return timeouts.drainTimeoutMs + timeouts.rollbackTimeoutMs + timeouts.checkpointTimeoutMs
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const waitForDuckdbShutdownIdle = async (
  dependencies: DuckdbGracefulShutdownDependencies,
  deadlineMs: number,
  pollIntervalMs: number,
): Promise<boolean> => {
  if (dependencies.isIdle()) {
    return true
  }

  if (dependencies.now() >= deadlineMs) {
    return false
  }

  await dependencies.wait(pollIntervalMs)
  return waitForDuckdbShutdownIdle(dependencies, deadlineMs, pollIntervalMs)
}

const interruptDuckdbShutdownWork = async (
  dependencies: DuckdbGracefulShutdownDependencies,
  options: DuckdbGracefulShutdownOptions,
): Promise<DuckdbGracefulShutdownDrain> => {
  dependencies.log({
    attrs: {drainTimeoutMs: options.drainTimeoutMs, rollbackTimeoutMs: options.rollbackTimeoutMs},
    event: 'duckdb.shutdown.interrupting',
    message: '[duckdb] shutdown drain timed out; interrupting active DuckDB work and waiting for rollback',
    severity: 'WARN',
  })
  dependencies.interruptActiveWork()

  const idle = await waitForDuckdbShutdownIdle(
    dependencies,
    dependencies.now() + options.rollbackTimeoutMs,
    options.pollIntervalMs,
  )

  return idle ? 'interrupted' : 'busy'
}

const drainDuckdbShutdownWork = async (
  dependencies: DuckdbGracefulShutdownDependencies,
  options: DuckdbGracefulShutdownOptions,
): Promise<DuckdbGracefulShutdownDrain> => {
  const idle = await waitForDuckdbShutdownIdle(
    dependencies,
    dependencies.now() + options.drainTimeoutMs,
    options.pollIntervalMs,
  )
  dependencies.closeStatementAdmission()

  return idle ? 'idle' : interruptDuckdbShutdownWork(dependencies, options)
}

const runDuckdbShutdownCheckpointAttempt = async (
  dependencies: DuckdbGracefulShutdownDependencies,
  timeoutMs: number,
  attempts: number,
): Promise<DuckdbShutdownCheckpointOutcome> => {
  const checkpoint = dependencies.checkpoint().then(
    (): DuckdbShutdownCheckpointOutcome => {
      return {attempts, error: null, skipReason: null, status: 'completed'}
    },
    (error: unknown): DuckdbShutdownCheckpointOutcome => {
      return {attempts, error, skipReason: null, status: 'failed'}
    },
  )
  const timeout = dependencies.wait(timeoutMs).then((): DuckdbShutdownCheckpointOutcome => {
    return {attempts, error: null, skipReason: null, status: 'timed-out'}
  })

  return Promise.race([checkpoint, timeout])
}

const canRetryDuckdbShutdownCheckpoint = (
  dependencies: DuckdbGracefulShutdownDependencies,
  options: DuckdbGracefulShutdownOptions,
  outcome: DuckdbShutdownCheckpointOutcome,
  deadlineMs: number,
) => {
  return (
    outcome.status === 'failed'
    && getErrorMessage(outcome.error).includes(retryableDuckdbShutdownCheckpointErrorFragment)
    && dependencies.now() + options.checkpointRetryIntervalMs < deadlineMs
  )
}

const retryDuckdbShutdownCheckpoint = async (
  dependencies: DuckdbGracefulShutdownDependencies,
  options: DuckdbGracefulShutdownOptions,
  deadlineMs: number,
  attempts: number,
): Promise<DuckdbShutdownCheckpointOutcome> => {
  await dependencies.wait(options.checkpointRetryIntervalMs)
  return attemptDuckdbShutdownCheckpoint(dependencies, options, deadlineMs, attempts + 1)
}

const attemptDuckdbShutdownCheckpoint = async (
  dependencies: DuckdbGracefulShutdownDependencies,
  options: DuckdbGracefulShutdownOptions,
  deadlineMs: number,
  attempts: number,
): Promise<DuckdbShutdownCheckpointOutcome> => {
  const outcome = await runDuckdbShutdownCheckpointAttempt(
    dependencies,
    Math.max(0, deadlineMs - dependencies.now()),
    attempts,
  )

  return canRetryDuckdbShutdownCheckpoint(dependencies, options, outcome, deadlineMs)
    ? retryDuckdbShutdownCheckpoint(dependencies, options, deadlineMs, attempts)
    : outcome
}

const startDuckdbShutdownCheckpoint = async (
  dependencies: DuckdbGracefulShutdownDependencies,
  options: DuckdbGracefulShutdownOptions,
): Promise<DuckdbShutdownCheckpointOutcome> => {
  dependencies.closeActiveConnections()
  return attemptDuckdbShutdownCheckpoint(dependencies, options, dependencies.now() + options.checkpointTimeoutMs, 1)
}

const getDuckdbShutdownCheckpointSkipReason = (
  dependencies: DuckdbGracefulShutdownDependencies,
  options: DuckdbGracefulShutdownOptions,
) => {
  return !dependencies.isRuntimeOpen() ? 'runtime-closed' : !options.shouldCheckpoint ? 'low-memory-runtime' : null
}

const runDuckdbShutdownCheckpoint = async (
  dependencies: DuckdbGracefulShutdownDependencies,
  options: DuckdbGracefulShutdownOptions,
): Promise<DuckdbShutdownCheckpointOutcome> => {
  const skipReason = getDuckdbShutdownCheckpointSkipReason(dependencies, options)

  return skipReason === null
    ? startDuckdbShutdownCheckpoint(dependencies, options)
    : {attempts: 0, error: null, skipReason, status: 'skipped'}
}

const getDuckdbShutdownCheckpointTerminalArgs = (input: {
  checkpoint: DuckdbShutdownCheckpointOutcome
  drain: DuckdbGracefulShutdownDrain
  walBytes: number | null
}) => {
  const detail =
    input.checkpoint.status === 'failed'
      ? [`error=${getErrorMessage(input.checkpoint.error)}`]
      : input.checkpoint.status === 'skipped'
        ? [`reason=${input.checkpoint.skipReason}`]
        : []

  return [`drain=${input.drain}`, `wal_bytes=${input.walBytes ?? 'n/a'}`, ...detail]
}

const logDuckdbShutdownCheckpoint = (
  dependencies: DuckdbGracefulShutdownDependencies,
  input: {
    checkpoint: DuckdbShutdownCheckpointOutcome
    checkpointDurationMs: number
    drain: DuckdbGracefulShutdownDrain
    options: DuckdbGracefulShutdownOptions
    walBytes: number | null
  },
) => {
  const completed = input.checkpoint.status === 'completed'

  dependencies.log({
    attrs: {
      checkpoint: input.checkpoint.status,
      checkpointAttempts: input.checkpoint.attempts,
      checkpointDurationMs: input.checkpointDurationMs,
      checkpointTimeoutMs: input.options.checkpointTimeoutMs,
      drain: input.drain,
      error: input.checkpoint.error,
      signal: input.options.signal,
      skipReason: input.checkpoint.skipReason,
      walBytes: input.walBytes,
    },
    event: completed ? 'duckdb.shutdown.checkpointed' : `duckdb.shutdown.checkpoint-${input.checkpoint.status}`,
    message: completed
      ? '[duckdb] shutdown checkpoint completed'
      : `[duckdb] shutdown checkpoint ${input.checkpoint.status}`,
    severity: completed || input.checkpoint.status === 'skipped' ? 'INFO' : 'WARN',
    terminalArgs: getDuckdbShutdownCheckpointTerminalArgs(input),
  })
}

const logDuckdbShutdownStarted = (
  dependencies: DuckdbGracefulShutdownDependencies,
  options: DuckdbGracefulShutdownOptions,
) => {
  dependencies.log({
    attrs: {
      checkpointTimeoutMs: options.checkpointTimeoutMs,
      drainTimeoutMs: options.drainTimeoutMs,
      rollbackTimeoutMs: options.rollbackTimeoutMs,
      signal: options.signal,
    },
    event: 'duckdb.shutdown.started',
    message:
      `[duckdb] ${options.signal} received; finishing active DuckDB work (up to ${options.drainTimeoutMs}ms) `
      + 'and checkpointing before exit. Further signals are ignored; send SIGKILL to force.',
    severity: 'INFO',
  })
}

const stopDuckdbShutdownBackgroundWork = async (dependencies: DuckdbGracefulShutdownDependencies) => {
  const backgroundStopErrors = await dependencies.stopBackgroundWork()

  if (backgroundStopErrors.length > 0) {
    dependencies.log({
      attrs: {errors: backgroundStopErrors},
      event: 'duckdb.shutdown.background-stop-failure',
      message: '[duckdb] some background work failed to stop cleanly during shutdown',
      severity: 'WARN',
    })
  }
}

export const runDuckdbGracefulShutdown = async (
  dependencies: DuckdbGracefulShutdownDependencies,
  options: DuckdbGracefulShutdownOptions,
): Promise<DuckdbGracefulShutdownResult> => {
  const startedAtMs = dependencies.now()

  logDuckdbShutdownStarted(dependencies, options)
  await stopDuckdbShutdownBackgroundWork(dependencies)

  const drain = await drainDuckdbShutdownWork(dependencies, options)
  const checkpointStartedAtMs = dependencies.now()
  const checkpoint = await runDuckdbShutdownCheckpoint(dependencies, options)
  const walBytes = dependencies.getWalBytes()

  logDuckdbShutdownCheckpoint(dependencies, {
    checkpoint,
    checkpointDurationMs: dependencies.now() - checkpointStartedAtMs,
    drain,
    options,
    walBytes,
  })
  await dependencies.closeRuntime({closeNative: checkpoint.status !== 'timed-out'})
  dependencies.log({
    attrs: {
      checkpoint: checkpoint.status,
      drain,
      durationMs: dependencies.now() - startedAtMs,
      signal: options.signal,
      walBytesAfterClose: dependencies.getWalBytes(),
    },
    event: 'duckdb.shutdown.completed',
    message: '[duckdb] shutdown completed',
    severity: 'INFO',
  })

  return {checkpoint: checkpoint.status, checkpointAttempts: checkpoint.attempts, drain, walBytes}
}
