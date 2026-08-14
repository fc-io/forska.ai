import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

test('provider admission lease heartbeat keeps only one owner request in flight', () => {
  const source = readFileSync(new URL('./judgmentsRequestRuntime.ts', import.meta.url), 'utf8')
  const heartbeatStart = source.indexOf('const startProviderRequestAdmissionLeaseHeartbeat')
  const heartbeatEnd = source.indexOf('const acquireProviderProbeAdmissionLease', heartbeatStart)
  const heartbeatSource = source.slice(heartbeatStart, heartbeatEnd)

  expect(heartbeatStart).toBeGreaterThanOrEqual(0)
  expect(heartbeatEnd).toBeGreaterThan(heartbeatStart)
  expect(heartbeatSource).toContain('if (heartbeatInFlight)')
  expect(heartbeatSource).toContain('heartbeatInFlight = true')
  expect(heartbeatSource.slice(heartbeatSource.indexOf('.finally'))).toContain('heartbeatInFlight = false')
})
