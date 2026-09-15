import {expect, test} from 'bun:test'

import {isExpectedNvidiaSmiTelemetryUnavailable} from './nvidiaSmiErrors.ts'

test('nvidia-smi telemetry treats closed worker SSH as unavailable telemetry', () => {
  expect(isExpectedNvidiaSmiTelemetryUnavailable('Connection closed by 10.150.5.255 port 22')).toBe(true)
})

test('nvidia-smi telemetry still reports unexpected command failures', () => {
  expect(isExpectedNvidiaSmiTelemetryUnavailable('permission denied reading GPU inventory')).toBe(false)
})
