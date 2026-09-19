import {expect, test} from 'bun:test'

import {waitForDevServerWatchRestartGate} from './devServerWatchRestartGate.ts'

type GateScenario = {aliveSequence: boolean[]; readySequence: boolean[]}

const createGateHarness = (scenario: GateScenario) => {
  const logs: string[] = []
  const waits: number[] = []
  let clockMs = 0
  let aliveIndex = 0
  let readyIndex = 0

  return {
    dependencies: {
      isMaintenanceReady: async () => {
        const value = scenario.readySequence[Math.min(readyIndex, scenario.readySequence.length - 1)] ?? false
        readyIndex += 1
        return value
      },
      isStackAlive: () => {
        const value = scenario.aliveSequence[Math.min(aliveIndex, scenario.aliveSequence.length - 1)] ?? false
        aliveIndex += 1
        return value
      },
      log: (message: string) => {
        logs.push(message)
      },
      now: () => {
        return clockMs
      },
      wait: async (ms: number) => {
        waits.push(ms)
        clockMs += ms
      },
    },
    logs,
    waits,
  }
}

test('restart gate returns immediately when the maintenance worker is already ready', async () => {
  const harness = createGateHarness({aliveSequence: [true], readySequence: [true]})

  const result = await waitForDevServerWatchRestartGate(harness.dependencies, {pollIntervalMs: 1_000, timeoutMs: 5_000})

  expect(result).toBe('ready')
  expect(harness.waits).toEqual([])
  expect(harness.logs).toEqual([])
})

test('restart gate waits until the maintenance worker reports ready', async () => {
  const harness = createGateHarness({aliveSequence: [true], readySequence: [false, false, true]})

  const result = await waitForDevServerWatchRestartGate(harness.dependencies, {pollIntervalMs: 1_000, timeoutMs: 5_000})

  expect(result).toBe('ready')
  expect(harness.waits).toEqual([1_000])
  expect(harness.logs).toHaveLength(1)
  expect(harness.logs[0]).toContain('waiting for the maintenance worker to become ready before restarting')
})

test('restart gate stops waiting when the stack process is gone', async () => {
  const harness = createGateHarness({aliveSequence: [true, true, false], readySequence: [false]})

  const result = await waitForDevServerWatchRestartGate(harness.dependencies, {pollIntervalMs: 500, timeoutMs: 5_000})

  expect(result).toBe('stack-gone')
  expect(harness.waits).toEqual([500])
})

test('restart gate gives up at the timeout boundary', async () => {
  const harness = createGateHarness({aliveSequence: [true], readySequence: [false]})

  const result = await waitForDevServerWatchRestartGate(harness.dependencies, {pollIntervalMs: 1_000, timeoutMs: 2_000})

  expect(result).toBe('timed-out')
  expect(harness.waits).toEqual([1_000, 1_000])
  expect(harness.logs[harness.logs.length - 1]).toBe('server stack did not become ready in time; restarting anyway')
})
