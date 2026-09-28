import {expect, test} from 'bun:test'

import {getProcessMemoryPressureBytes, getProcessMemoryUsageSample} from './processMemoryPressure.ts'

test('memory pressure uses the physical footprint on macOS and RSS elsewhere', () => {
  const rssBytes = process.memoryUsage().rss
  const sample = getProcessMemoryUsageSample()

  if (process.platform !== 'darwin') {
    expect(sample).toBeNull()
    expect(getProcessMemoryPressureBytes(rssBytes)).toBe(rssBytes)

    return
  }

  expect(sample).not.toBeNull()
  expect(Math.abs((sample?.residentBytes ?? 0) - rssBytes)).toBeLessThan(4 * 1024 ** 2)
  const pressureBytes = getProcessMemoryPressureBytes(rssBytes)
  const footprintBytes = getProcessMemoryUsageSample()?.physFootprintBytes ?? -1

  expect(Math.abs(pressureBytes - footprintBytes)).toBeLessThan(4 * 1024 ** 2)
})

test('an RSS reading that does not match the resident size is kept as it is', () => {
  expect(getProcessMemoryPressureBytes(200)).toBe(200)
  expect(getProcessMemoryPressureBytes(64 * 1024 ** 4)).toBe(64 * 1024 ** 4)
})
