import {afterEach, expect, test} from 'bun:test'

import {registerServerShutdownSignalHandlers, type ServerShutdownSignal} from './serverShutdownSignals.ts'
import {
  getServerShutdownSignal,
  isServerShutdownInProgress,
  resetServerShutdownStateForTests,
} from './serverShutdownState.ts'

const createSignalSource = () => {
  const listeners = new Map<ServerShutdownSignal, Array<() => void>>()

  return {
    emit: (signal: ServerShutdownSignal) => {
      ;(listeners.get(signal) ?? []).map((listener) => {
        return listener()
      })
    },
    listenerCount: (signal: ServerShutdownSignal) => {
      return listeners.get(signal)?.length ?? 0
    },
    on: (signal: ServerShutdownSignal, listener: () => void) => {
      listeners.set(signal, [...(listeners.get(signal) ?? []), listener])
    },
  }
}

const createShutdownHarness = (forceExitAfterMs = 60_000) => {
  const shutdown = Promise.withResolvers<undefined>()
  const exits: number[] = []
  const events: string[] = []
  const shutdownSignals: ServerShutdownSignal[] = []
  const signalSource = createSignalSource()

  return {
    events,
    exits,
    input: {
      exit: (code: number) => {
        exits.push(code)
      },
      forceExitAfterMs,
      log: (entry: {event: string}) => {
        events.push(entry.event)
      },
      runShutdown: async (signal: ServerShutdownSignal) => {
        shutdownSignals.push(signal)
        return shutdown.promise
      },
      signalSource,
    },
    shutdown,
    shutdownSignals,
    signalSource,
  }
}

afterEach(() => {
  resetServerShutdownStateForTests()
})

test('the first shutdown signal runs graceful shutdown once and exits 0 only after it finishes', async () => {
  const harness = createShutdownHarness()

  expect(registerServerShutdownSignalHandlers(harness.input)).toBe(true)
  harness.signalSource.emit('SIGTERM')

  expect(isServerShutdownInProgress()).toBe(true)
  expect(getServerShutdownSignal()).toBe('SIGTERM')
  expect(harness.shutdownSignals).toEqual(['SIGTERM'])
  await globalThis.Bun.sleep(1)
  expect(harness.exits).toEqual([])

  harness.shutdown.resolve(undefined)
  await globalThis.Bun.sleep(1)

  expect(harness.exits).toEqual([0])
})

test('repeated SIGTERM and SIGINT during shutdown are ignored instead of aborting the checkpoint', async () => {
  const harness = createShutdownHarness()

  registerServerShutdownSignalHandlers(harness.input)
  harness.signalSource.emit('SIGINT')
  harness.signalSource.emit('SIGTERM')
  harness.signalSource.emit('SIGINT')
  await globalThis.Bun.sleep(1)

  expect(harness.shutdownSignals).toEqual(['SIGINT'])
  expect(harness.exits).toEqual([])
  expect(harness.events).toEqual(['server.shutdown.signal-ignored', 'server.shutdown.signal-ignored'])

  harness.shutdown.resolve(undefined)
  await globalThis.Bun.sleep(1)

  expect(harness.exits).toEqual([0])
})

test('a failed graceful shutdown exits 1', async () => {
  const harness = createShutdownHarness()

  registerServerShutdownSignalHandlers(harness.input)
  harness.signalSource.emit('SIGTERM')
  harness.shutdown.reject(new Error('close failed'))
  await globalThis.Bun.sleep(1)

  expect(harness.exits).toEqual([1])
  expect(harness.events).toEqual(['server.shutdown.failure'])
})

test('a graceful shutdown that never finishes is force-exited after its overall budget', async () => {
  const harness = createShutdownHarness(20)

  registerServerShutdownSignalHandlers(harness.input)
  harness.signalSource.emit('SIGTERM')
  await globalThis.Bun.sleep(60)

  expect(harness.exits).toEqual([1])
  expect(harness.events).toEqual(['server.shutdown.force-exit'])
})

test('signal handlers register once per process', () => {
  const harness = createShutdownHarness()

  expect(registerServerShutdownSignalHandlers(harness.input)).toBe(true)
  expect(registerServerShutdownSignalHandlers(harness.input)).toBe(false)
  expect(harness.signalSource.listenerCount('SIGTERM')).toBe(1)
  expect(harness.signalSource.listenerCount('SIGINT')).toBe(1)
})
