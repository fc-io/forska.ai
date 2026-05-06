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
type TelemetryDetailRowProps = ParentProps<{class?: string; label: string; machine?: boolean}>
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

const getDetailValueWrapClass = (machine: boolean | undefined): string => {
  return machine ? 'break-all' : 'break-words'
}

const TelemetryMetric = (props: TelemetryMetricProps): JSX.Element => {
  return (
    <div class={`min-w-0 rounded-md border px-3 py-2 ${getMetricToneClass(props.tone)}`}>
      <div class="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <p class="min-w-0 break-words text-xs font-medium uppercase opacity-70 sm:w-5/12">{props.label}</p>
        <div class="min-w-0 break-words text-base font-semibold sm:w-7/12 sm:text-right">{props.children}</div>
      </div>
      <Show when={props.description}>
        {(description) => {
          return <p class="mt-1 break-words text-xs leading-4 opacity-75">{description()}</p>
        }}
      </Show>
    </div>
  )
}

const TelemetryDetailRow = (props: TelemetryDetailRowProps): JSX.Element => {
  return (
    <div class={`min-w-0 ${props.class ?? ''}`}>
      <div class="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
        <span class="font-medium text-gray-800">{props.label}</span>
        <span class={`min-w-0 ${getDetailValueWrapClass(props.machine)} sm:text-right`}>{props.children}</span>
      </div>
    </div>
  )
}

const TelemetrySection = (props: TelemetrySectionProps): JSX.Element => {
  return (
    <section class="min-w-0 space-y-2">
      <div>
        <h3 class="text-sm font-semibold text-gray-900">{props.title}</h3>
        <Show when={props.description}>
          {(description) => {
            return <p class="mt-1 break-words text-xs leading-5 text-gray-500">{description()}</p>
          }}
        </Show>
      </div>
      {props.children}
    </section>
  )
}

const getEndpointIdentityText = (endpoint: EndpointDiagnostics): string => {
  return endpoint.endpointIdentity ?? endpoint.effectiveBaseURL ?? endpoint.endpointAvailabilityKey
}

const getLeaseObservedMismatchMessage = (provider: JudgmentJobProviderTelemetry): string | null => {
  const leasedLiveRequests = provider.leaseAuthority.providerLeasedLiveRequests
  const observedLiveRequests = provider.observedBestEffort.providerLiveRequests

  return leasedLiveRequests === 0 && observedLiveRequests > 0
    ? `Observed worker telemetry reports ${formatTelemetryCount(
        observedLiveRequests,
      )} live requests, but the admission lease snapshot reports 0. Treat the lease snapshot as stale or incomplete until the next refresh catches up.`
    : null
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
          <div
            class="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
            data-testid="provider-capacity-telemetry"
          >
            <div class="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div class="min-w-0">
                <h2 class="text-lg font-semibold text-gray-900">Provider Capacity Telemetry</h2>
                <p class="mt-1 break-words text-sm text-gray-500">
                  Remote LLM request leases are the shared admission authority. Observed aggregates are worker-reported
                  best-effort telemetry, and local diagnostics describe this server&apos;s prompt and request-work
                  backlog.
                </p>
              </div>
              <span class="max-w-full self-start rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-800">
                {getObservedAggregateTelemetryLabel(telemetrySource())}
              </span>
            </div>

            <div class="mt-4 grid gap-4 xl:grid-cols-3">
              <TelemetrySection
                description="Admission lease snapshot for live remote LLM HTTP requests."
                title="Admission Lease Snapshot"
              >
                <div class="grid gap-2">
                  <TelemetryMetric
                    description={`Provider key: ${provider().leaseAuthority.providerKey}`}
                    tone="blue"
                    label="Leased Remote Requests"
                  >
                    {formatTelemetryRatio(
                      provider().leaseAuthority.providerLeasedLiveRequests,
                      provider().leaseAuthority.normalRequestCapacity,
                    )}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Live remote LLM request leases plus endpoint probe leases."
                    tone="indigo"
                    label="Physical Calls"
                  >
                    {formatTelemetryRatio(
                      provider().leaseAuthority.providerLeasedPhysicalCalls,
                      provider().leaseAuthority.providerLimit,
                    )}
                  </TelemetryMetric>
                  <TelemetryMetric
                    description="Lease slots still available for live remote LLM requests."
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
                <Show when={getLeaseObservedMismatchMessage(provider())}>
                  {(message) => {
                    return (
                      <div class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                        {message()}
                      </div>
                    )
                  }}
                </Show>
              </TelemetrySection>

              <TelemetrySection
                description="This worker's prompt backlog, request-work backlog, target share, and local request counters."
                title="Local Worker Diagnostics"
              >
                <div class="grid gap-2">
                  <TelemetryMetric
                    description="Remote LLM HTTP calls running in this worker."
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
                    description="Estimated pre-request, live-request, and post-response work compared with the adaptive target."
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
                </div>
              </TelemetrySection>

              <TelemetrySection
                description={getObservedAggregateTelemetryDescription(telemetrySource())}
                title="Observed Aggregate Telemetry"
              >
                <div class="grid gap-2">
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
                    <div class="min-w-0 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                      <p class="font-medium text-gray-800">Provider coverage</p>
                      <For each={telemetrySource()?.providerCoverage ?? []}>
                        {(coverage) => {
                          return (
                            <div class="mt-1 grid min-w-0 gap-1 sm:grid-cols-2">
                              <p class="min-w-0 break-all font-medium text-gray-800">{coverage.providerKey}</p>
                              <p class="min-w-0 break-words sm:text-right">
                                {coverage.aggregateCompleteness}, fresh{' '}
                                {formatTelemetryCount(coverage.freshWorkerCount)}, stale{' '}
                                {formatTelemetryCount(coverage.staleWorkerCount)}, unavailable{' '}
                                {formatTelemetryCount(coverage.unavailableWorkerCount)}
                              </p>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              </TelemetrySection>
            </div>

            <div class="mt-5 grid gap-4 xl:grid-cols-2">
              <TelemetrySection
                description="Allocation state and convergence diagnostics explain whether backlog targets can increase."
                title="Allocation State And Convergence"
              >
                <div class="grid gap-2 md:grid-cols-2">
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
                  <div class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                    <p class="font-medium">Higher priority stop rules</p>
                    <p class="mt-1 break-words">
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
                <div class="grid gap-2">
                  <TelemetryMetric tone="amber" label="Current Bottleneck">
                    {getProviderBottleneckLabel(provider().bottleneck)}
                  </TelemetryMetric>
                  <div class="min-w-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
                    <p class="break-words">{getProviderBottleneckDescription(provider().bottleneck)}</p>
                    <div class="mt-2 grid gap-2 md:grid-cols-2">
                      <TelemetryDetailRow machine label="Source">
                        {provider().bottleneckSource ?? 'N/A'}
                      </TelemetryDetailRow>
                      <TelemetryDetailRow label="Subreason">
                        {formatTelemetryEnumValue(provider().bottleneckSubreason)}
                      </TelemetryDetailRow>
                    </div>
                  </div>
                  <Show when={provider().bottleneck === 'endpointUnavailable'}>
                    <div class="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-950">
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
                        <div class="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                          <p class="font-medium text-gray-800">Lifecycle counters</p>
                          <div class="mt-2 grid gap-x-3 gap-y-1 sm:grid-cols-2">
                            <TelemetryDetailRow label="Running prompts">
                              {formatTelemetryCount(counters().runningPrompts)}
                            </TelemetryDetailRow>
                            <TelemetryDetailRow label="Claimed prompts">
                              {formatTelemetryCount(counters().claimedPrompts)}
                            </TelemetryDetailRow>
                            <TelemetryDetailRow label="Live request LLM calls">
                              {formatTelemetryCount(counters().liveLlmCalls)}
                            </TelemetryDetailRow>
                            <TelemetryDetailRow label="Worker prompt slots">
                              {formatTelemetryCount(counters().workerActivePrompts)}
                            </TelemetryDetailRow>
                            <TelemetryDetailRow label="Worker prompt queue">
                              {formatTelemetryCount(counters().workerQueuedPrompts)}
                            </TelemetryDetailRow>
                          </div>
                        </div>
                      )
                    }}
                  </Show>
                </div>
              </TelemetrySection>
            </div>

            <Show when={provider().endpointDiagnostics.length > 0}>
              <div class="mt-5">
                <TelemetrySection
                  description="Endpoint diagnostics show probe state, cooldown, failure metadata, and observed probe occupancy."
                  title="Endpoint Diagnostics"
                >
                  <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
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
                  <div class="mt-2 grid gap-2">
                    <For each={provider().endpointDiagnostics}>
                      {(endpoint) => {
                        return (
                          <div class="min-w-0 rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
                            <div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                              <div class="min-w-0">
                                <p class="break-all font-medium text-gray-900">{getEndpointIdentityText(endpoint)}</p>
                                <p class="mt-1 break-all font-mono text-xs text-gray-500">
                                  {endpoint.endpointAvailabilityKey}
                                </p>
                              </div>
                              <span class="max-w-full self-start rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700">
                                {getEndpointProbeStateLabel(endpoint.localProbeState)}
                              </span>
                            </div>
                            <div class="mt-2 grid gap-x-3 gap-y-1 text-xs text-gray-600 md:grid-cols-2 xl:grid-cols-4">
                              <TelemetryDetailRow label="Cooldown">
                                {formatTelemetryDuration(endpoint.cooldownRemainingMs)}
                              </TelemetryDetailRow>
                              <TelemetryDetailRow label="Probe running">
                                {formatTelemetryBoolean(endpoint.probeInProgress)}
                              </TelemetryDetailRow>
                              <TelemetryDetailRow label="Local probe live">
                                {formatTelemetryCount(endpoint.localProbeLiveCount)}
                              </TelemetryDetailRow>
                              <TelemetryDetailRow label="Observed probe live">
                                {endpoint.observedAggregateProbeLiveCount === null
                                  ? 'N/A'
                                  : formatTelemetryCount(endpoint.observedAggregateProbeLiveCount)}
                              </TelemetryDetailRow>
                              <TelemetryDetailRow label="Failure kind">
                                {formatTelemetryEnumValue(endpoint.lastFailureKind)}
                              </TelemetryDetailRow>
                              <TelemetryDetailRow class="md:col-span-2 xl:col-span-3" label="Failure message">
                                {endpoint.lastFailureMessage ?? 'N/A'}
                              </TelemetryDetailRow>
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
