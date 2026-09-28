import {afterEach, expect, test} from 'bun:test'

import {
  getProcessMemoryBudgetUsage,
  getProcessMemoryBytes,
  getProcessMemoryPressureBytes,
  getProcessMemoryUsageSample,
  isProcessMemoryAtCap,
  markDuckdbMemoryReleased,
  recordDuckdbMemoryUsage,
  resetDuckdbMemoryUsageForTests,
} from './processMemoryPressure.ts'

const gibibyte = 1024 ** 3

afterEach(() => {
  resetDuckdbMemoryUsageForTests()
})

test('the process memory figure is the physical footprint on macOS and RSS elsewhere', () => {
  const rssBytes = process.memoryUsage().rss
  const sample = getProcessMemoryUsageSample()

  if (process.platform !== 'darwin') {
    expect(sample).toBeNull()
    expect(getProcessMemoryBytes(rssBytes)).toBe(rssBytes)

    return
  }

  expect(sample).not.toBeNull()
  expect(Math.abs((sample?.residentBytes ?? 0) - rssBytes)).toBeLessThan(4 * 1024 ** 2)

  const processBytes = getProcessMemoryBytes(rssBytes)
  const footprintBytes = getProcessMemoryUsageSample()?.physFootprintBytes ?? -1

  expect(Math.abs(processBytes - footprintBytes)).toBeLessThan(4 * 1024 ** 2)
})

test('an RSS reading that does not match the resident size is kept as it is', () => {
  expect(getProcessMemoryBytes(200)).toBe(200)
  expect(getProcessMemoryBytes(64 * 1024 ** 4)).toBe(64 * 1024 ** 4)
})

test('with a DuckDB sample, only the app memory next to the allowance counts against the cap', () => {
  const nowMs = Date.now()

  recordDuckdbMemoryUsage({limitBytes: 16 * gibibyte, nowMs, trackedBytes: 16 * gibibyte})

  const duckdbAtCeiling = getProcessMemoryBudgetUsage(19 * gibibyte, nowMs)

  expect(duckdbAtCeiling).toEqual({
    appBytes: 3 * gibibyte,
    duckdbLimitBytes: 16 * gibibyte,
    duckdbTrackedBytes: 16 * gibibyte,
    processBytes: 19 * gibibyte,
  })
  expect(getProcessMemoryPressureBytes(duckdbAtCeiling)).toBe(19 * gibibyte)
  expect(isProcessMemoryAtCap(20 * gibibyte, 1, duckdbAtCeiling)).toBe(false)
  expect(isProcessMemoryAtCap(20 * gibibyte, 0.7, duckdbAtCeiling)).toBe(true)

  recordDuckdbMemoryUsage({limitBytes: 16 * gibibyte, nowMs, trackedBytes: 2 * gibibyte})

  const appGrewWhileDuckdbIdle = getProcessMemoryBudgetUsage(8 * gibibyte, nowMs)

  expect(appGrewWhileDuckdbIdle.appBytes).toBe(6 * gibibyte)
  expect(getProcessMemoryPressureBytes(appGrewWhileDuckdbIdle)).toBe(22 * gibibyte)
  expect(isProcessMemoryAtCap(20 * gibibyte, 1, appGrewWhileDuckdbIdle)).toBe(true)
})

test('caps below the DuckDB allowance and stale samples compare the whole process', () => {
  const nowMs = Date.now()

  recordDuckdbMemoryUsage({limitBytes: 4 * gibibyte, nowMs, trackedBytes: 2 * gibibyte})

  const lowMemory = getProcessMemoryBudgetUsage(3 * gibibyte, nowMs)

  expect(isProcessMemoryAtCap(3 * gibibyte, 1, lowMemory)).toBe(true)
  expect(getProcessMemoryBudgetUsage(3 * gibibyte, nowMs + 3 * 60_000)).toEqual({
    appBytes: null,
    duckdbLimitBytes: null,
    duckdbTrackedBytes: null,
    processBytes: 3 * gibibyte,
  })
})

test('closing DuckDB drops its tracked share so the app is judged on the whole process', () => {
  const nowMs = Date.now()

  recordDuckdbMemoryUsage({limitBytes: 16 * gibibyte, nowMs, trackedBytes: 10 * gibibyte})
  markDuckdbMemoryReleased(nowMs)

  expect(getProcessMemoryBudgetUsage(12 * gibibyte, nowMs).appBytes).toBe(12 * gibibyte)
})
