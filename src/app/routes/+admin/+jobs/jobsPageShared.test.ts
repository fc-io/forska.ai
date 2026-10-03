import {expect, test} from 'bun:test'

import {
  buildJobsProviderHealthBanner,
  formatNumber,
  formatProviderFailureMeta,
  formatProviderRecoveryNote,
  formatProviderRetryAfter,
  formatStatus,
  formatTelemetryRatio,
  formatTelemetryUtilization,
  getAllocationStateLabel,
  getEndpointProbeStateLabel,
  getHealthBadgeColor,
  getJobProviderHealth,
  getJobRiskScore,
  getJudgmentsJobsRefetchInterval,
  getObservedAggregateTelemetryDescription,
  getObservedAggregateTelemetryLabel,
  getProviderBottleneckDescription,
  getProviderBottleneckLabel,
  getProviderFailureKindLabel,
  getProviderHealthGuidance,
  getProviderHealthTone,
  getProviderHealthToneClass,
  getProviderTelemetryAdherenceStateLabel,
  getProviderTelemetryBottleneckSummaryLabel,
  getProviderTelemetryHistoryHasSamples,
  getProviderTelemetryHistoryRangeLabel,
  getProviderTelemetryHistoryUtilizationScaleMax,
  getTelemetryCoverageSummary,
  isRecentProviderRecovery,
  isRiskyJudgmentJob,
  type JobHealthBadge,
  jobMatchesHealthFilter,
  type JudgmentJobProviderHealth,
  judgmentProviderTelemetryHistoryRanges,
  type JudgmentsJobListItem,
  truncateProviderFailureMessage,
} from './jobsPageShared'

type ListJobOverrides = Partial<Omit<JudgmentsJobListItem, 'health'>> & {
  health?: {badges: JobHealthBadge[]; isHealthy?: boolean}
  providerHealth?: JudgmentJobProviderHealth | null
}

const buildListJob = (overrides: ListJobOverrides): JudgmentsJobListItem => {
  return {
    health: {badges: ['Healthy'], isHealthy: true},
    providerHealth: null,
    status: 'completed',
    storageState: 'active',
    ...overrides,
  } as JudgmentsJobListItem
}

const codexUsageLimitMessage =
  'codex app-server: turn failed: You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 9:33 PM.'
const localRetryAfterAt = new Date(2026, 9, 3, 21, 33).toISOString()

const buildProviderHealth = (overrides: Partial<JudgmentJobProviderHealth> = {}): JudgmentJobProviderHealth => {
  return {
    consecutiveFailureCount: 3,
    failureCode: 'provider_error',
    failureKind: 'usage_limit',
    failureMessage: codexUsageLimitMessage,
    firstFailedAt: new Date(2026, 9, 3, 5, 0, 0).toISOString(),
    isActive: true,
    jobId: 'job-1',
    lastFailedAt: new Date(2026, 9, 3, 13, 0, 0).toISOString(),
    lastSuccessAt: null,
    modelId: 'model-gpt',
    recoveredAt: null,
    retryAfterAt: localRetryAfterAt,
    status: 'failing',
    totalFailureCount: 7,
    updatedAt: new Date(2026, 9, 3, 13, 0, 0).toISOString(),
    ...overrides,
  }
}

const buildBannerJob = (
  id: string,
  projectName: string | null,
  providerHealth: JudgmentJobProviderHealth | null,
  status = 'running',
) => {
  return {id, projectName, providerHealth, status}
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

test('provider telemetry history labels cover chart range adherence utilization and bottleneck summaries', () => {
  expect(judgmentProviderTelemetryHistoryRanges).toEqual(['5m', '15m', '1h', '24h', '3d'])
  expect(getProviderTelemetryHistoryRangeLabel('5m')).toBe('Last 5 minutes')
  expect(getProviderTelemetryHistoryRangeLabel('24h')).toBe('Last 24 hours')
  expect(getProviderTelemetryAdherenceStateLabel('withinLimit')).toBe('Within limit')
  expect(getProviderTelemetryAdherenceStateLabel('atLimit')).toBe('At limit')
  expect(getProviderTelemetryAdherenceStateLabel('overLimit')).toBe('Over limit')
  expect(getProviderTelemetryAdherenceStateLabel('unknown')).toBe('No samples')
  expect(formatTelemetryUtilization(73.3333)).toBe('73.3%')
  expect(formatTelemetryUtilization(100)).toBe('100%')
  expect(formatTelemetryUtilization(null)).toBe('N/A')
  expect(getProviderTelemetryBottleneckSummaryLabel({bottleneck: 'providerAtTarget', bottleneckSampleCount: 2})).toBe(
    'Provider at target (2 samples)',
  )
  expect(getProviderTelemetryBottleneckSummaryLabel({bottleneck: null, bottleneckSampleCount: 0})).toBe('No bottleneck')
  expect(getProviderTelemetryHistoryHasSamples([{sampleCount: 0}, {sampleCount: 1}])).toBe(true)
  expect(getProviderTelemetryHistoryHasSamples([{sampleCount: 0}, {sampleCount: 0}])).toBe(false)
  expect(
    getProviderTelemetryHistoryUtilizationScaleMax([
      {avgUtilization: 73.3, maxUtilization: 117.2, minUtilization: 60},
      {avgUtilization: null, maxUtilization: null, minUtilization: null},
    ]),
  ).toBe(125)
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

test('provider failing and offline repair badges have colours and provider failing weighs like quarantine', () => {
  const providerFailingJob = buildListJob({health: {badges: ['Provider Failing'], isHealthy: false}})
  const quarantinedJob = buildListJob({health: {badges: ['Quarantined', 'Offline Repair'], isHealthy: false}})

  expect(getHealthBadgeColor('Provider Failing')).toBe('bg-rose-100 text-rose-800 ring-rose-300')
  expect(getHealthBadgeColor('Offline Repair')).toBe('bg-red-50 text-red-700 ring-red-200')
  expect(getJobRiskScore(providerFailingJob)).toBe(16)
  expect(getJobRiskScore(quarantinedJob)).toBe(16)
  expect(isRiskyJudgmentJob(providerFailingJob)).toBe(true)
  expect(isRiskyJudgmentJob(buildListJob({}))).toBe(false)
})

test('provider failure kinds map to labels, tones and guidance', () => {
  expect(getProviderFailureKindLabel('usage_limit')).toBe('Usage limit reached')
  expect(getProviderFailureKindLabel('rate_limited')).toBe('Rate limited')
  expect(getProviderFailureKindLabel('auth')).toBe('Authentication failed')
  expect(getProviderFailureKindLabel('endpoint_unavailable')).toBe('Endpoint unavailable')
  expect(getProviderFailureKindLabel('network')).toBe('Network error')
  expect(getProviderFailureKindLabel('timeout')).toBe('Timeouts')
  expect(getProviderFailureKindLabel('other')).toBe('Provider errors')
  expect(getProviderFailureKindLabel('brand_new_kind' as JudgmentJobProviderHealth['failureKind'])).toBe(
    'Provider errors',
  )
  expect(getProviderHealthTone('usage_limit')).toBe('rose')
  expect(getProviderHealthTone('auth')).toBe('rose')
  expect(getProviderHealthTone('rate_limited')).toBe('amber')
  expect(getProviderHealthTone('endpoint_unavailable')).toBe('amber')
  expect(getProviderHealthTone('network')).toBe('amber')
  expect(getProviderHealthTone('timeout')).toBe('amber')
  expect(getProviderHealthTone('other')).toBe('amber')
  expect(getProviderHealthToneClass('rose')).toBe('border-rose-200 bg-rose-50 text-rose-900')
  expect(getProviderHealthToneClass('amber')).toBe('border-amber-200 bg-amber-50 text-amber-900')
  expect(getProviderHealthGuidance('usage_limit')).toBe(
    'Buy credits or wait for the limit to reset; the job resumes by itself once the provider accepts calls.',
  )
  expect(getProviderHealthGuidance('auth')).toBe('Check the provider connection and its API key.')
  expect(getProviderHealthGuidance('endpoint_unavailable')).toBe('Check that the endpoint is running and reachable.')
  expect(getProviderHealthGuidance('network')).toBe('Check that the endpoint is running and reachable.')
  expect(getProviderHealthGuidance('rate_limited')).toBe('Retries continue with backoff.')
  expect(getProviderHealthGuidance('timeout')).toBe('Retries continue with backoff. Check the provider if it persists.')
  expect(getProviderHealthGuidance('other')).toBe('Retries continue with backoff. Check the provider if it persists.')
})

test('provider retry-after and failure text helpers format local times, counts and long messages', () => {
  const formatTimestamp = (value: string) => {
    return `<${value}>`
  }
  const health = buildProviderHealth()

  expect(formatProviderRetryAfter(localRetryAfterAt)).toBe('Provider says try again at 2026-10-03 21:33')
  expect(formatProviderRetryAfter(null)).toBeNull()
  expect(formatProviderRetryAfter('')).toBeNull()
  expect(formatProviderRetryAfter('not a date')).toBeNull()
  expect(formatProviderFailureMeta(health, formatTimestamp)).toBe(
    `Since <${health.firstFailedAt}>, 3 failed attempts, last at <${health.lastFailedAt}>`,
  )
  expect(formatProviderFailureMeta({...health, consecutiveFailureCount: 1}, formatTimestamp)).toContain(
    ', 1 failed attempt, ',
  )
  expect(
    formatProviderRecoveryNote(
      {failureKind: 'rate_limited', recoveredAt: '2026-10-03T12:00:00.000Z', totalFailureCount: 5},
      formatTimestamp,
    ),
  ).toBe('Provider recovered at <2026-10-03T12:00:00.000Z> after 5 failures (Rate limited)')
  expect(
    formatProviderRecoveryNote(
      {failureKind: 'other', recoveredAt: '2026-10-03T12:00:00.000Z', totalFailureCount: 1},
      formatTimestamp,
    ),
  ).toBe('Provider recovered at <2026-10-03T12:00:00.000Z> after 1 failure (Provider errors)')
  expect(truncateProviderFailureMessage('x'.repeat(300))).toBe('x'.repeat(300))
  expect(truncateProviderFailureMessage('x'.repeat(301))).toBe(`${'x'.repeat(299)}…`)
  expect(truncateProviderFailureMessage('x'.repeat(301)).length).toBe(300)
})

test('recent provider recovery covers the last 24 hours only for inactive health', () => {
  const now = Date.parse('2026-10-03T12:00:00.000Z')
  const recovered = buildProviderHealth({isActive: false, recoveredAt: '2026-10-02T12:00:00.000Z', status: 'recovered'})

  expect(isRecentProviderRecovery(recovered, now)).toBe(true)
  expect(isRecentProviderRecovery({...recovered, recoveredAt: '2026-10-02T11:59:59.999Z'}, now)).toBe(false)
  expect(isRecentProviderRecovery({...recovered, recoveredAt: null}, now)).toBe(false)
  expect(isRecentProviderRecovery({...recovered, isActive: true}, now)).toBe(false)
  expect(isRecentProviderRecovery(null, now)).toBe(false)
})

test('job provider health accessor tolerates rows without the field', () => {
  const health = buildProviderHealth()

  expect(getJobProviderHealth(buildListJob({providerHealth: health}))).toBe(health)
  expect(getJobProviderHealth({id: 'job-without-field'})).toBeNull()
  expect(getJobProviderHealth(null)).toBeNull()
})

test('provider health banner is null when no job has an active provider failure', () => {
  expect(buildJobsProviderHealthBanner(undefined)).toBeNull()
  expect(buildJobsProviderHealthBanner([])).toBeNull()
  expect(
    buildJobsProviderHealthBanner([
      buildBannerJob('job-healthy', 'Healthy project', null),
      buildBannerJob(
        'job-recovered',
        'Recovered project',
        buildProviderHealth({isActive: false, recoveredAt: '2026-10-03T12:00:00.000Z', status: 'recovered'}),
      ),
    ]),
  ).toBeNull()
})

test('provider health banner groups failing jobs by model, kind and message', () => {
  const usageLimit = buildProviderHealth()
  const laterUsageLimit = buildProviderHealth({
    jobId: 'job-2',
    lastFailedAt: new Date(2026, 9, 3, 14, 0, 0).toISOString(),
    retryAfterAt: new Date(2026, 9, 3, 22, 0, 0).toISOString(),
  })
  const otherModelUsageLimit = buildProviderHealth({jobId: 'job-3', modelId: 'model-other'})
  const rateLimited = buildProviderHealth({
    failureKind: 'rate_limited',
    failureMessage: '429 Too Many Requests',
    jobId: 'job-4',
    lastFailedAt: new Date(2026, 9, 3, 15, 0, 0).toISOString(),
    retryAfterAt: null,
  })
  const banner = buildJobsProviderHealthBanner([
    buildBannerJob('job-2', 'Zeta project', laterUsageLimit, 'paused'),
    buildBannerJob('job-4', 'Rate project', rateLimited),
    buildBannerJob('job-1', 'Alpha project', usageLimit),
    buildBannerJob('job-3', null, otherModelUsageLimit),
    buildBannerJob('job-5', 'Healthy project', null),
  ])

  expect(banner?.title).toBe('LLM provider failing')
  expect(banner?.tone).toBe('rose')
  expect(
    banner?.groups.map((group) => {
      return {
        jobs: group.jobs,
        kind: group.kind,
        label: group.label,
        message: group.message,
        modelId: group.modelId,
        retryAfterAt: group.retryAfterAt,
        tone: group.tone,
      }
    }),
  ).toEqual([
    {
      jobs: [
        {id: 'job-1', projectName: 'Alpha project', status: 'running'},
        {id: 'job-2', projectName: 'Zeta project', status: 'paused'},
      ],
      kind: 'usage_limit',
      label: 'Usage limit reached',
      message: codexUsageLimitMessage,
      modelId: 'model-gpt',
      retryAfterAt: laterUsageLimit.retryAfterAt,
      tone: 'rose',
    },
    {
      jobs: [{id: 'job-3', projectName: 'Unknown Project', status: 'running'}],
      kind: 'usage_limit',
      label: 'Usage limit reached',
      message: codexUsageLimitMessage,
      modelId: 'model-other',
      retryAfterAt: localRetryAfterAt,
      tone: 'rose',
    },
    {
      jobs: [{id: 'job-4', projectName: 'Rate project', status: 'running'}],
      kind: 'rate_limited',
      label: 'Rate limited',
      message: '429 Too Many Requests',
      modelId: 'model-gpt',
      retryAfterAt: null,
      tone: 'amber',
    },
  ])
})

test('provider health banner stays amber when only non-blocking provider failures are active', () => {
  const banner = buildJobsProviderHealthBanner([
    buildBannerJob('job-1', 'Timeout project', buildProviderHealth({failureKind: 'timeout', retryAfterAt: null})),
  ])

  expect(banner?.tone).toBe('amber')
  expect(banner?.groups[0]?.label).toBe('Timeouts')
})
