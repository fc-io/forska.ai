import {expect, test} from 'bun:test'

import {
  duckdbGracefulShutdownDefaultTimeouts,
  type DuckdbGracefulShutdownDependencies,
  type DuckdbGracefulShutdownLogEntry,
  type DuckdbGracefulShutdownOptions,
  getDuckdbGracefulShutdownBudgetMs,
  getDuckdbGracefulShutdownTimeouts,
  runDuckdbGracefulShutdown,
} from './duckdbGracefulShutdown.ts'

type ShutdownScenario = {
  busyUntilMs?: number
  checkpoint?: (clock: {nowMs: number}, attempt: number) => Promise<void>
  idleAfterInterrupt?: boolean
  runtimeOpen?: boolean
  walBytesAfterCheckpoint?: number
}

type FakeTimer = {atMs: number; resolve: () => void}

const createFakeClock = () => {
  const clock = {nowMs: 0}
  const timers: FakeTimer[] = []
  const fireEarliestTimer = () => {
    const [earliestTimer] = [...timers].sort((left, right) => {
      return left.atMs - right.atMs
    })

    if (earliestTimer === undefined) {
      return
    }

    timers.splice(timers.indexOf(earliestTimer), 1)
    clock.nowMs = Math.max(clock.nowMs, earliestTimer.atMs)
    earliestTimer.resolve()
  }

  return {
    clock,
    wait: (ms: number) => {
      return new Promise<void>((resolve) => {
        timers.push({atMs: clock.nowMs + ms, resolve})
        setTimeout(fireEarliestTimer, 0)
      })
    },
  }
}

const shutdownOptions: DuckdbGracefulShutdownOptions = {
  checkpointRetryIntervalMs: 500,
  checkpointTimeoutMs: 120_000,
  drainTimeoutMs: 45_000,
  pollIntervalMs: 1_000,
  rollbackTimeoutMs: 15_000,
  shouldCheckpoint: true,
  signal: 'SIGTERM',
}

const createShutdownHarness = (scenario: ShutdownScenario = {}) => {
  const {clock, wait} = createFakeClock()
  const calls: string[] = []
  const logs: DuckdbGracefulShutdownLogEntry[] = []
  const state = {admissionClosed: false, checkpointAttempts: 0, checkpointed: false, interrupted: false}
  const isIdle = () => {
    return state.interrupted ? (scenario.idleAfterInterrupt ?? true) : clock.nowMs >= (scenario.busyUntilMs ?? 0)
  }
  const dependencies: DuckdbGracefulShutdownDependencies = {
    checkpoint: async () => {
      state.checkpointAttempts += 1
      calls.push(`checkpoint@${clock.nowMs}:admission-closed=${state.admissionClosed}`)
      await (scenario.checkpoint?.(clock, state.checkpointAttempts) ?? Promise.resolve())
      state.checkpointed = true
    },
    closeActiveConnections: () => {
      calls.push(`close-connections@${clock.nowMs}`)
    },
    closeRuntime: async ({closeNative}) => {
      calls.push(`close:native=${closeNative}`)
    },
    closeStatementAdmission: () => {
      state.admissionClosed = true
      calls.push(`close-admission@${clock.nowMs}`)
    },
    getWalBytes: () => {
      return state.checkpointed ? (scenario.walBytesAfterCheckpoint ?? 0) : 4096
    },
    interruptActiveWork: () => {
      state.interrupted = true
      calls.push(`interrupt@${clock.nowMs}`)
    },
    isIdle,
    isRuntimeOpen: () => {
      return scenario.runtimeOpen ?? true
    },
    log: (entry) => {
      logs.push(entry)
    },
    now: () => {
      return clock.nowMs
    },
    stopBackgroundWork: () => {
      calls.push('stop-background-work')
      return []
    },
    wait,
  }

  return {calls, clock, dependencies, logs}
}

const getLogEvents = (logs: DuckdbGracefulShutdownLogEntry[]) => {
  return logs.map((entry) => {
    return entry.event
  })
}

test('graceful shutdown stops background work, checkpoints an idle runtime and closes it natively', async () => {
  const harness = createShutdownHarness()

  const result = await runDuckdbGracefulShutdown(harness.dependencies, shutdownOptions)

  expect(result).toEqual({checkpoint: 'completed', checkpointAttempts: 1, drain: 'idle', walBytes: 0})
  expect(harness.calls).toEqual([
    'stop-background-work',
    'close-admission@0',
    'close-connections@0',
    'checkpoint@0:admission-closed=true',
    'close:native=true',
  ])
  expect(getLogEvents(harness.logs)).toEqual([
    'duckdb.shutdown.started',
    'duckdb.shutdown.checkpointed',
    'duckdb.shutdown.completed',
  ])
  expect(harness.logs[1]?.attrs).toMatchObject({checkpoint: 'completed', drain: 'idle', walBytes: 0})
})

test('graceful shutdown waits for an open transaction to finish inside the drain budget without interrupting it', async () => {
  const harness = createShutdownHarness({busyUntilMs: 15_000})

  const result = await runDuckdbGracefulShutdown(harness.dependencies, shutdownOptions)

  expect(result.drain).toBe('idle')
  expect(harness.calls).toEqual([
    'stop-background-work',
    'close-admission@15000',
    'close-connections@15000',
    'checkpoint@15000:admission-closed=true',
    'close:native=true',
  ])
})

test('graceful shutdown interrupts work still running at the drain deadline and checkpoints after rollback', async () => {
  const harness = createShutdownHarness({busyUntilMs: Number.POSITIVE_INFINITY, idleAfterInterrupt: true})

  const result = await runDuckdbGracefulShutdown(harness.dependencies, shutdownOptions)

  expect(result).toEqual({checkpoint: 'completed', checkpointAttempts: 1, drain: 'interrupted', walBytes: 0})
  expect(harness.calls).toEqual([
    'stop-background-work',
    'close-admission@45000',
    'interrupt@45000',
    'close-connections@45000',
    'checkpoint@45000:admission-closed=true',
    'close:native=true',
  ])
  expect(getLogEvents(harness.logs)).toContain('duckdb.shutdown.interrupting')
})

test('graceful shutdown closes connections and checkpoints when interrupted work never rolls back', async () => {
  const harness = createShutdownHarness({busyUntilMs: Number.POSITIVE_INFINITY, idleAfterInterrupt: false})

  const result = await runDuckdbGracefulShutdown(harness.dependencies, shutdownOptions)

  expect(result).toEqual({checkpoint: 'completed', checkpointAttempts: 1, drain: 'busy', walBytes: 0})
  expect(harness.calls).toEqual([
    'stop-background-work',
    'close-admission@45000',
    'interrupt@45000',
    'close-connections@60000',
    'checkpoint@60000:admission-closed=true',
    'close:native=true',
  ])
})

test('graceful shutdown retries a checkpoint blocked by another write transaction until it succeeds', async () => {
  const harness = createShutdownHarness({
    checkpoint: async (_clock, attempt) => {
      if (attempt < 3) {
        throw new Error('TransactionContext Error: Cannot CHECKPOINT: there are other write transactions active.')
      }
    },
  })

  const result = await runDuckdbGracefulShutdown(harness.dependencies, shutdownOptions)

  expect(result).toEqual({checkpoint: 'completed', checkpointAttempts: 3, drain: 'idle', walBytes: 0})
  expect(
    harness.calls.filter((call) => {
      return call.startsWith('checkpoint@')
    }),
  ).toEqual([
    'checkpoint@0:admission-closed=true',
    'checkpoint@500:admission-closed=true',
    'checkpoint@1000:admission-closed=true',
  ])
})

test('graceful shutdown stops retrying a blocked checkpoint at the checkpoint deadline', async () => {
  const harness = createShutdownHarness({
    checkpoint: async () => {
      throw new Error('TransactionContext Error: Cannot CHECKPOINT: there are other write transactions active.')
    },
  })

  const result = await runDuckdbGracefulShutdown(harness.dependencies, {...shutdownOptions, checkpointTimeoutMs: 2_000})

  expect(result).toMatchObject({checkpoint: 'failed', checkpointAttempts: 4, walBytes: 4096})
  expect(harness.calls.at(-1)).toBe('close:native=true')
})

test('graceful shutdown gives up on a checkpoint at its timeout and skips the blocking native close', async () => {
  const harness = createShutdownHarness({
    checkpoint: () => {
      return new Promise(() => {})
    },
  })

  const result = await runDuckdbGracefulShutdown(harness.dependencies, shutdownOptions)

  expect(result).toEqual({checkpoint: 'timed-out', checkpointAttempts: 1, drain: 'idle', walBytes: 4096})
  expect(harness.calls.at(-1)).toBe('close:native=false')
  expect(harness.clock.nowMs).toBe(120_000)
  expect(
    harness.logs.find((entry) => {
      return entry.event === 'duckdb.shutdown.checkpoint-timed-out'
    })?.severity,
  ).toBe('WARN')
})

test('graceful shutdown logs a failed checkpoint and still closes the runtime', async () => {
  const harness = createShutdownHarness({
    checkpoint: async () => {
      throw new Error('checkpoint exploded')
    },
  })

  const result = await runDuckdbGracefulShutdown(harness.dependencies, shutdownOptions)

  expect(result).toMatchObject({checkpoint: 'failed', checkpointAttempts: 1})
  expect(harness.calls.at(-1)).toBe('close:native=true')
  expect(
    harness.logs.find((entry) => {
      return entry.event === 'duckdb.shutdown.checkpoint-failed'
    })?.attrs.error,
  ).toEqual(new Error('checkpoint exploded'))
})

test('graceful shutdown skips the checkpoint for a closed runtime and for the low-memory runtime', async () => {
  const closedHarness = createShutdownHarness({runtimeOpen: false})
  const lowMemoryHarness = createShutdownHarness()

  const closedResult = await runDuckdbGracefulShutdown(closedHarness.dependencies, shutdownOptions)
  const lowMemoryResult = await runDuckdbGracefulShutdown(lowMemoryHarness.dependencies, {
    ...shutdownOptions,
    shouldCheckpoint: false,
  })

  expect(closedResult.checkpoint).toBe('skipped')
  expect(lowMemoryResult.checkpoint).toBe('skipped')
  expect(closedHarness.calls).toEqual(['stop-background-work', 'close-admission@0', 'close:native=true'])
  expect(lowMemoryHarness.calls).toEqual(['stop-background-work', 'close-admission@0', 'close:native=true'])
  expect(
    closedHarness.logs.find((entry) => {
      return entry.event === 'duckdb.shutdown.checkpoint-skipped'
    })?.attrs,
  ).toMatchObject({skipReason: 'runtime-closed'})
  expect(
    lowMemoryHarness.logs.find((entry) => {
      return entry.event === 'duckdb.shutdown.checkpoint-skipped'
    })?.attrs,
  ).toMatchObject({skipReason: 'low-memory-runtime'})
})

test('graceful shutdown timeouts default to 45s drain, 15s rollback and 120s checkpoint and accept env overrides', () => {
  expect(getDuckdbGracefulShutdownTimeouts({})).toEqual(duckdbGracefulShutdownDefaultTimeouts)
  expect(getDuckdbGracefulShutdownBudgetMs(duckdbGracefulShutdownDefaultTimeouts)).toBe(180_000)
  expect(
    getDuckdbGracefulShutdownTimeouts({
      FORSKA_DUCKDB_SHUTDOWN_CHECKPOINT_TIMEOUT_MS: '600000',
      FORSKA_DUCKDB_SHUTDOWN_DRAIN_TIMEOUT_MS: '0',
      FORSKA_DUCKDB_SHUTDOWN_ROLLBACK_TIMEOUT_MS: '250',
    }),
  ).toEqual({
    checkpointRetryIntervalMs: 500,
    checkpointTimeoutMs: 600_000,
    drainTimeoutMs: 0,
    pollIntervalMs: 100,
    rollbackTimeoutMs: 250,
  })
  expect(
    getDuckdbGracefulShutdownTimeouts({
      FORSKA_DUCKDB_SHUTDOWN_CHECKPOINT_TIMEOUT_MS: 'soon',
      FORSKA_DUCKDB_SHUTDOWN_DRAIN_TIMEOUT_MS: '-1',
      FORSKA_DUCKDB_SHUTDOWN_ROLLBACK_TIMEOUT_MS: '1.5',
    }),
  ).toEqual(duckdbGracefulShutdownDefaultTimeouts)
})
