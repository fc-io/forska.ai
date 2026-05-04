import {For, type JSX, type ParentProps, Show} from 'solid-js'

import type {JudgmentJobProviderTelemetry, JudgmentJobRequestStats} from '../../../../../services/judgmentsJobsService'
import {
  formatTelemetryBoolean,
  formatTelemetryCount,
  formatTelemetryDuration,
  formatTelemetryEnumValue,
  formatTelemetryPercent,
  formatTelemetryRatio,
  getAllocationStateLabel,
  getEndpointProbeStateLabel,
  getObservedAggregateTelemetryDescription,
  getObservedAggregateTelemetryLabel,
  getProviderBottleneckDescription,
  getProviderBottleneckLabel,
  getTelemetryCoverageSummary,
} from '../jobsPageShared'

type TelemetryTone = 'amber' | 'blue' | 'gray' | 'green' | 'indigo' | 'rose' | 'sky' | 'violet'
type TelemetryMetricProps = ParentProps<{description?: string; label: string; tone?: TelemetryTone}>
type TelemetrySectionProps = ParentProps<{description?: string; title: string}>
type JobTelemetryPanelProps = {requestStats?: Partial<JudgmentJobRequestStats>}
type EndpointDiagnostics = JudgmentJobProviderTelemetry['endpointDiagnostics'][number]

const getMetricToneClass = (tone: TelemetryTone | undefined): string => {
  switch (tone) {
    case 'amber':
      return 'border-amber-200 bg-amber-50 text-amber-950'
    case 'blue':
      return 'border-blue-200 bg-blue-50 text-blue-950'
    case 'green':
      return 'border-green-200 bg-green-50 text-green-950'
    case 'indigo':
      return 'border-indigo-200 bg-indigo-50 text-indigo-950'
    case 'rose':
      return 'border-rose-200 bg-rose-50 text-rose-950'
    case 'sky':
      return 'border-sky-200 bg-sky-50 text-sky-950'
    case 'violet':
      return 'border-violet-200 bg-violet-50 text-violet-950'
    default:
      return 'border-gray-200 bg-gray-50 text-gray-950'
  }
}

const TelemetryMetric = (props: TelemetryMetricProps): JSX.Element => {
  return (
    <div class={`rounded-lg border p-4 ${getMetricToneClass(props.tone)}`}>
      <p class="text-xs font-medium uppercase tracking-wide opacity-70">{props.label}</p>
      <div class="mt-1 text-xl font-semibold">{props.children}</div>
      <Show when={props.description}>
        {(description) => {
          return <p class="mt-1 text-xs leading-5 opacity-75">{description()}</p>
        }}
      </Show>
    </div>
  )
}

const TelemetrySection = (props: TelemetrySectionProps): JSX.Element => {
  return (
    <section class="space-y-3">
      <div>
        <h3 class="text-sm font-semibold text-gray-900">{props.title}</h3>
        <Show when={props.description}>
          {(description) => {
            return <p class="mt-1 text-sm text-gray-500">{description()}</p>
          }}
        </Show>
      </div>
      {props.children}
    </section>
  )
}

const getRequestSlotWaiterText = (requestStats: Partial<JudgmentJobRequestStats> | undefined): string => {
  const waiters = requestStats?.requestSlotWaiters

  return waiters
    ? `provider ${formatTelemetryCount(waiters.providerAdmission)}, worker ${formatTelemetryCount(
        waiters.worker,
      )}, Codex ${formatTelemetryCount(waiters.codex)}, fallback ${formatTelemetryCount(waiters.fallback)}`
    : 'N/A'
}

const getEndpointIdentityText = (endpoint: EndpointDiagnostics): string => {
  return endpoint.endpointIdentity ?? endpoint.effectiveBaseURL ?? endpoint.endpointAvailabilityKey
}

export const JobTelemetryPanel = (props: JobTelemetryPanelProps): JSX.Element => {
  const providerTelemetry = () => {
    return props.requestStats?.providerTelemetry
  }
  const telemetrySource = () => {
    return props.requestStats?.telemetrySource
  }
  const requestStats = () => {
    return props.requestStats
  }

  return (
    <Show when={providerTelemetry()}>
      {(provider) => {
        return (
          <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
            <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 class="text-lg font-semibold text-gray-900">Provider Capacity Telemetry</h2>
                <p class="mt-1 text-sm text-gray-500">
                  Request leases are the shared admission authority. Observed aggregates are worker-reported best-effort
                  telemetry, and local diagnostics describe this server&apos;s prompt and request-work backlog.
                </p>
              </div>
              <span class="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-800">
                {getObservedAggregateTelemetryLabel(telemetrySource())}
              </span>
            </div>

            <div class="mt-6 grid gap-6 xl:grid-cols-3">
              <TelemetrySection
                description="Lease-authoritative request-level provider capacity from shared admission leases."
                title="Lease Authority"
              >
                <div class="grid gap-3">
                  <TelemetryMetric
                    description={`Provider key: ${provider().leaseAuthority.providerKey}`}
                    tone="blue"
                    label="Request Leases"
                  >
                    {formatTelemetryRatio(
                      provider().leaseAuthority.providerLeasedLiveRequests,
                      provider().leaseAuthority.normalRequestCapacity,
                    )}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Live request leases plus endpoint probe leases."
                    tone="indigo"
                    label="Physical Calls"
                  >
                    {formatTelemetryRatio(
                      provider().leaseAuthority.providerLeasedPhysicalCalls,
                      provider().leaseAuthority.providerLimit,
                    )}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Lease slots still available for normal request attempts."
                    label="Lease Headroom"
                  >
                    {formatTelemetryCount(provider().leaseAuthority.providerAvailableRequestLeases)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Allocated live request target for this provider bucket."
                    label="Provider Target"
                  >
                    {formatTelemetryCount(provider().leaseAuthority.targetRequestLiveCalls)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Endpoint probes reserve physical capacity separately from request attempts."
                    label="Probe Leases"
                  >
                    {formatTelemetryCount(provider().leaseAuthority.providerLeasedProbeCalls)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Request lease fill uses normal request capacity, not prompt slots."
                    label="Request Fill"
                  >
                    {formatTelemetryPercent(provider().leaseAuthority.providerRequestFillPct)}
                  </TelemetryMetric>
                </div>
              </TelemetrySection>

              <TelemetrySection
                description="This worker's prompt backlog, request-work backlog, target share, and local request counters."
                title="Local Worker Diagnostics"
              >
                <div class="grid gap-3">
                  <TelemetryMetric
                    description="Physical request-level LLM calls running in this worker."
                    tone="sky"
                    label="Local Live Requests"
                  >
                    {formatTelemetryRatio(provider().localProviderLiveRequests, provider().effectiveProviderLimit)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Expected local live share from the owner allocation snapshot."
                    label="Expected Local Live Share"
                  >
                    {formatTelemetryCount(provider().expectedLocalLiveShare)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Claimed prompt backlog compared with the adaptive prompt target."
                    label="Local Prompt Backlog"
                  >
                    {formatTelemetryRatio(provider().localPromptBacklog, provider().localPromptBacklogTarget)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Estimated request work compared with the adaptive request-work target."
                    label="Request-Work Backlog"
                  >
                    {formatTelemetryRatio(provider().localRequestWorkBacklog, provider().localRequestWorkBacklogTarget)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Additional local work allowed by target share and shared request leases."
                    label="Local Target And Lease Headroom"
                  >
                    <span>{formatTelemetryCount(provider().localAdditionalTargetHeadroom)} target</span>
                    <span class="mx-1 text-gray-400">/</span>
                    <span>{formatTelemetryCount(provider().localAdditionalLeaseHeadroom)} lease</span>
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Waiters are grouped by the capacity surface they are blocked on."
                    label="Request Slot Waiters"
                  >
                    {getRequestSlotWaiterText(requestStats())}
                  </TelemetryMetric>
                </div>
              </TelemetrySection>

              <TelemetrySection
                description={getObservedAggregateTelemetryDescription(telemetrySource())}
                title="Observed Aggregate Telemetry"
              >
                <div class="grid gap-3">
                  <TelemetryMetric
                    description={getTelemetryCoverageSummary(telemetrySource())}
                    tone="violet"
                    label="Coverage"
                  >
                    {formatTelemetryEnumValue(telemetrySource()?.aggregateCompleteness)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Worker-reported live requests across fresh telemetry snapshots."
                    label="Observed Live Requests"
                  >
                    {formatTelemetryRatio(
                      provider().observedBestEffort.providerLiveRequests,
                      provider().observedBestEffort.effectiveProviderLimit,
                    )}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Worker-reported prompt backlog across fresh telemetry snapshots."
                    label="Observed Prompt Backlog"
                  >
                    {formatTelemetryCount(provider().observedBestEffort.promptBacklog)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Worker-reported request-work backlog across fresh telemetry snapshots."
                    label="Observed Request-Work Backlog"
                  >
                    {formatTelemetryCount(provider().observedBestEffort.requestWorkBacklog)}
                  </TelemetryMetric>
                  <TelemetryMetric description="Best-effort observed live request fill." label="Observed Fill">
                    {formatTelemetryPercent(provider().observedBestEffort.providerRequestFillPct)}
                  </TelemetryMetric>
                  <Show when={(telemetrySource()?.providerCoverage ?? []).length > 0}>
                    <div class="rounded-lg border border-gray-200 bg-gray-50 p-4 text-xs text-gray-600">
                      <p class="font-medium text-gray-800">Provider coverage</p>
                      <For each={telemetrySource()?.providerCoverage ?? []}>
                        {(coverage) => {
                          return (
                            <p class="mt-1">
                              {coverage.providerKey}: {coverage.aggregateCompleteness}, fresh{' '}
                              {formatTelemetryCount(coverage.freshWorkerCount)}, stale{' '}
                              {formatTelemetryCount(coverage.staleWorkerCount)}, unavailable{' '}
                              {formatTelemetryCount(coverage.unavailableWorkerCount)}
                            </p>
                          )
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              </TelemetrySection>
            </div>

            <div class="mt-8 grid gap-6 xl:grid-cols-2">
              <TelemetrySection
                description="Allocation state and convergence diagnostics explain whether backlog targets can increase."
                title="Allocation State And Convergence"
              >
                <div class="grid gap-3 md:grid-cols-2">
                  <TelemetryMetric
                    description={`Input state: ${formatTelemetryEnumValue(provider().allocationInputState)}`}
                    tone="green"
                    label="Allocation State"
                  >
                    {getAllocationStateLabel(provider())}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Provider target calls not currently allocated to routeable workers."
                    label="Unallocated Target"
                  >
                    {formatTelemetryCount(provider().unallocatedTargetLiveCalls)}
                  </TelemetryMetric>
                  <TelemetryMetric description="Ready work seen by the adaptive controller." label="Ready Count">
                    {formatTelemetryCount(provider().convergenceDiagnostics.readyCount)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="How long the controller preconditions have been stable."
                    label="Preconditions Stable"
                  >
                    {formatTelemetryDuration(provider().convergenceDiagnostics.preconditionsStableSinceMs)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Whether prompt backlog replenishment can currently run."
                    label="Backlog Replenishment"
                  >
                    {formatTelemetryBoolean(provider().convergenceDiagnostics.backlogReplenishmentAllowed)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Whether provider admission should accept new normal requests."
                    label="Provider Accepting Requests"
                  >
                    {formatTelemetryBoolean(provider().convergenceDiagnostics.providerAcceptingRequests)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Healthy endpoint or endpointless routeability precondition."
                    label="Endpoint Routeable"
                  >
                    {formatTelemetryBoolean(provider().convergenceDiagnostics.hasHealthyEndpointOrEndpointlessPath)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Normal request capacity after probe occupancy and provider limit."
                    label="Normal Capacity Positive"
                  >
                    {formatTelemetryBoolean(provider().convergenceDiagnostics.normalRequestCapacityPositive)}
                  </TelemetryMetric>
                  <TelemetryMetric description="Provider target allocation version." label="Allocation Version">
                    {provider().providerAllocationVersion}
                  </TelemetryMetric>
                  <TelemetryMetric description="Provider limit and probe occupancy versions." label="Limit Versions">
                    <span>{provider().providerLimitVersion}</span>
                    <span class="mx-1 text-gray-400">/</span>
                    <span>{provider().providerProbeOccupancyVersion}</span>
                  </TelemetryMetric>
                  <TelemetryMetric description="Target increase hysteresis result." label="Target Increase Allowed">
                    {formatTelemetryBoolean(provider().convergenceDiagnostics.targetIncreaseAllowed)}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Current convergence precondition change reason."
                    label="Precondition Change"
                  >
                    {formatTelemetryEnumValue(provider().convergenceDiagnostics.preconditionChangedReason)}
                  </TelemetryMetric>
                </div>
                <Show when={provider().convergenceDiagnostics.activeHigherPriorityStopRules.length > 0}>
                  <div class="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                    <p class="font-medium">Higher priority stop rules</p>
                    <p class="mt-1">
                      {provider()
                        .convergenceDiagnostics.activeHigherPriorityStopRules.map(formatTelemetryEnumValue)
                        .join(', ')}
                    </p>
                  </div>
                </Show>
              </TelemetrySection>

              <TelemetrySection
                description="Bottleneck, subreason, and source metadata after endpoint diagnostics are attached."
                title="Bottleneck Source Metadata"
              >
                <div class="grid gap-3">
                  <TelemetryMetric tone="amber" label="Current Bottleneck">
                    {getProviderBottleneckLabel(provider().bottleneck)}
                  </TelemetryMetric>
                  <div class="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                    <p>{getProviderBottleneckDescription(provider().bottleneck)}</p>
                    <div class="mt-3 grid gap-2 md:grid-cols-2">
                      <p>
                        <span class="font-medium">Source:</span> {provider().bottleneckSource ?? 'N/A'}
                      </p>
                      <p>
                        <span class="font-medium">Subreason:</span>{' '}
                        {formatTelemetryEnumValue(provider().bottleneckSubreason)}
                      </p>
                    </div>
                  </div>
                  <Show when={provider().bottleneck === 'endpointUnavailable'}>
                    <div class="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-950">
                      <p class="font-medium">Claiming held by endpoint probe state</p>
                      <p class="mt-1">
                        Endpoint diagnostics are blocking new claims until a healthy endpoint or endpointless route is
                        available.
                      </p>
                    </div>
                  </Show>
                  <Show when={requestStats()?.lifecycleCounters}>
                    {(counters) => {
                      return (
                        <div class="rounded-lg border border-gray-200 bg-gray-50 p-4 text-xs text-gray-600">
                          <p class="font-medium text-gray-800">Lifecycle counters</p>
                          <p class="mt-1">
                            running prompts {formatTelemetryCount(counters().runningPrompts)}, claimed prompts{' '}
                            {formatTelemetryCount(counters().claimedPrompts)}, live request LLM calls{' '}
                            {formatTelemetryCount(counters().liveLlmCalls)}
                          </p>
                          <p class="mt-1">
                            worker prompt slots {formatTelemetryCount(counters().workerActivePrompts)}, worker prompt
                            queue {formatTelemetryCount(counters().workerQueuedPrompts)}
                          </p>
                        </div>
                      )
                    }}
                  </Show>
                </div>
              </TelemetrySection>
            </div>

            <Show when={provider().endpointDiagnostics.length > 0}>
              <div class="mt-8">
                <TelemetrySection
                  description="Endpoint diagnostics show probe state, cooldown, failure metadata, and observed probe occupancy."
                  title="Endpoint Diagnostics"
                >
                  <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <TelemetryMetric
                      description={`Provider key: ${provider().endpointDiagnosticsSummary.providerKey}`}
                      tone="rose"
                      label="Endpoint Summary"
                    >
                      {formatTelemetryCount(provider().endpointDiagnosticsSummary.healthyEndpointCount)} healthy /{' '}
                      {formatTelemetryCount(provider().endpointDiagnosticsSummary.endpointCount)} total
                    </TelemetryMetric>
                    <TelemetryMetric
                      description="Blocked endpoints are unhealthy, cooling down, or misconfigured."
                      label="Blocked Endpoints"
                    >
                      {formatTelemetryCount(provider().endpointDiagnosticsSummary.blockedEndpointCount)}
                    </TelemetryMetric>
                    <TelemetryMetric
                      description="Local and observed aggregate endpoint probe leases."
                      label="Endpoint Probe Live"
                    >
                      <span>
                        {formatTelemetryCount(provider().endpointDiagnosticsSummary.localProbeLiveCount)} local
                      </span>
                      <span class="mx-1 text-gray-400">/</span>
                      <span>
                        {provider().endpointDiagnosticsSummary.observedAggregateProbeLiveCount === null
                          ? 'N/A'
                          : `${formatTelemetryCount(
                              provider().endpointDiagnosticsSummary.observedAggregateProbeLiveCount,
                            )} observed`}
                      </span>
                    </TelemetryMetric>
                  </div>
                  <div class="mt-3 grid gap-3">
                    <For each={provider().endpointDiagnostics}>
                      {(endpoint) => {
                        return (
                          <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
                            <div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                              <div>
                                <p class="font-medium text-gray-900">{getEndpointIdentityText(endpoint)}</p>
                                <p class="mt-1 break-all font-mono text-xs text-gray-500">
                                  {endpoint.endpointAvailabilityKey}
                                </p>
                              </div>
                              <span class="rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700">
                                {getEndpointProbeStateLabel(endpoint.localProbeState)}
                              </span>
                            </div>
                            <div class="mt-3 grid gap-2 text-sm text-gray-600 md:grid-cols-2 xl:grid-cols-4">
                              <p>
                                <span class="font-medium text-gray-800">Cooldown:</span>{' '}
                                {formatTelemetryDuration(endpoint.cooldownRemainingMs)}
                              </p>
                              <p>
                                <span class="font-medium text-gray-800">Probe running:</span>{' '}
                                {formatTelemetryBoolean(endpoint.probeInProgress)}
                              </p>
                              <p>
                                <span class="font-medium text-gray-800">Local probe live:</span>{' '}
                                {formatTelemetryCount(endpoint.localProbeLiveCount)}
                              </p>
                              <p>
                                <span class="font-medium text-gray-800">Observed probe live:</span>{' '}
                                {endpoint.observedAggregateProbeLiveCount === null
                                  ? 'N/A'
                                  : formatTelemetryCount(endpoint.observedAggregateProbeLiveCount)}
                              </p>
                              <p>
                                <span class="font-medium text-gray-800">Failure kind:</span>{' '}
                                {formatTelemetryEnumValue(endpoint.lastFailureKind)}
                              </p>
                              <p class="break-words md:col-span-2 xl:col-span-3">
                                <span class="font-medium text-gray-800">Failure message:</span>{' '}
                                {endpoint.lastFailureMessage ?? 'N/A'}
                              </p>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </TelemetrySection>
              </div>
            </Show>
          </div>
        )
      }}
    </Show>
  )
}
