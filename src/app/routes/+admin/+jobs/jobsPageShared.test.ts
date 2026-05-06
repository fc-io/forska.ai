import {expect, test} from 'bun:test'

import {
  formatNumber,
  formatStatus,
  formatTelemetryRatio,
  getAllocationStateLabel,
  getEndpointProbeStateLabel,
  getJobRiskScore,
  getJudgmentsJobsRefetchInterval,
  getObservedAggregateTelemetryDescription,
  getObservedAggregateTelemetryLabel,
  getProviderBottleneckDescription,
  getProviderBottleneckLabel,
  getTelemetryCoverageSummary,
  jobMatchesHealthFilter,
  type JudgmentsJobListItem,
} from './jobsPageShared'

const buildListJob = (overrides: Partial<JudgmentsJobListItem>): JudgmentsJobListItem => {
  return {
    health: {badges: ['Healthy']},
    status: 'completed',
    storageState: 'active',
    ...overrides,
  } as JudgmentsJobListItem
}

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

test('list page helpers preserve status labels and active job polling behavior', () => {
  expect(formatStatus('waiting_on_llm_connection')).toBe('Waiting On Llm Connection')
  expect(formatStatus('paused')).toBe('Paused')
  expect(formatNumber(1234567)).toBe('1,234,567')
  expect(getJudgmentsJobsRefetchInterval([buildListJob({status: 'running'})])).toBe(30 * 1000)
  expect(getJudgmentsJobsRefetchInterval([buildListJob({status: 'completed'})])).toBe(60 * 1000)
})

test('list page health helpers keep risky filters and scores stable', () => {
  const job = buildListJob({health: {badges: ['Draining', 'Large WAL', 'Retained Outbox']}, storageState: 'draining'})

  expect(jobMatchesHealthFilter(job, 'draining')).toBe(true)
  expect(jobMatchesHealthFilter(job, 'largeWal')).toBe(true)
  expect(jobMatchesHealthFilter(job, 'retainedOutbox')).toBe(true)
  expect(jobMatchesHealthFilter(job, 'quarantined')).toBe(false)
  expect(getJobRiskScore(job)).toBe(11)
})
