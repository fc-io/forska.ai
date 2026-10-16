import {expect, test} from 'bun:test'

import {
  duckdbWalCheckpointDefaultMinIntervalMs,
  duckdbWalCheckpointDefaultThresholdBytes,
  duckdbWalCheckpointDeferredLogIntervalMs,
  type DuckdbWalCheckpointLogEntry,
  type DuckdbWalCheckpointPolicyConfig,
  type DuckdbWalCheckpointRuntimeState,
  type DuckdbWalCheckpointSchedulerDependencies,
  getDuckdbWalCheckpointDecision,
  getDuckdbWalCheckpointPolicyConfig,
  initialDuckdbWalCheckpointSchedulerState,
  runDuckdbWalCheckpointTick,
  startDuckdbWalCheckpointScheduler,
} from './duckdbWalCheckpointPolicy.ts'

const mebibyte = 1024 * 1024

const config: DuckdbWalCheckpointPolicyConfig = {
  enabled: true,
  minIntervalMs: 60_000,
  pollIntervalMs: 10_000,
  walThresholdBytes: 64 * mebibyte,
}

const createHarness = (initialState: DuckdbWalCheckpointRuntimeState) => {
  const clock = {nowMs: 1_000_000}
  const runtime = {state: initialState}
  const logs: DuckdbWalCheckpointLogEntry[] = []
  const checkpoints: number[] = []
  const dependencies: DuckdbWalCheckpointSchedulerDependencies = {
    checkpoint: async () => {
      checkpoints.push(clock.nowMs)
      clock.nowMs += 750
      runtime.state = {...runtime.state, walBytes: 0}
      return 'completed'
    },
    getRuntimeState: () => {
      return runtime.state
    },
    log: (entry) => {
      logs.push(entry)
    },
    now: () => {
      return clock.nowMs
    },
  }

  return {checkpoints, clock, dependencies, logs, runtime}
}

test('idle WAL checkpoints are on only where DuckDB auto-checkpoints are deferred, with a 64 MiB / 60 s default', () => {
  expect(getDuckdbWalCheckpointPolicyConfig({autoCheckpointDeferred: true, envValues: {}})).toEqual({
    enabled: true,
    minIntervalMs: 60_000,
    pollIntervalMs: 10_000,
    walThresholdBytes: 64 * mebibyte,
  })
  expect(duckdbWalCheckpointDefaultThresholdBytes).toBe(64 * mebibyte)
  expect(duckdbWalCheckpointDefaultMinIntervalMs).toBe(60_000)
  expect(getDuckdbWalCheckpointPolicyConfig({autoCheckpointDeferred: false, envValues: {}}).enabled).toBe(false)
  expect(
    getDuckdbWalCheckpointPolicyConfig({
      autoCheckpointDeferred: true,
      envValues: {FORSKA_DUCKDB_WAL_CHECKPOINT_THRESHOLD_BYTES: '0'},
    }).enabled,
  ).toBe(false)
  expect(
    getDuckdbWalCheckpointPolicyConfig({
      autoCheckpointDeferred: true,
      envValues: {
        FORSKA_DUCKDB_WAL_CHECKPOINT_MIN_INTERVAL_MS: '120000',
        FORSKA_DUCKDB_WAL_CHECKPOINT_POLL_INTERVAL_MS: 'soon',
        FORSKA_DUCKDB_WAL_CHECKPOINT_THRESHOLD_BYTES: String(128 * mebibyte),
      },
    }),
  ).toEqual({enabled: true, minIntervalMs: 120_000, pollIntervalMs: 10_000, walThresholdBytes: 128 * mebibyte})
})

test('the checkpoint decision needs an open runtime, a WAL above the threshold, the min interval and no write in flight', () => {
  const decide = (runtimeState: DuckdbWalCheckpointRuntimeState, lastAttemptAtMs: number | null = null) => {
    return getDuckdbWalCheckpointDecision({config, lastAttemptAtMs, nowMs: 100_000, runtimeState})
  }
  const overThreshold = 64 * mebibyte + 1

  expect(decide({runtimeOpen: false, writesInFlight: false, walBytes: overThreshold})).toEqual({
    action: 'skip',
    reason: 'runtime-closed',
  })
  expect(decide({runtimeOpen: true, writesInFlight: false, walBytes: 64 * mebibyte})).toEqual({
    action: 'skip',
    reason: 'below-threshold',
  })
  expect(decide({runtimeOpen: true, writesInFlight: false, walBytes: null})).toEqual({
    action: 'skip',
    reason: 'below-threshold',
  })
  expect(decide({runtimeOpen: true, writesInFlight: false, walBytes: overThreshold}, 40_001)).toEqual({
    action: 'skip',
    reason: 'min-interval',
  })
  expect(decide({runtimeOpen: true, writesInFlight: true, walBytes: overThreshold}, 40_000)).toEqual({
    action: 'skip',
    reason: 'writes-in-flight',
  })
  expect(decide({runtimeOpen: true, writesInFlight: false, walBytes: overThreshold}, 40_000)).toEqual({
    action: 'checkpoint',
  })
})

test('a tick checkpoints an oversized WAL with no write in flight and logs the before and after sizes', async () => {
  const harness = createHarness({runtimeOpen: true, writesInFlight: false, walBytes: 96 * mebibyte})

  const state = await runDuckdbWalCheckpointTick(harness.dependencies, config, initialDuckdbWalCheckpointSchedulerState)

  expect(harness.checkpoints).toEqual([1_000_000])
  expect(state).toEqual({busySinceMs: null, lastAttemptAtMs: 1_000_000, lastDeferredLogAtMs: null})
  expect(harness.logs).toHaveLength(1)
  expect(harness.logs[0]).toMatchObject({
    attrs: {durationMs: 750, walBytesAfter: 0, walBytesBefore: 96 * mebibyte, walThresholdBytes: 64 * mebibyte},
    event: 'duckdb.wal-checkpoint.completed',
    severity: 'INFO',
  })
})

test('a write in flight defers the checkpoint and only logs after five minutes of continuous deferral', async () => {
  const harness = createHarness({runtimeOpen: true, writesInFlight: true, walBytes: 200 * mebibyte})
  const first = await runDuckdbWalCheckpointTick(harness.dependencies, config, initialDuckdbWalCheckpointSchedulerState)

  harness.clock.nowMs += duckdbWalCheckpointDeferredLogIntervalMs - 1
  const beforeLog = await runDuckdbWalCheckpointTick(harness.dependencies, config, first)

  harness.clock.nowMs += 1
  const logged = await runDuckdbWalCheckpointTick(harness.dependencies, config, beforeLog)

  harness.clock.nowMs += 10_000
  const afterLog = await runDuckdbWalCheckpointTick(harness.dependencies, config, logged)

  expect(harness.checkpoints).toEqual([])
  expect(first.busySinceMs).toBe(1_000_000)
  expect(
    harness.logs.map((entry) => {
      return entry.event
    }),
  ).toEqual(['duckdb.wal-checkpoint.deferred'])
  expect(harness.logs[0]?.attrs).toMatchObject({busyForMs: duckdbWalCheckpointDeferredLogIntervalMs})
  expect(afterLog.lastDeferredLogAtMs).toBe(logged.lastDeferredLogAtMs)

  harness.runtime.state = {...harness.runtime.state, writesInFlight: false}
  harness.clock.nowMs += 10_000
  const checkpointed = await runDuckdbWalCheckpointTick(harness.dependencies, config, afterLog)

  expect(harness.checkpoints).toHaveLength(1)
  expect(checkpointed.busySinceMs).toBeNull()
})

test('a transaction opened before the checkpoint turn makes the attempt a deferral, not a min-interval wait', async () => {
  const harness = createHarness({runtimeOpen: true, writesInFlight: false, walBytes: 96 * mebibyte})
  harness.dependencies.checkpoint = async () => {
    return 'skipped-writes-in-flight'
  }

  const state = await runDuckdbWalCheckpointTick(harness.dependencies, config, initialDuckdbWalCheckpointSchedulerState)

  expect(state).toEqual({busySinceMs: 1_000_000, lastAttemptAtMs: null, lastDeferredLogAtMs: null})
  expect(harness.logs).toEqual([])
})

test('a failed checkpoint is logged and retried only after the min interval', async () => {
  const harness = createHarness({runtimeOpen: true, writesInFlight: false, walBytes: 96 * mebibyte})
  harness.dependencies.checkpoint = async () => {
    throw new Error('TransactionContext Error: Cannot CHECKPOINT: there are other write transactions active.')
  }

  const failed = await runDuckdbWalCheckpointTick(
    harness.dependencies,
    config,
    initialDuckdbWalCheckpointSchedulerState,
  )
  harness.clock.nowMs += config.minIntervalMs - 1
  const waiting = await runDuckdbWalCheckpointTick(harness.dependencies, config, failed)

  expect(
    harness.logs.map((entry) => {
      return entry.event
    }),
  ).toEqual(['duckdb.wal-checkpoint.failed'])
  expect(harness.logs[0]?.severity).toBe('WARN')
  expect(harness.logs[0]?.attrs.error).toContain('Cannot CHECKPOINT')
  expect(waiting.lastAttemptAtMs).toBe(failed.lastAttemptAtMs)
})

test('the scheduler polls on its interval, never overlaps ticks and stops cleanly', async () => {
  const harness = createHarness({runtimeOpen: true, writesInFlight: false, walBytes: 96 * mebibyte})
  const release = Promise.withResolvers<undefined>()
  const checkpointStarts: number[] = []
  harness.dependencies.checkpoint = async () => {
    checkpointStarts.push(Date.now())
    await release.promise
    return 'completed'
  }

  const stop = startDuckdbWalCheckpointScheduler(harness.dependencies, {...config, minIntervalMs: 0, pollIntervalMs: 5})
  await globalThis.Bun.sleep(40)

  expect(checkpointStarts).toHaveLength(1)

  stop()
  release.resolve(undefined)
  await globalThis.Bun.sleep(20)

  expect(checkpointStarts).toHaveLength(1)
  expect(harness.logs[0]?.event).toBe('duckdb.wal-checkpoint.scheduler-started')
})
