import {expect, test} from 'bun:test'

import {
  formatTelemetryRatio,
  getAllocationStateLabel,
  getEndpointProbeStateLabel,
  getObservedAggregateTelemetryDescription,
  getObservedAggregateTelemetryLabel,
  getProviderBottleneckDescription,
  getProviderBottleneckLabel,
  getTelemetryCoverageSummary,
} from './jobsPageShared'

test('provider telemetry labels explain the required admin bottleneck states', () => {
  expect(getProviderBottleneckLabel('claiming')).toBe('Underfed provider: claiming backlog')
  expect(getProviderBottleneckDescription('claiming')).toContain('local prompt or request-work backlog')
  expect(getProviderBottleneckLabel('endpointUnavailable')).toBe('Endpoint unavailable: claiming held')
  expect(getProviderBottleneckDescription('endpointUnavailable')).toContain('endpoint probe')
  expect(getProviderBottleneckLabel('providerAtTarget')).toBe('Provider at target')
  expect(getProviderBottleneckDescription('providerAtTarget')).toContain('allocated target')
  expect(getProviderBottleneckLabel('providerSaturated')).toBe('Provider saturated')
  expect(getProviderBottleneckDescription('providerSaturated')).toContain('Physical leased calls')
  expect(getProviderBottleneckLabel('completionPersistence')).toBe('Completion persistence')
  expect(getProviderBottleneckDescription('completionPersistence')).toContain('durable closeout')
})

test('observed aggregate labels surface best-effort partial and unavailable coverage', () => {
  const partialSource = {
    aggregateCompleteness: 'partial' as const,
    freshWorkerCount: 1,
    staleWorkerCount: 2,
    unavailableWorkerCount: 3,
  }
  const unavailableSource = {
    aggregateCompleteness: 'unavailable' as const,
    freshWorkerCount: 0,
    staleWorkerCount: 0,
    unavailableWorkerCount: 2,
  }

  expect(getObservedAggregateTelemetryLabel(partialSource)).toBe('Observed aggregates: best-effort partial')
  expect(getObservedAggregateTelemetryDescription(partialSource)).toContain('partial best-effort observations')
  expect(getTelemetryCoverageSummary(partialSource)).toBe('fresh 1, stale 2, unavailable 3')
  expect(getObservedAggregateTelemetryLabel(unavailableSource)).toBe('Observed aggregates: best-effort unavailable')
  expect(getObservedAggregateTelemetryDescription(unavailableSource)).toContain('local best-effort observations only')
})

test('capacity helper labels keep request leases separate from endpoint probes and allocation state', () => {
  expect(formatTelemetryRatio(3, 7)).toBe('3 / 7')
  expect(getEndpointProbeStateLabel('probing')).toBe('Probe running')
  expect(getAllocationStateLabel({allocationCompleteCurrent: true, allocationInputState: 'complete'})).toBe(
    'Allocation current (Complete)',
  )
  expect(
    getAllocationStateLabel({allocationCompleteCurrent: false, allocationInputState: 'partialRemoteTelemetry'}),
  ).toBe('Allocation incomplete (Partial Remote Telemetry)')
})
