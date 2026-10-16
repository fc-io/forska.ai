export type DuckdbWalCheckpointPolicyConfig = {
  enabled: boolean
  minIntervalMs: number
  pollIntervalMs: number
  walThresholdBytes: number
}

export type DuckdbWalCheckpointRuntimeState = {runtimeOpen: boolean; walBytes: number | null; writesInFlight: boolean}

export type DuckdbWalCheckpointSkipReason = 'below-threshold' | 'min-interval' | 'runtime-closed' | 'writes-in-flight'

export type DuckdbWalCheckpointDecision =
  | {action: 'checkpoint'}
  | {action: 'skip'; reason: DuckdbWalCheckpointSkipReason}

export type DuckdbIdleWalCheckpointOutcome = 'completed' | 'skipped-writes-in-flight'

export type DuckdbWalCheckpointLogEntry = {
  attrs: Record<string, unknown>
  event: string
  message: string
  severity: 'INFO' | 'WARN'
}

export type DuckdbWalCheckpointSchedulerDependencies = {
  checkpoint: () => Promise<DuckdbIdleWalCheckpointOutcome>
  getRuntimeState: () => DuckdbWalCheckpointRuntimeState
  log: (entry: DuckdbWalCheckpointLogEntry) => void
  now: () => number
}

export type DuckdbWalCheckpointSchedulerState = {
  busySinceMs: number | null
  lastAttemptAtMs: number | null
  lastDeferredLogAtMs: number | null
}

export const duckdbWalCheckpointDefaultThresholdBytes = 64 * 1024 * 1024
export const duckdbWalCheckpointDefaultMinIntervalMs = 60_000
export const duckdbWalCheckpointDefaultPollIntervalMs = 10_000
export const duckdbWalCheckpointDeferredLogIntervalMs = 300_000
export const duckdbLowMemoryShutdownCheckpointMaxWalBytes = 256 * 1024 * 1024

export const initialDuckdbWalCheckpointSchedulerState: DuckdbWalCheckpointSchedulerState = {
  busySinceMs: null,
  lastAttemptAtMs: null,
  lastDeferredLogAtMs: null,
}

const getNonNegativeIntegerEnvValue = (value: string | undefined, fallback: number) => {
  const trimmedValue = String(value ?? '').trim()
  const parsedValue = Number(trimmedValue)

  return trimmedValue !== '' && Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : fallback
}

const getPositiveIntegerEnvValue = (value: string | undefined, fallback: number) => {
  const parsedValue = getNonNegativeIntegerEnvValue(value, fallback)

  return parsedValue > 0 ? parsedValue : fallback
}

export const getDuckdbWalCheckpointPolicyConfig = ({
  autoCheckpointDeferred,
  envValues = process.env,
}: {
  autoCheckpointDeferred: boolean
  envValues?: Record<string, string | undefined>
}): DuckdbWalCheckpointPolicyConfig => {
  const walThresholdBytes = getNonNegativeIntegerEnvValue(
    envValues.FORSKA_DUCKDB_WAL_CHECKPOINT_THRESHOLD_BYTES,
    duckdbWalCheckpointDefaultThresholdBytes,
  )

  return {
    enabled: autoCheckpointDeferred && walThresholdBytes > 0,
    minIntervalMs: getNonNegativeIntegerEnvValue(
      envValues.FORSKA_DUCKDB_WAL_CHECKPOINT_MIN_INTERVAL_MS,
      duckdbWalCheckpointDefaultMinIntervalMs,
    ),
    pollIntervalMs: getPositiveIntegerEnvValue(
      envValues.FORSKA_DUCKDB_WAL_CHECKPOINT_POLL_INTERVAL_MS,
      duckdbWalCheckpointDefaultPollIntervalMs,
    ),
    walThresholdBytes,
  }
}

const getDuckdbWalCheckpointSkipReason = ({
  config,
  lastAttemptAtMs,
  nowMs,
  runtimeState,
}: {
  config: DuckdbWalCheckpointPolicyConfig
  lastAttemptAtMs: number | null
  nowMs: number
  runtimeState: DuckdbWalCheckpointRuntimeState
}): DuckdbWalCheckpointSkipReason | null => {
  return !runtimeState.runtimeOpen
    ? 'runtime-closed'
    : runtimeState.walBytes === null || runtimeState.walBytes <= config.walThresholdBytes
      ? 'below-threshold'
      : lastAttemptAtMs !== null && nowMs - lastAttemptAtMs < config.minIntervalMs
        ? 'min-interval'
        : runtimeState.writesInFlight
          ? 'writes-in-flight'
          : null
}

export const getDuckdbWalCheckpointDecision = (input: {
  config: DuckdbWalCheckpointPolicyConfig
  lastAttemptAtMs: number | null
  nowMs: number
  runtimeState: DuckdbWalCheckpointRuntimeState
}): DuckdbWalCheckpointDecision => {
  const reason = getDuckdbWalCheckpointSkipReason(input)

  return reason === null ? {action: 'checkpoint'} : {action: 'skip', reason}
}

const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error)
}

const shouldLogDuckdbWalCheckpointDeferral = (state: DuckdbWalCheckpointSchedulerState, nowMs: number) => {
  return (
    state.busySinceMs !== null
    && nowMs - state.busySinceMs >= duckdbWalCheckpointDeferredLogIntervalMs
    && (state.lastDeferredLogAtMs === null
      || nowMs - state.lastDeferredLogAtMs >= duckdbWalCheckpointDeferredLogIntervalMs)
  )
}

const recordDuckdbWalCheckpointBusy = (
  dependencies: DuckdbWalCheckpointSchedulerDependencies,
  config: DuckdbWalCheckpointPolicyConfig,
  state: DuckdbWalCheckpointSchedulerState,
  input: {nowMs: number; walBytes: number | null},
): DuckdbWalCheckpointSchedulerState => {
  const busyState = {...state, busySinceMs: state.busySinceMs ?? input.nowMs}

  if (!shouldLogDuckdbWalCheckpointDeferral(busyState, input.nowMs)) {
    return busyState
  }

  dependencies.log({
    attrs: {
      busyForMs: input.nowMs - (busyState.busySinceMs ?? input.nowMs),
      walBytes: input.walBytes,
      walThresholdBytes: config.walThresholdBytes,
    },
    event: 'duckdb.wal-checkpoint.deferred',
    message: `[duckdb] WAL is ${input.walBytes ?? 'unknown'} bytes (threshold ${config.walThresholdBytes}); idle checkpoint still waiting for in-flight writes to finish`,
    severity: 'WARN',
  })

  return {...busyState, lastDeferredLogAtMs: input.nowMs}
}

const runDuckdbWalCheckpointAttempt = async (
  dependencies: DuckdbWalCheckpointSchedulerDependencies,
  config: DuckdbWalCheckpointPolicyConfig,
  state: DuckdbWalCheckpointSchedulerState,
  walBytesBefore: number | null,
): Promise<DuckdbWalCheckpointSchedulerState> => {
  const startedAtMs = dependencies.now()

  try {
    const outcome = await dependencies.checkpoint()

    if (outcome === 'skipped-writes-in-flight') {
      return recordDuckdbWalCheckpointBusy(dependencies, config, state, {nowMs: startedAtMs, walBytes: walBytesBefore})
    }

    const walBytesAfter = dependencies.getRuntimeState().walBytes

    dependencies.log({
      attrs: {
        durationMs: dependencies.now() - startedAtMs,
        walBytesAfter,
        walBytesBefore,
        walThresholdBytes: config.walThresholdBytes,
      },
      event: 'duckdb.wal-checkpoint.completed',
      message: `[duckdb] idle WAL checkpoint completed (${walBytesBefore ?? 'unknown'} -> ${walBytesAfter ?? 'unknown'} bytes)`,
      severity: 'INFO',
    })
  } catch (error) {
    dependencies.log({
      attrs: {
        durationMs: dependencies.now() - startedAtMs,
        error: getErrorMessage(error),
        walBytesBefore,
        walThresholdBytes: config.walThresholdBytes,
      },
      event: 'duckdb.wal-checkpoint.failed',
      message: `[duckdb] idle WAL checkpoint failed: ${getErrorMessage(error)}`,
      severity: 'WARN',
    })
  }

  return {busySinceMs: null, lastAttemptAtMs: startedAtMs, lastDeferredLogAtMs: null}
}

export const runDuckdbWalCheckpointTick = async (
  dependencies: DuckdbWalCheckpointSchedulerDependencies,
  config: DuckdbWalCheckpointPolicyConfig,
  state: DuckdbWalCheckpointSchedulerState,
): Promise<DuckdbWalCheckpointSchedulerState> => {
  const nowMs = dependencies.now()
  const runtimeState = dependencies.getRuntimeState()
  const decision = getDuckdbWalCheckpointDecision({config, lastAttemptAtMs: state.lastAttemptAtMs, nowMs, runtimeState})

  return decision.action === 'checkpoint'
    ? runDuckdbWalCheckpointAttempt(dependencies, config, state, runtimeState.walBytes)
    : decision.reason === 'writes-in-flight'
      ? recordDuckdbWalCheckpointBusy(dependencies, config, state, {nowMs, walBytes: runtimeState.walBytes})
      : {...state, busySinceMs: null}
}

export const startDuckdbWalCheckpointScheduler = (
  dependencies: DuckdbWalCheckpointSchedulerDependencies,
  config: DuckdbWalCheckpointPolicyConfig,
) => {
  const scheduler = {running: false, state: initialDuckdbWalCheckpointSchedulerState, stopped: false}
  const tick = async () => {
    if (scheduler.running || scheduler.stopped) {
      return
    }

    scheduler.running = true

    try {
      scheduler.state = await runDuckdbWalCheckpointTick(dependencies, config, scheduler.state)
    } finally {
      scheduler.running = false
    }
  }
  const timer = setInterval(() => {
    void tick()
  }, config.pollIntervalMs)

  timer.unref()
  dependencies.log({
    attrs: {
      minIntervalMs: config.minIntervalMs,
      pollIntervalMs: config.pollIntervalMs,
      walThresholdBytes: config.walThresholdBytes,
    },
    event: 'duckdb.wal-checkpoint.scheduler-started',
    message: `[duckdb] idle WAL checkpoints enabled above ${config.walThresholdBytes} bytes (min interval ${config.minIntervalMs}ms)`,
    severity: 'INFO',
  })

  return () => {
    scheduler.stopped = true
    clearInterval(timer)
  }
}
