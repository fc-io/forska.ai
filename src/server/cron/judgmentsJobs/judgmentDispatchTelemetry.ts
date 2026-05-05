import {
  type DuckdbOwnerConnectionRecord,
  getDuckdbOwnerConnectionsOverview,
} from '../../utils/duckdbOwnerConnections.ts'
import {shouldCurrentServerRunJudgingLoops} from '../../utils/serverRuntimeRole.ts'
import {
  getAcceptedJudgeWorkerClaimLifecycleRows,
  shouldUseJudgeWorkerOwnerHandoff,
} from './judgeWorkerCompletionJournal.ts'
import {
  getJudgmentBacklogControllerState,
  judgmentBacklogControllerConstants,
  type JudgmentBacklogLifecycleAgesMs,
} from './judgmentBacklogController.ts'
import {
  getJudgmentDispatchPromptLifecycleRecords,
  getJudgmentDispatchProviderKey,
  getJudgmentDispatchProviderStats,
  type JudgmentDispatchProviderStats,
  type ProviderQueueInput,
} from './judgmentDispatchRuntime.ts'
import {getDefaultJudgmentServerJobId} from './judgmentJobServerIdentity.ts'
import {getJudgmentJobSqliteService, type JudgmentJobQueuePromptLifecycleRow} from './judgmentJobSqliteService.ts'
import {
  getJudgmentLifecycleTelemetry,
  getJudgmentPromptLifecycleTelemetryRecord,
  getRequestAttemptLifecycleTelemetryRecords,
  type JudgmentLifecycleTelemetry,
  type JudgmentLifecycleTelemetryRecord,
  mergeJudgmentLifecycleTelemetry,
} from './judgmentLifecycleTelemetry.ts'
import {getJudgmentReadyWorkSignal} from './judgmentReadyWorkSignal.ts'
import {
  type JudgmentRequestAttemptJsonEntry,
  parseRequestAttempts,
  stringifyRequestAttempts,
} from './judgmentRequestAttemptManifest.ts'
import {
  getJudgmentProviderRequestStats,
  getJudgmentRequestLifecycleRecords,
  getJudgmentRequestStats,
} from './judgmentsRequestRuntime.ts'
import {
  getProviderAdmissionLeaseTelemetry,
  getProviderBucketSnapshot,
  type ProviderBucketSnapshot,
} from './providerAdmissionLease.ts'
import {
  getProviderTargetAllocationSnapshot,
  getProviderTargetAllocationWorkerSnapshot,
  type ProviderTargetAllocationSnapshot,
  type ProviderTargetAllocationWorkerInput,
} from './providerTargetAllocationSnapshot.ts'

export const judgmentDispatchTelemetryPath = '/api/admin/judgment-dispatch-runtime'

export type JudgmentDispatchTelemetryInput = ProviderQueueInput & {
  jobId: string
  providerFamily?: string | null
  providerId?: string | null
  providerLimit?: number | null
  providerLimitVersion?: string | null
  providerName?: string | null
  readyCount?: number | null
  resolvedDefaultCapacity?: number | null
}

export type JudgmentTelemetryAggregateCompleteness = 'complete' | 'partial' | 'unavailable'

export const judgmentBottleneckValues = [
  'claiming',
  'promptPreparation',
  'requestSlotWait',
  'providerAtTarget',
  'providerSaturated',
  'workerCapacitySaturated',
  'fallbackCapacitySaturated',
  'completionPersistence',
  'endpointUnavailable',
  'effectiveCapacityLimited',
  'noReadyWork',
] as const

export type JudgmentBottleneck = (typeof judgmentBottleneckValues)[number]

export const judgmentRequestSlotWaitSubreasonValues = [
  'ownerAdmissionUnavailable',
  'staleSnapshotRefreshPending',
  'waiterNotWoken',
  'leaseAcquireContention',
  'noAcquireAttemptRecorded',
  'waiterInterrupted',
] as const

export type JudgmentRequestSlotWaitSubreason = (typeof judgmentRequestSlotWaitSubreasonValues)[number]

export const judgmentBottleneckSubreasonValues = [
  'allocationSnapshotIncomplete',
  'completionJournal',
  'effectiveCapacityZero',
  'endpointCooldown',
  'endpointMisconfigured',
  'endpointProbe',
  'endpointUnhealthy',
  'judgmentOutbox',
  'localWorkerAtCapacity',
  'manifestCasExhausted',
  'persistencePending',
  'promptClaimBacklog',
  'promptPreparationBacklog',
  'providerPhysicalCap',
  'providerTargetReached',
  'readyWorkUnavailable',
  'routeableCapacityExhausted',
  'sharedFallbackAtCapacity',
  'terminalCleanup',
  'tokenUsePersistence',
  'warmupLimited',
  'ownerAck',
  ...judgmentRequestSlotWaitSubreasonValues,
] as const

export type JudgmentBottleneckSubreason = (typeof judgmentBottleneckSubreasonValues)[number]

export type JudgmentDispatchPromptTelemetry = {
  jobActivePrompts: number
  jobQueuedPrompts: number
  providerDispatchActivePromptFillPct: number | null
  providerDispatchActivePromptLimit: number
  providerDispatchActivePrompts: number
  providerDispatchPrefetchFillPct: number | null
  providerDispatchQueueLimit: number
  providerDispatchQueuedPrompts: number
}

export type JudgmentTelemetryCoverageMetadata = {
  aggregateCompleteness: JudgmentTelemetryAggregateCompleteness
  freshWorkerCount: number
  staleWorkerCount: number
  unavailableWorkerCount: number
}

export type JudgmentEndpointTelemetryDiagnostics = {
  cooldownRemainingMs: number | null
  endpointAvailabilityKey: string
  endpointIdentity: string | null
  effectiveBaseURL: string | null
  lastFailureKind: string | null
  lastFailureMessage: string | null
  localProbeCooldownUntil: string | null
  localProbeLiveCount: number
  localProbeState: string
  observedAggregateProbeLiveCount: number | null
  probeInProgress: boolean
}

export type JudgmentEndpointTelemetrySummary = {
  blockedEndpointCount: number
  cooldownEndpointCount: number
  endpointCount: number
  hasHealthyEndpointOrEndpointlessPath: boolean
  healthyEndpointCount: number
  localProbeLiveCount: number
  misconfiguredEndpointCount: number
  observedAggregateProbeLiveCount: number | null
  probeInProgress: boolean
  providerKey: string
  probingEndpointCount: number
  unhealthyEndpointCount: number
}

export type JudgmentRequestSlotWaiterTelemetry = {
  codex: number
  fallback: number
  providerAdmission: number
  worker: number
}

export type JudgmentConvergenceDiagnostics = {
  activeHigherPriorityStopRules: string[]
  allocationCompleteCurrent: boolean
  allocationInputState: string
  backlogReplenishmentAllowed: boolean
  hasHealthyEndpointOrEndpointlessPath: boolean
  normalRequestCapacityPositive: boolean
  preconditionChangedReason: string | null
  preconditionsStableSinceMs: number
  providerAcceptingRequests: boolean
  providerLimitPositive: boolean
  readyCount: number
  targetIncreaseAllowed?: boolean
}

export type JudgmentProviderTelemetry = {
  allocationCompleteCurrent: boolean
  allocationInputState: string
  bottleneck: JudgmentBottleneck | null
  bottleneckSource: string | null
  bottleneckSubreason: JudgmentBottleneckSubreason | null
  convergenceDiagnostics: JudgmentConvergenceDiagnostics
  effectiveProviderLimit: number
  endpointDiagnostics: JudgmentEndpointTelemetryDiagnostics[]
  endpointDiagnosticsByKey: Record<string, JudgmentEndpointTelemetryDiagnostics>
  endpointDiagnosticsSummary: JudgmentEndpointTelemetrySummary
  expectedLocalLiveShare: number
  leaseAuthority: {
    normalRequestCapacity: number
    probeOccupancySampledAtMs: number
    providerAllocationVersion: string
    providerAvailableRequestLeases: number
    providerKey: string
    providerLeasedLiveRequests: number
    providerLeasedPhysicalCalls: number
    providerLeasedProbeCalls: number
    providerLimit: number
    providerLimitVersion: string
    providerProbeOccupancyVersion: string
    providerRequestFillPct: number | null
    targetRequestLiveCalls: number
  }
  localAdditionalLeaseHeadroom: number
  localAdditionalTargetHeadroom: number
  localPromptBacklog: number
  localPromptBacklogTarget: number
  localProviderLiveRequests: number
  localProviderRequestFillPct: number | null
  localRequestWorkBacklog: number
  localRequestWorkBacklogTarget: number
  normalRequestCapacity: number
  observedBestEffort: {
    effectiveProviderLimit: number
    label: 'bestEffort'
    promptBacklog: number
    providerLiveRequests: number
    providerRequestFillPct: number | null
    requestWorkBacklog: number
  }
  observedAggregateLabel: 'bestEffort'
  observedGlobalEffectiveProviderLimit: number
  observedGlobalPromptBacklog: number
  observedGlobalProviderLiveRequests: number
  observedGlobalProviderRequestFillPct: number | null
  observedGlobalRequestWorkBacklog: number
  probeOccupancySampledAtMs: number
  providerAllocationVersion: string
  providerAvailableRequestLeases: number
  providerKey: string
  providerLeasedLiveRequests: number
  providerLeasedPhysicalCalls: number
  providerLeasedProbeCalls: number
  providerLimit: number
  providerLimitVersion: string
  providerProbeOccupancyVersion: string
  providerRequestFillPct: number | null
  providerTargetAllocationSnapshot?: ProviderTargetAllocationSnapshot
  targetRequestLiveCalls: number
  unallocatedTargetLiveCalls: number
}

export type JudgmentTelemetrySourceMetadata = {
  aggregateCompleteness: JudgmentTelemetryAggregateCompleteness
  endpointCoverage: Array<JudgmentTelemetryCoverageMetadata & {endpointAvailabilityKey: string}>
  freshWorkerCount: number
  localWorkerId: string
  observedAggregatesAreBestEffort: true
  providerCoverage: Array<JudgmentTelemetryCoverageMetadata & {providerKey: string}>
  staleWorkerCount: number
  telemetryUnavailable: boolean
  unavailableWorkerCount: number
}

export type JudgmentDispatchTelemetrySnapshot = {
  dispatch: JudgmentDispatchPromptTelemetry
  lifecycle?: JudgmentLifecycleTelemetry
  provider: JudgmentProviderTelemetry
  request: {
    inFlight: number
    pendingPersistedAttempts: number
    requestSlotWaiters?: JudgmentRequestSlotWaiterTelemetry
    requestWorkBacklog: number
    waitingForRequestSlot: number
  }
  source: JudgmentTelemetrySourceMetadata
}

type JudgmentDispatchTelemetryOptions = {
  fetchWorkerTelemetry?: (
    record: DuckdbOwnerConnectionRecord,
    input: JudgmentDispatchTelemetryInput,
  ) => Promise<JudgmentDispatchTelemetrySnapshot | null>
  getJudgingWorkerRecords?: () => Promise<DuckdbOwnerConnectionRecord[]>
  getLocalTelemetry?: (input: JudgmentDispatchTelemetryInput) => Promise<JudgmentDispatchTelemetrySnapshot>
  shouldUseLocalTelemetryOnly?: () => boolean
}

const workerTelemetryTimeoutMs = 5_000
const defaultProviderProbeOccupancyVersion = 'probe-occupancy-unavailable'
const judgmentBottleneckValueSet = new Set<string>(judgmentBottleneckValues)
const judgmentBottleneckSubreasonValueSet = new Set<string>(judgmentBottleneckSubreasonValues)
const judgmentRequestSlotWaitSubreasonValueSet = new Set<string>(judgmentRequestSlotWaitSubreasonValues)

const getCanonicalBottleneck = (value: unknown): JudgmentBottleneck | null => {
  return typeof value === 'string' && judgmentBottleneckValueSet.has(value) ? (value as JudgmentBottleneck) : null
}

const getCanonicalBottleneckSubreason = (value: unknown): JudgmentBottleneckSubreason | null => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  const isCanonical = judgmentBottleneckSubreasonValueSet.has(trimmed) && !judgmentBottleneckValueSet.has(trimmed)

  return isCanonical ? (trimmed as JudgmentBottleneckSubreason) : null
}

const getCanonicalRequestSlotWaitSubreason = (value: unknown): JudgmentRequestSlotWaitSubreason | null => {
  const trimmed = typeof value === 'string' ? value.trim() : ''

  return judgmentRequestSlotWaitSubreasonValueSet.has(trimmed) ? (trimmed as JudgmentRequestSlotWaitSubreason) : null
}

const getFillPct = (used: number, capacity: number): number | null => {
  return capacity > 0 ? Math.round((used / capacity) * 100) : null
}

const getTelemetryAggregateCompleteness = ({
  staleWorkerCount,
  unavailableWorkerCount,
}: {
  staleWorkerCount: number
  unavailableWorkerCount: number
}): JudgmentTelemetryAggregateCompleteness => {
  return staleWorkerCount > 0 || unavailableWorkerCount > 0 ? 'partial' : 'complete'
}

const getTelemetryCoverageMetadata = ({
  freshWorkerCount,
  staleWorkerCount,
  unavailableWorkerCount,
}: {
  freshWorkerCount: number
  staleWorkerCount: number
  unavailableWorkerCount: number
}): JudgmentTelemetryCoverageMetadata => {
  return {
    aggregateCompleteness: getTelemetryAggregateCompleteness({staleWorkerCount, unavailableWorkerCount}),
    freshWorkerCount,
    staleWorkerCount,
    unavailableWorkerCount,
  }
}

const getTelemetrySourceMetadata = ({
  endpointAvailabilityKeys = [],
  freshWorkerCount,
  localWorkerId = getDefaultJudgmentServerJobId(),
  providerKey,
  staleWorkerCount,
  unavailableWorkerCount,
}: {
  endpointAvailabilityKeys?: string[]
  freshWorkerCount: number
  localWorkerId?: string
  providerKey: string
  staleWorkerCount: number
  unavailableWorkerCount: number
}): JudgmentTelemetrySourceMetadata => {
  const coverage = getTelemetryCoverageMetadata({freshWorkerCount, staleWorkerCount, unavailableWorkerCount})

  return {
    ...coverage,
    endpointCoverage: endpointAvailabilityKeys.map((endpointAvailabilityKey) => {
      return {...coverage, endpointAvailabilityKey}
    }),
    localWorkerId,
    observedAggregatesAreBestEffort: true,
    providerCoverage: [{...coverage, providerKey}],
    telemetryUnavailable: unavailableWorkerCount > 0,
  }
}

const getZeroDispatchStats = (): JudgmentDispatchPromptTelemetry => {
  return {
    jobActivePrompts: 0,
    jobQueuedPrompts: 0,
    providerDispatchActivePromptFillPct: null,
    providerDispatchActivePromptLimit: 0,
    providerDispatchActivePrompts: 0,
    providerDispatchPrefetchFillPct: null,
    providerDispatchQueueLimit: 0,
    providerDispatchQueuedPrompts: 0,
  }
}

const getDispatchTelemetryFromStats = (stats: JudgmentDispatchProviderStats): JudgmentDispatchPromptTelemetry => {
  return {
    jobActivePrompts: stats.jobActivePromptCount,
    jobQueuedPrompts: stats.jobQueuedPromptCount,
    providerDispatchActivePromptFillPct: getFillPct(stats.providerActivePromptCount, stats.providerActiveLimit),
    providerDispatchActivePromptLimit: stats.providerActiveLimit,
    providerDispatchActivePrompts: stats.providerActivePromptCount,
    providerDispatchPrefetchFillPct: getFillPct(stats.providerQueuedPromptCount, stats.providerQueueLimit),
    providerDispatchQueueLimit: stats.providerQueueLimit,
    providerDispatchQueuedPrompts: stats.providerQueuedPromptCount,
  }
}

const getEndpointDiagnosticsByKey = (
  endpointDiagnostics: JudgmentEndpointTelemetryDiagnostics[],
): Record<string, JudgmentEndpointTelemetryDiagnostics> => {
  return endpointDiagnostics.reduce<Record<string, JudgmentEndpointTelemetryDiagnostics>>((byKey, diagnostics) => {
    return {...byKey, [diagnostics.endpointAvailabilityKey]: diagnostics}
  }, {})
}

const getObservedAggregateProbeLiveCount = (
  endpointDiagnostics: JudgmentEndpointTelemetryDiagnostics[],
): number | null => {
  const observedCounts = endpointDiagnostics.flatMap((diagnostics) => {
    return diagnostics.observedAggregateProbeLiveCount === null ? [] : [diagnostics.observedAggregateProbeLiveCount]
  })

  return observedCounts.length === 0
    ? null
    : observedCounts.reduce((sum, count) => {
        return sum + count
      }, 0)
}

const getEndpointDiagnosticsSummary = ({
  endpointDiagnostics,
  hasHealthyEndpointOrEndpointlessPath,
  providerKey,
}: {
  endpointDiagnostics: JudgmentEndpointTelemetryDiagnostics[]
  hasHealthyEndpointOrEndpointlessPath: boolean
  providerKey: string
}): JudgmentEndpointTelemetrySummary => {
  const countByState = (state: string): number => {
    return endpointDiagnostics.filter((diagnostics) => {
      return diagnostics.localProbeState === state
    }).length
  }
  const localProbeLiveCount = endpointDiagnostics.reduce((sum, diagnostics) => {
    return sum + diagnostics.localProbeLiveCount
  }, 0)
  const cooldownEndpointCount = countByState('cooldown')
  const misconfiguredEndpointCount = countByState('misconfigured')
  const probingEndpointCount = countByState('probing')
  const healthyEndpointCount = countByState('healthy')
  const unhealthyEndpointCount =
    endpointDiagnostics.length
    - healthyEndpointCount
    - cooldownEndpointCount
    - misconfiguredEndpointCount
    - probingEndpointCount

  return {
    blockedEndpointCount:
      endpointDiagnostics.length === 0 ? 0 : endpointDiagnostics.length - healthyEndpointCount - probingEndpointCount,
    cooldownEndpointCount,
    endpointCount: endpointDiagnostics.length,
    hasHealthyEndpointOrEndpointlessPath,
    healthyEndpointCount,
    localProbeLiveCount,
    misconfiguredEndpointCount,
    observedAggregateProbeLiveCount: getObservedAggregateProbeLiveCount(endpointDiagnostics),
    probeInProgress: endpointDiagnostics.some((diagnostics) => {
      return diagnostics.probeInProgress
    }),
    providerKey,
    probingEndpointCount,
    unhealthyEndpointCount,
  }
}

const withProviderApiReadModels = (
  provider: Omit<
    JudgmentProviderTelemetry,
    'endpointDiagnosticsByKey' | 'endpointDiagnosticsSummary' | 'leaseAuthority' | 'observedBestEffort'
  >,
): JudgmentProviderTelemetry => {
  return {
    ...provider,
    endpointDiagnosticsByKey: getEndpointDiagnosticsByKey(provider.endpointDiagnostics),
    endpointDiagnosticsSummary: getEndpointDiagnosticsSummary({
      endpointDiagnostics: provider.endpointDiagnostics,
      hasHealthyEndpointOrEndpointlessPath: provider.convergenceDiagnostics.hasHealthyEndpointOrEndpointlessPath,
      providerKey: provider.providerKey,
    }),
    leaseAuthority: {
      normalRequestCapacity: provider.normalRequestCapacity,
      probeOccupancySampledAtMs: provider.probeOccupancySampledAtMs,
      providerAllocationVersion: provider.providerAllocationVersion,
      providerAvailableRequestLeases: provider.providerAvailableRequestLeases,
      providerKey: provider.providerKey,
      providerLeasedLiveRequests: provider.providerLeasedLiveRequests,
      providerLeasedPhysicalCalls: provider.providerLeasedPhysicalCalls,
      providerLeasedProbeCalls: provider.providerLeasedProbeCalls,
      providerLimit: provider.providerLimit,
      providerLimitVersion: provider.providerLimitVersion,
      providerProbeOccupancyVersion: provider.providerProbeOccupancyVersion,
      providerRequestFillPct: provider.providerRequestFillPct,
      targetRequestLiveCalls: provider.targetRequestLiveCalls,
    },
    observedBestEffort: {
      effectiveProviderLimit: provider.observedGlobalEffectiveProviderLimit,
      label: 'bestEffort',
      promptBacklog: provider.observedGlobalPromptBacklog,
      providerLiveRequests: provider.observedGlobalProviderLiveRequests,
      providerRequestFillPct: provider.observedGlobalProviderRequestFillPct,
      requestWorkBacklog: provider.observedGlobalRequestWorkBacklog,
    },
  }
}

const getZeroProviderTelemetry = ({providerKey}: {providerKey: string}): JudgmentProviderTelemetry => {
  const convergenceDiagnostics = {
    activeHigherPriorityStopRules: [],
    allocationCompleteCurrent: false,
    allocationInputState: 'unavailable',
    backlogReplenishmentAllowed: false,
    hasHealthyEndpointOrEndpointlessPath: false,
    normalRequestCapacityPositive: false,
    preconditionChangedReason: null,
    preconditionsStableSinceMs: 0,
    providerAcceptingRequests: false,
    providerLimitPositive: false,
    readyCount: 0,
  }

  return withProviderApiReadModels({
    allocationCompleteCurrent: false,
    allocationInputState: 'unavailable',
    bottleneck: null,
    bottleneckSource: null,
    bottleneckSubreason: null,
    convergenceDiagnostics,
    effectiveProviderLimit: 0,
    endpointDiagnostics: [],
    expectedLocalLiveShare: 0,
    localAdditionalLeaseHeadroom: 0,
    localAdditionalTargetHeadroom: 0,
    localPromptBacklog: 0,
    localPromptBacklogTarget: 0,
    localProviderLiveRequests: 0,
    localProviderRequestFillPct: null,
    localRequestWorkBacklog: 0,
    localRequestWorkBacklogTarget: 0,
    normalRequestCapacity: 0,
    observedAggregateLabel: 'bestEffort',
    observedGlobalEffectiveProviderLimit: 0,
    observedGlobalPromptBacklog: 0,
    observedGlobalProviderLiveRequests: 0,
    observedGlobalProviderRequestFillPct: null,
    observedGlobalRequestWorkBacklog: 0,
    probeOccupancySampledAtMs: 0,
    providerAllocationVersion: 'allocation-unavailable',
    providerAvailableRequestLeases: 0,
    providerKey,
    providerLeasedLiveRequests: 0,
    providerLeasedPhysicalCalls: 0,
    providerLeasedProbeCalls: 0,
    providerLimit: 0,
    providerLimitVersion: 'provider-limit-unavailable',
    providerProbeOccupancyVersion: defaultProviderProbeOccupancyVersion,
    providerRequestFillPct: null,
    targetRequestLiveCalls: 0,
    unallocatedTargetLiveCalls: 0,
  })
}

const getZeroTelemetrySnapshot = (): JudgmentDispatchTelemetrySnapshot => {
  const providerKey = 'unknown'
  return {
    dispatch: getZeroDispatchStats(),
    provider: getZeroProviderTelemetry({providerKey}),
    request: {
      inFlight: 0,
      pendingPersistedAttempts: 0,
      requestSlotWaiters: {codex: 0, fallback: 0, providerAdmission: 0, worker: 0},
      requestWorkBacklog: 0,
      waitingForRequestSlot: 0,
    },
    source: getTelemetrySourceMetadata({
      freshWorkerCount: 0,
      providerKey,
      staleWorkerCount: 0,
      unavailableWorkerCount: 0,
    }),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const getNumberValue = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getDispatchTelemetryFromRecord = (value: unknown): JudgmentDispatchPromptTelemetry | null => {
  if (!isRecord(value)) {
    return null
  }

  const jobActivePrompts = getNumberValue(value.jobActivePrompts) ?? getNumberValue(value.jobActivePromptCount)
  const jobQueuedPrompts = getNumberValue(value.jobQueuedPrompts) ?? getNumberValue(value.jobQueuedPromptCount)
  const providerDispatchActivePromptLimit =
    getNumberValue(value.providerDispatchActivePromptLimit) ?? getNumberValue(value.providerActiveLimit)
  const providerDispatchActivePrompts =
    getNumberValue(value.providerDispatchActivePrompts) ?? getNumberValue(value.providerActivePromptCount)
  const providerDispatchQueueLimit =
    getNumberValue(value.providerDispatchQueueLimit) ?? getNumberValue(value.providerQueueLimit)
  const providerDispatchQueuedPrompts =
    getNumberValue(value.providerDispatchQueuedPrompts) ?? getNumberValue(value.providerQueuedPromptCount)

  return jobActivePrompts === null
    || jobQueuedPrompts === null
    || providerDispatchActivePromptLimit === null
    || providerDispatchActivePrompts === null
    || providerDispatchQueueLimit === null
    || providerDispatchQueuedPrompts === null
    ? null
    : {
        jobActivePrompts,
        jobQueuedPrompts,
        providerDispatchActivePromptFillPct:
          getNumberValue(value.providerDispatchActivePromptFillPct)
          ?? getFillPct(providerDispatchActivePrompts, providerDispatchActivePromptLimit),
        providerDispatchActivePromptLimit,
        providerDispatchActivePrompts,
        providerDispatchPrefetchFillPct:
          getNumberValue(value.providerDispatchPrefetchFillPct)
          ?? getFillPct(providerDispatchQueuedPrompts, providerDispatchQueueLimit),
        providerDispatchQueueLimit,
        providerDispatchQueuedPrompts,
      }
}

const getRequestStatsFromRecord = (value: unknown): JudgmentDispatchTelemetrySnapshot['request'] | null => {
  if (!isRecord(value)) {
    return null
  }

  const inFlight = getNumberValue(value.inFlight)
  const pendingPersistedAttempts = getNumberValue(value.pendingPersistedAttempts)
  const requestWorkBacklog =
    getNumberValue(value.requestWorkBacklog) ?? Math.max(inFlight ?? 0, pendingPersistedAttempts ?? 0)
  const waitingForRequestSlot = getNumberValue(value.waitingForRequestSlot) ?? 0

  return inFlight === null || pendingPersistedAttempts === null
    ? null
    : {
        inFlight,
        pendingPersistedAttempts,
        requestSlotWaiters: getRequestSlotWaitersFromRecord(value.requestSlotWaiters),
        requestWorkBacklog,
        waitingForRequestSlot,
      }
}

const getRequestSlotWaitersFromRecord = (value: unknown): JudgmentRequestSlotWaiterTelemetry | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  return {
    codex: getNumberValue(value.codex) ?? 0,
    fallback: getNumberValue(value.fallback) ?? 0,
    providerAdmission: getNumberValue(value.providerAdmission) ?? 0,
    worker: getNumberValue(value.worker) ?? 0,
  }
}

const getBooleanValue = (value: unknown): boolean | null => {
  return typeof value === 'boolean' ? value : null
}

const getStringArrayValue = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        return typeof entry === 'string' ? [entry] : []
      })
    : []
}

const getStringValue = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

const getConvergenceDiagnosticsFromRecord = (value: unknown): JudgmentConvergenceDiagnostics | null => {
  if (!isRecord(value)) {
    return null
  }

  const readyCount = getNumberValue(value.readyCount)
  const providerLimitPositive = getBooleanValue(value.providerLimitPositive)
  const normalRequestCapacityPositive = getBooleanValue(value.normalRequestCapacityPositive)
  const hasHealthyEndpointOrEndpointlessPath = getBooleanValue(value.hasHealthyEndpointOrEndpointlessPath)
  const providerAcceptingRequests = getBooleanValue(value.providerAcceptingRequests)
  const backlogReplenishmentAllowed = getBooleanValue(value.backlogReplenishmentAllowed)
  const allocationInputState = getStringValue(value.allocationInputState)
  const allocationCompleteCurrent = getBooleanValue(value.allocationCompleteCurrent)
  const preconditionsStableSinceMs = getNumberValue(value.preconditionsStableSinceMs)

  return readyCount === null
    || providerLimitPositive === null
    || normalRequestCapacityPositive === null
    || hasHealthyEndpointOrEndpointlessPath === null
    || providerAcceptingRequests === null
    || backlogReplenishmentAllowed === null
    || allocationInputState === null
    || allocationCompleteCurrent === null
    || preconditionsStableSinceMs === null
    ? null
    : {
        activeHigherPriorityStopRules: getStringArrayValue(value.activeHigherPriorityStopRules),
        allocationCompleteCurrent,
        allocationInputState,
        backlogReplenishmentAllowed,
        hasHealthyEndpointOrEndpointlessPath,
        normalRequestCapacityPositive,
        preconditionChangedReason: getStringValue(value.preconditionChangedReason),
        preconditionsStableSinceMs,
        providerAcceptingRequests,
        providerLimitPositive,
        readyCount,
        ...(getBooleanValue(value.targetIncreaseAllowed) === null
          ? {}
          : {targetIncreaseAllowed: getBooleanValue(value.targetIncreaseAllowed) ?? false}),
      }
}

const getEndpointDiagnosticsFromRecord = (value: unknown): JudgmentEndpointTelemetryDiagnostics | null => {
  if (!isRecord(value)) {
    return null
  }

  const endpointAvailabilityKey = getStringValue(value.endpointAvailabilityKey)
  const localProbeLiveCount = getNumberValue(value.localProbeLiveCount) ?? getNumberValue(value.localEndpointProbeLive)
  const localProbeState = getStringValue(value.localProbeState) ?? getStringValue(value.localEndpointProbeState)
  const probeInProgress = getBooleanValue(value.probeInProgress)

  return endpointAvailabilityKey === null
    || localProbeLiveCount === null
    || localProbeState === null
    || probeInProgress === null
    ? null
    : {
        cooldownRemainingMs: getNumberValue(value.cooldownRemainingMs),
        effectiveBaseURL: getStringValue(value.effectiveBaseURL),
        endpointAvailabilityKey,
        endpointIdentity: getStringValue(value.endpointIdentity),
        lastFailureKind: getStringValue(value.lastFailureKind),
        lastFailureMessage: getStringValue(value.lastFailureMessage),
        localProbeCooldownUntil:
          getStringValue(value.localProbeCooldownUntil) ?? getStringValue(value.localEndpointProbeCooldownUntil),
        localProbeLiveCount,
        localProbeState,
        observedAggregateProbeLiveCount:
          getNumberValue(value.observedAggregateProbeLiveCount)
          ?? getNumberValue(value.observedGlobalEndpointProbeLive),
        probeInProgress,
      }
}

const getProviderTelemetryFromRecord = (value: unknown): JudgmentProviderTelemetry | null => {
  if (!isRecord(value)) {
    return null
  }

  const providerKey = getStringValue(value.providerKey)
  const providerLimit = getNumberValue(value.providerLimit)
  const providerLimitVersion = getStringValue(value.providerLimitVersion)
  const providerLeasedLiveRequests = getNumberValue(value.providerLeasedLiveRequests)
  const providerLeasedProbeCalls = getNumberValue(value.providerLeasedProbeCalls)
  const providerLeasedPhysicalCalls = getNumberValue(value.providerLeasedPhysicalCalls)
  const providerAvailableRequestLeases = getNumberValue(value.providerAvailableRequestLeases)
  const normalRequestCapacity = getNumberValue(value.normalRequestCapacity)
  const targetRequestLiveCalls = getNumberValue(value.targetRequestLiveCalls)
  const effectiveProviderLimit = getNumberValue(value.effectiveProviderLimit)
  const localProviderLiveRequests = getNumberValue(value.localProviderLiveRequests)
  const expectedLocalLiveShare = getNumberValue(value.expectedLocalLiveShare)
  const localAdditionalTargetHeadroom = getNumberValue(value.localAdditionalTargetHeadroom)
  const localAdditionalLeaseHeadroom = getNumberValue(value.localAdditionalLeaseHeadroom)
  const allocationInputState = getStringValue(value.allocationInputState)
  const allocationCompleteCurrent = getBooleanValue(value.allocationCompleteCurrent)
  const convergenceDiagnostics = getConvergenceDiagnosticsFromRecord(value.convergenceDiagnostics)

  return providerKey === null
    || providerLimit === null
    || providerLimitVersion === null
    || providerLeasedLiveRequests === null
    || providerLeasedProbeCalls === null
    || providerLeasedPhysicalCalls === null
    || providerAvailableRequestLeases === null
    || normalRequestCapacity === null
    || targetRequestLiveCalls === null
    || effectiveProviderLimit === null
    || localProviderLiveRequests === null
    || expectedLocalLiveShare === null
    || localAdditionalTargetHeadroom === null
    || localAdditionalLeaseHeadroom === null
    || allocationInputState === null
    || allocationCompleteCurrent === null
    || convergenceDiagnostics === null
    ? null
    : withProviderApiReadModels({
        allocationCompleteCurrent,
        allocationInputState,
        bottleneck: getCanonicalBottleneck(value.bottleneck),
        bottleneckSource: getStringValue(value.bottleneckSource),
        bottleneckSubreason: getCanonicalBottleneckSubreason(value.bottleneckSubreason),
        convergenceDiagnostics,
        effectiveProviderLimit,
        endpointDiagnostics: Array.isArray(value.endpointDiagnostics)
          ? value.endpointDiagnostics.flatMap((entry) => {
              const diagnostics = getEndpointDiagnosticsFromRecord(entry)

              return diagnostics ? [diagnostics] : []
            })
          : [],
        expectedLocalLiveShare,
        localAdditionalLeaseHeadroom,
        localAdditionalTargetHeadroom,
        localPromptBacklog: getNumberValue(value.localPromptBacklog) ?? 0,
        localPromptBacklogTarget: getNumberValue(value.localPromptBacklogTarget) ?? 0,
        localProviderLiveRequests,
        localProviderRequestFillPct: getNumberValue(value.localProviderRequestFillPct),
        localRequestWorkBacklog: getNumberValue(value.localRequestWorkBacklog) ?? 0,
        localRequestWorkBacklogTarget: getNumberValue(value.localRequestWorkBacklogTarget) ?? 0,
        normalRequestCapacity,
        observedAggregateLabel: 'bestEffort',
        observedGlobalEffectiveProviderLimit: getNumberValue(value.observedGlobalEffectiveProviderLimit) ?? 0,
        observedGlobalPromptBacklog: getNumberValue(value.observedGlobalPromptBacklog) ?? 0,
        observedGlobalProviderLiveRequests: getNumberValue(value.observedGlobalProviderLiveRequests) ?? 0,
        observedGlobalProviderRequestFillPct: getNumberValue(value.observedGlobalProviderRequestFillPct),
        observedGlobalRequestWorkBacklog: getNumberValue(value.observedGlobalRequestWorkBacklog) ?? 0,
        probeOccupancySampledAtMs: getNumberValue(value.probeOccupancySampledAtMs) ?? 0,
        providerAllocationVersion: getStringValue(value.providerAllocationVersion) ?? 'allocation-unavailable',
        providerAvailableRequestLeases,
        providerKey,
        providerLeasedLiveRequests,
        providerLeasedPhysicalCalls,
        providerLeasedProbeCalls,
        providerLimit,
        providerLimitVersion,
        providerProbeOccupancyVersion:
          getStringValue(value.providerProbeOccupancyVersion) ?? defaultProviderProbeOccupancyVersion,
        providerRequestFillPct: getNumberValue(value.providerRequestFillPct),
        targetRequestLiveCalls,
        unallocatedTargetLiveCalls: getNumberValue(value.unallocatedTargetLiveCalls) ?? 0,
      })
}

const getTelemetrySourceFromRecord = (
  value: unknown,
  providerKey: string,
  endpointAvailabilityKeys: string[],
): JudgmentTelemetrySourceMetadata | null => {
  if (!isRecord(value)) {
    return null
  }

  const freshWorkerCount = getNumberValue(value.freshWorkerCount)
  const staleWorkerCount = getNumberValue(value.staleWorkerCount)
  const unavailableWorkerCount = getNumberValue(value.unavailableWorkerCount)

  return freshWorkerCount === null || staleWorkerCount === null || unavailableWorkerCount === null
    ? null
    : getTelemetrySourceMetadata({
        endpointAvailabilityKeys,
        freshWorkerCount,
        localWorkerId: getStringValue(value.localWorkerId) ?? getDefaultJudgmentServerJobId(),
        providerKey,
        staleWorkerCount,
        unavailableWorkerCount,
      })
}

const getLifecycleRecordFromRecord = (value: unknown): JudgmentLifecycleTelemetryRecord | null => {
  if (!isRecord(value)) {
    return null
  }

  const jobId = getStringValue(value.jobId)
  const lifecycleKind =
    value.lifecycleKind === 'prompt' || value.lifecycleKind === 'requestAttempt' ? value.lifecycleKind : null
  const lifecycleState = getStringValue(value.lifecycleState)
  const providerKey = getStringValue(value.providerKey)

  return jobId && lifecycleKind && lifecycleState && providerKey
    ? {
        closeoutReason: getStringValue(value.closeoutReason),
        count: getNumberValue(value.count) ?? undefined,
        finishedAt: getStringValue(value.finishedAt),
        jobId,
        lifecycleKind,
        lifecycleState: lifecycleState as JudgmentLifecycleTelemetryRecord['lifecycleState'],
        promptId: getStringValue(value.promptId),
        providerKey,
        queueRecordId: getStringValue(value.queueRecordId),
        requestAttemptId: getStringValue(value.requestAttemptId),
        startedAt: getStringValue(value.startedAt),
        stateStartedAt: getStringValue(value.stateStartedAt),
        updatedAt: getStringValue(value.updatedAt),
      }
    : null
}

const getLifecycleTelemetryFromRecord = (value: unknown): JudgmentLifecycleTelemetry | undefined => {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return undefined
  }

  const records = value.records.flatMap((record) => {
    const lifecycleRecord = getLifecycleRecordFromRecord(record)

    return lifecycleRecord ? [lifecycleRecord] : []
  })

  return records.length === 0 ? undefined : getJudgmentLifecycleTelemetry({records})
}

const getTelemetrySnapshotFromRecord = (value: unknown): JudgmentDispatchTelemetrySnapshot | null => {
  if (!isRecord(value)) {
    return null
  }

  const dispatch = getDispatchTelemetryFromRecord(value.dispatch)
  const request = getRequestStatsFromRecord(value.request)
  const lifecycle = getLifecycleTelemetryFromRecord(value.lifecycle)
  const provider = getProviderTelemetryFromRecord(value.provider)
  const source = provider
    ? getTelemetrySourceFromRecord(
        value.source,
        provider.providerKey,
        provider.endpointDiagnostics.map((diagnostics) => {
          return diagnostics.endpointAvailabilityKey
        }),
      )
    : null

  return dispatch === null || request === null || provider === null
    ? null
    : {
        dispatch,
        ...(lifecycle ? {lifecycle} : {}),
        provider,
        request,
        source:
          source
          ?? getTelemetrySourceMetadata({
            freshWorkerCount: 1,
            providerKey: provider.providerKey,
            staleWorkerCount: 0,
            unavailableWorkerCount: 0,
          }),
      }
}

const getTelemetrySnapshotFromResponseBody = (value: unknown): JudgmentDispatchTelemetrySnapshot | null => {
  return isRecord(value) ? getTelemetrySnapshotFromRecord(value.data) : null
}

const readResponseJson = (response: Response): Promise<unknown> => {
  return response.json() as Promise<unknown>
}

const getWorkerTelemetryUrl = (record: DuckdbOwnerConnectionRecord, input: JudgmentDispatchTelemetryInput): string => {
  const url = new URL(
    `${judgmentDispatchTelemetryPath}/${encodeURIComponent(input.jobId)}`,
    `http://127.0.0.1:${record.listenPort}`,
  )

  if (input.providerConnectionId) {
    url.searchParams.set('providerConnectionId', input.providerConnectionId)
  }

  if (input.providerFamily) {
    url.searchParams.set('providerFamily', input.providerFamily)
  }

  if (input.providerId) {
    url.searchParams.set('providerId', input.providerId)
  }

  if (input.providerKey) {
    url.searchParams.set('providerKey', input.providerKey)
  }

  if (input.providerLimit !== null && input.providerLimit !== undefined) {
    url.searchParams.set('providerLimit', String(input.providerLimit))
  }

  if (input.providerLimitVersion) {
    url.searchParams.set('providerLimitVersion', input.providerLimitVersion)
  }

  if (input.providerName) {
    url.searchParams.set('providerName', input.providerName)
  }

  if (input.modelId) {
    url.searchParams.set('modelId', input.modelId)
  }

  if (input.modelProvider) {
    url.searchParams.set('modelProvider', input.modelProvider)
  }

  if (input.providerMaxInflightRequests !== null) {
    url.searchParams.set('providerMaxInflightRequests', String(input.providerMaxInflightRequests))
  }

  if (input.readyCount !== null && input.readyCount !== undefined) {
    url.searchParams.set('readyCount', String(input.readyCount))
  }

  if (input.resolvedDefaultCapacity !== null && input.resolvedDefaultCapacity !== undefined) {
    url.searchParams.set('resolvedDefaultCapacity', String(input.resolvedDefaultCapacity))
  }

  url.searchParams.set('providerUsesFamilyDefault', String(input.providerUsesFamilyDefault))

  return url.toString()
}

const fetchWorkerJudgmentDispatchTelemetry = async (
  record: DuckdbOwnerConnectionRecord,
  input: JudgmentDispatchTelemetryInput,
): Promise<JudgmentDispatchTelemetrySnapshot | null> => {
  const response = await fetch(getWorkerTelemetryUrl(record, input), {
    signal: AbortSignal.timeout(workerTelemetryTimeoutMs),
  }).catch(() => {
    return null
  })
  const body: unknown = response?.ok
    ? await readResponseJson(response).catch(() => {
        return null
      })
    : null

  return getTelemetrySnapshotFromResponseBody(body)
}

const getUniqueJudgingWorkerRecords = (records: DuckdbOwnerConnectionRecord[]): DuckdbOwnerConnectionRecord[] => {
  return records.reduce<DuckdbOwnerConnectionRecord[]>((uniqueRecords, record) => {
    const isDuplicate = uniqueRecords.some((uniqueRecord) => {
      return uniqueRecord.instanceId === record.instanceId
    })

    return isDuplicate ? uniqueRecords : [...uniqueRecords, record]
  }, [])
}

const getJudgingWorkerRecords = async (): Promise<DuckdbOwnerConnectionRecord[]> => {
  const overview = await getDuckdbOwnerConnectionsOverview()
  const records = [overview.owner, ...overview.followers].filter((record): record is DuckdbOwnerConnectionRecord => {
    return record !== null
  })
  const judgingRecords = records.filter((record) => {
    return record.capabilities.includes('judging') && !record.isCurrentProcess
  })

  return getUniqueJudgingWorkerRecords(judgingRecords)
}

const getPromptToProcessFromJson = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown

    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

const getProviderKeyForTelemetryInput = (input: JudgmentDispatchTelemetryInput): string => {
  return getJudgmentDispatchProviderKey(input)
}

const mergeQueueRequestAttempts = (
  rows: Array<JudgmentRequestAttemptJsonEntry[] | string | null | undefined>,
): string | null => {
  const attemptsById = rows
    .flatMap((row) => {
      return parseRequestAttempts(row)
    })
    .reduce((map, entry) => {
      return new Map(map).set(entry.requestAttemptId, entry)
    }, new Map<string, JudgmentRequestAttemptJsonEntry>())
  const requestAttempts = Array.from(attemptsById.values())

  return stringifyRequestAttempts(requestAttempts)
}

const getQueuePromptLifecycleRecords = ({
  providerKey,
  rows,
}: {
  providerKey: string
  rows: JudgmentJobQueuePromptLifecycleRow[]
}): JudgmentLifecycleTelemetryRecord[] => {
  return rows.flatMap((row) => {
    const requestAttempts = mergeQueueRequestAttempts([
      row.requestAttemptManifestJson,
      row.outboxRequestAttemptsJson,
      row.ackRequestAttemptsJson,
    ])
    const promptRecord = getJudgmentPromptLifecycleTelemetryRecord({
      createdAt: row.createdAt,
      jobId: row.jobId,
      judgedAt: row.judgedAt,
      noRequestSuccessReason: row.noRequestSuccessReason,
      promptId: row.promptId,
      promptCloseoutReason: row.promptCloseoutReason,
      promptTerminalState: row.promptTerminalState,
      providerKey,
      queueRecordId: row.queueRecordId,
      requestAttempts,
      sentAt: row.sentAt,
      status: row.status,
      terminalKind: row.terminalKind ?? row.skipReason,
      updatedAt: row.updatedAt,
    })
    const requestRecords = getRequestAttemptLifecycleTelemetryRecords({
      fallbackJobId: row.jobId,
      fallbackProviderKey: providerKey,
      requestAttempts,
    })

    return promptRecord ? [promptRecord, ...requestRecords] : requestRecords
  })
}

const getAcceptedClaimLifecycleRecords = ({
  fallbackProviderKey,
  jobId,
}: {
  fallbackProviderKey: string
  jobId: string
}): JudgmentLifecycleTelemetryRecord[] => {
  return getAcceptedJudgeWorkerClaimLifecycleRows(jobId).flatMap((row) => {
    const payload = getPromptToProcessFromJson(row.payloadJson)
    const providerKey = getStringValue(payload?.providerKey) ?? fallbackProviderKey
    const promptRecord = getJudgmentPromptLifecycleTelemetryRecord({
      acceptedAt: row.acceptedAt,
      createdAt: row.acceptedAt,
      isDispatchQueued: false,
      jobId: row.jobId,
      promptId: getStringValue(payload?.promptId),
      providerKey,
      queueRecordId: row.queueRecordId,
      requestAttempts: row.requestAttemptManifestJson,
      status: 'claimed',
      updatedAt: row.updatedAt,
    })
    const requestRecords = getRequestAttemptLifecycleTelemetryRecords({
      fallbackJobId: row.jobId,
      fallbackProviderKey: providerKey,
      requestAttempts: row.requestAttemptManifestJson,
    })

    return promptRecord ? [promptRecord, ...requestRecords] : requestRecords
  })
}

const getLocalLifecycleTelemetry = async (
  input: JudgmentDispatchTelemetryInput,
): Promise<JudgmentLifecycleTelemetry | undefined> => {
  const providerKey = getProviderKeyForTelemetryInput(input)
  const [dispatchRecords, queueRows] = await Promise.all([
    getJudgmentDispatchPromptLifecycleRecords(input),
    getJudgmentJobSqliteService().getQueuePromptLifecycleRows(input.jobId),
  ])
  const queueRecords = getQueuePromptLifecycleRecords({providerKey, rows: queueRows})
  const acceptedClaimRecords = shouldUseJudgeWorkerOwnerHandoff()
    ? getAcceptedClaimLifecycleRecords({fallbackProviderKey: providerKey, jobId: input.jobId})
    : []
  const requestRuntimeRecords = getJudgmentRequestLifecycleRecords(input.jobId)
  const records = [...queueRecords, ...acceptedClaimRecords, ...dispatchRecords, ...requestRuntimeRecords]

  return records.length === 0 ? undefined : getJudgmentLifecycleTelemetry({records})
}

const getPositiveInteger = (value: number | null | undefined): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : null
}

const getProviderBucketSnapshotFromInput = (input: JudgmentDispatchTelemetryInput): ProviderBucketSnapshot => {
  const computedSnapshot = getProviderBucketSnapshot({
    maxInflightRequests: input.providerUsesFamilyDefault ? null : input.providerMaxInflightRequests,
    modelId: input.modelId,
    modelProvider: input.modelProvider,
    providerConnectionId: input.providerConnectionId,
    providerName: input.providerName,
    useOwnerBackedSyntheticProviderId: shouldUseJudgeWorkerOwnerHandoff(),
  })
  const providerLimit = getPositiveInteger(input.providerLimit)
  const resolvedDefaultCapacity = getPositiveInteger(input.resolvedDefaultCapacity)
  const providerKey = getStringValue(input.providerKey) ?? computedSnapshot.providerKey
  const providerFamily = getStringValue(input.providerFamily) ?? computedSnapshot.providerFamily
  const providerId = getStringValue(input.providerId) ?? computedSnapshot.providerId
  const providerLimitVersion = getStringValue(input.providerLimitVersion) ?? computedSnapshot.providerLimitVersion
  const providerName = getStringValue(input.providerName) ?? computedSnapshot.providerName

  return {
    ...computedSnapshot,
    providerFamily,
    providerId,
    providerKey,
    providerLimit: providerLimit ?? computedSnapshot.providerLimit,
    providerLimitVersion,
    providerName,
    resolvedDefaultCapacity: resolvedDefaultCapacity ?? computedSnapshot.resolvedDefaultCapacity,
  }
}

const getConvergenceDiagnostics = ({
  activeHigherPriorityStopRules = [],
  allocationCompleteCurrent,
  allocationInputState,
  backlogReplenishmentAllowed,
  normalRequestCapacity,
  preconditionChangedReason = null,
  preconditionsStableSinceMs = 0,
  providerAvailableRequestLeases,
  providerLimit,
  readyCount,
  targetIncreaseAllowed,
}: {
  activeHigherPriorityStopRules?: string[]
  allocationCompleteCurrent: boolean
  allocationInputState: string
  backlogReplenishmentAllowed?: boolean
  normalRequestCapacity: number
  preconditionChangedReason?: string | null
  preconditionsStableSinceMs?: number
  providerAvailableRequestLeases: number
  providerLimit: number
  readyCount: number
  targetIncreaseAllowed?: boolean
}): JudgmentConvergenceDiagnostics => {
  const providerLimitPositive = providerLimit > 0
  const normalRequestCapacityPositive = normalRequestCapacity > 0
  const providerAcceptingRequests = providerAvailableRequestLeases > 0
  const hasReadyWork = readyCount > 0

  return {
    activeHigherPriorityStopRules,
    allocationCompleteCurrent,
    allocationInputState,
    backlogReplenishmentAllowed:
      backlogReplenishmentAllowed ?? (hasReadyWork && providerAcceptingRequests && normalRequestCapacityPositive),
    hasHealthyEndpointOrEndpointlessPath: true,
    normalRequestCapacityPositive,
    preconditionChangedReason,
    preconditionsStableSinceMs,
    providerAcceptingRequests,
    providerLimitPositive,
    readyCount,
    ...(targetIncreaseAllowed === undefined ? {} : {targetIncreaseAllowed}),
  }
}

const getAllocationSourceMetadata = (
  source: JudgmentTelemetrySourceMetadata,
): ProviderTargetAllocationSnapshot['source'] => {
  return {
    aggregateCompleteness: source.aggregateCompleteness,
    freshWorkerCount: source.freshWorkerCount,
    staleWorkerCount: source.staleWorkerCount,
    unavailableWorkerCount: source.unavailableWorkerCount,
  }
}

const getProviderTargetAllocationWorkerInput = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): ProviderTargetAllocationWorkerInput => {
  return {
    effectiveProviderLimit: snapshot.provider.effectiveProviderLimit,
    localProviderLiveRequests: snapshot.provider.localProviderLiveRequests,
    providerKey: snapshot.provider.providerKey,
    providerLimitVersion: snapshot.provider.providerLimitVersion,
    routeable: snapshot.provider.convergenceDiagnostics.hasHealthyEndpointOrEndpointlessPath,
    workerId: snapshot.source.localWorkerId,
  }
}

const shouldAllocateUnavailableWorkerTelemetry = (provider: JudgmentProviderTelemetry): boolean => {
  return (
    provider.convergenceDiagnostics.readyCount > 0
    && provider.convergenceDiagnostics.hasHealthyEndpointOrEndpointlessPath
    && provider.normalRequestCapacity > 0
    && provider.providerAvailableRequestLeases > 0
  )
}

const getUnavailableProviderTargetAllocationWorkerInput = ({
  authorityProvider,
  workerId,
}: {
  authorityProvider: JudgmentProviderTelemetry
  workerId: string
}): ProviderTargetAllocationWorkerInput => {
  return {
    effectiveProviderLimit: authorityProvider.normalRequestCapacity,
    localProviderLiveRequests: 0,
    providerKey: authorityProvider.providerKey,
    providerLimitVersion: authorityProvider.providerLimitVersion,
    routeable: shouldAllocateUnavailableWorkerTelemetry(authorityProvider),
    workerId,
  }
}

const getReadyWorkCountForController = ({
  input,
  providerKey,
}: {
  input: JudgmentDispatchTelemetryInput
  providerKey: string
}): number => {
  return getJudgmentReadyWorkSignal({
    jobId: input.jobId,
    ownerBacked: shouldUseJudgeWorkerOwnerHandoff(),
    providerKey,
    readyCount: input.readyCount,
  }).readyCount
}

const getLifecycleSummaryAgeMs = (
  lifecycle: JudgmentLifecycleTelemetry | undefined,
  lifecycleState: string,
): number | null => {
  const summary = lifecycle?.summaries.find((entry) => {
    return entry.lifecycleState === lifecycleState
  })

  return summary?.ageMs.maxMs ?? null
}

const getBacklogControllerLifecycleAgesMs = (
  lifecycle: JudgmentLifecycleTelemetry | undefined,
): JudgmentBacklogLifecycleAgesMs => {
  return {
    dispatchQueued: getLifecycleSummaryAgeMs(lifecycle, 'dispatchQueued'),
    hasLiveRequest: getLifecycleSummaryAgeMs(lifecycle, 'hasLiveRequest'),
    persisting: getLifecycleSummaryAgeMs(lifecycle, 'persisting'),
    preparing: getLifecycleSummaryAgeMs(lifecycle, 'preparing'),
    waitingForRequestSlot: getLifecycleSummaryAgeMs(lifecycle, 'waitingForRequestSlot'),
  }
}

type JudgmentBottleneckClassification = {
  bottleneck: JudgmentBottleneck
  bottleneckSource: string
  bottleneckSubreason: JudgmentBottleneckSubreason | null
}

const getLifecycleStateCount = (
  lifecycle: JudgmentLifecycleTelemetry | undefined,
  lifecycleKind: 'prompt' | 'requestAttempt',
  lifecycleState: string,
): number => {
  const summary = lifecycle?.summaries.find((entry) => {
    return entry.lifecycleKind === lifecycleKind && entry.lifecycleState === lifecycleState
  })

  return summary?.count ?? 0
}

const hasLifecycleState = (
  lifecycle: JudgmentLifecycleTelemetry | undefined,
  lifecycleKind: 'prompt' | 'requestAttempt',
  lifecycleState: string,
): boolean => {
  return getLifecycleStateCount(lifecycle, lifecycleKind, lifecycleState) > 0
}

const getLifecycleStateRecord = (
  lifecycle: JudgmentLifecycleTelemetry | undefined,
  lifecycleKind: 'prompt' | 'requestAttempt',
  lifecycleState: string,
): JudgmentLifecycleTelemetry['records'][number] | null => {
  return (
    lifecycle?.records.find((entry) => {
      return entry.lifecycleKind === lifecycleKind && entry.lifecycleState === lifecycleState
    }) ?? null
  )
}

const getCompletionPersistenceSubreason = (value: string | null | undefined): JudgmentBottleneckSubreason => {
  const normalized = value?.trim() ?? ''
  const mapped = new Map<string, JudgmentBottleneckSubreason>([
    ['completion_ack', 'ownerAck'],
    ['completion_outbox', 'completionJournal'],
    ['judgment_outbox', 'judgmentOutbox'],
    ['manifestCasExhausted', 'manifestCasExhausted'],
    ['owner_ack', 'ownerAck'],
    ['owner_completion_body', 'ownerAck'],
    ['owner_token_use_body', 'tokenUsePersistence'],
    ['pending_token_use', 'tokenUsePersistence'],
    ['terminalCleanup', 'terminalCleanup'],
    ['token_use', 'tokenUsePersistence'],
  ])

  return mapped.get(normalized) ?? getCanonicalBottleneckSubreason(normalized) ?? 'persistencePending'
}

const getCompletionPersistenceBottleneck = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentBottleneckClassification | null => {
  const promptRecord = getLifecycleStateRecord(snapshot.lifecycle, 'prompt', 'persisting')
  const requestRecord = getLifecycleStateRecord(snapshot.lifecycle, 'requestAttempt', 'persistingCompletion')
  const promptPersisting = promptRecord !== null
  const requestPersisting = requestRecord !== null
  const knownActiveAttempts = snapshot.request.inFlight + snapshot.request.waitingForRequestSlot
  const pendingPersistence = snapshot.request.pendingPersistedAttempts > knownActiveAttempts
  const record = requestRecord ?? promptRecord

  return promptPersisting || requestPersisting || pendingPersistence
    ? {
        bottleneck: 'completionPersistence',
        bottleneckSource: record
          ? `lifecycle:${record.lifecycleKind}:${record.lifecycleState}`
          : 'request.pendingPersistedAttempts',
        bottleneckSubreason: getCompletionPersistenceSubreason(record?.closeoutReason),
      }
    : null
}

const getEndpointUnavailableSubreason = (
  diagnostics: JudgmentEndpointTelemetryDiagnostics | null,
): JudgmentBottleneckSubreason => {
  const failureKind = diagnostics?.lastFailureKind ?? ''

  return diagnostics?.localProbeState === 'misconfigured' || failureKind === 'endpoint_misconfigured'
    ? 'endpointMisconfigured'
    : diagnostics?.probeInProgress || diagnostics?.localProbeState === 'probing'
      ? 'endpointProbe'
      : diagnostics?.cooldownRemainingMs !== null || diagnostics?.localProbeState === 'cooldown'
        ? 'endpointCooldown'
        : 'endpointUnhealthy'
}

const getEndpointUnavailableBottleneck = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentBottleneckClassification | null => {
  const diagnostics =
    snapshot.provider.endpointDiagnostics.find((entry) => {
      return entry.localProbeState !== 'healthy'
    }) ?? null
  const unavailable = !snapshot.provider.convergenceDiagnostics.hasHealthyEndpointOrEndpointlessPath || diagnostics

  return unavailable
    ? {
        bottleneck: 'endpointUnavailable',
        bottleneckSource: diagnostics
          ? `endpoint:${diagnostics.endpointAvailabilityKey}`
          : 'convergenceDiagnostics.hasHealthyEndpointOrEndpointlessPath',
        bottleneckSubreason: getEndpointUnavailableSubreason(diagnostics),
      }
    : null
}

const getEffectiveCapacityLimitedBottleneck = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentBottleneckClassification | null => {
  const provider = snapshot.provider
  const diagnostics = provider.convergenceDiagnostics
  const hasReadyWork = diagnostics.readyCount > 0
  const targetPositive = provider.targetRequestLiveCalls > 0
  const noEffectiveCapacity =
    provider.effectiveProviderLimit <= 0
    && provider.observedGlobalEffectiveProviderLimit <= 0
    && (targetPositive || hasReadyWork)
  const normalCapacityBlocked = !diagnostics.normalRequestCapacityPositive && (targetPositive || hasReadyWork)
  const routeableCapacityExhausted = provider.unallocatedTargetLiveCalls > 0 && hasReadyWork
  const allocationIncomplete = !provider.allocationCompleteCurrent && routeableCapacityExhausted && targetPositive
  const warmupLimited = diagnostics.preconditionChangedReason === 'warmupLimited'

  return !diagnostics.providerLimitPositive || noEffectiveCapacity || normalCapacityBlocked
    ? {
        bottleneck: 'effectiveCapacityLimited',
        bottleneckSource: !diagnostics.providerLimitPositive
          ? 'convergenceDiagnostics.providerLimitPositive'
          : 'provider.effectiveProviderLimit',
        bottleneckSubreason: 'effectiveCapacityZero',
      }
    : warmupLimited
      ? {
          bottleneck: 'effectiveCapacityLimited',
          bottleneckSource: 'convergenceDiagnostics.preconditionChangedReason',
          bottleneckSubreason: 'warmupLimited',
        }
      : routeableCapacityExhausted || allocationIncomplete
        ? {
            bottleneck: 'effectiveCapacityLimited',
            bottleneckSource: allocationIncomplete
              ? `allocationInputState:${provider.allocationInputState}`
              : 'provider.unallocatedTargetLiveCalls',
            bottleneckSubreason: allocationIncomplete ? 'allocationSnapshotIncomplete' : 'routeableCapacityExhausted',
          }
        : null
}

const hasRequestPressure = (snapshot: JudgmentDispatchTelemetrySnapshot): boolean => {
  return (
    snapshot.provider.convergenceDiagnostics.readyCount > 0
    || snapshot.provider.localPromptBacklog > 0
    || snapshot.provider.localRequestWorkBacklog > 0
    || snapshot.request.waitingForRequestSlot > 0
  )
}

const providerLiveRequestsBelowTarget = (snapshot: JudgmentDispatchTelemetrySnapshot): boolean => {
  return (
    snapshot.provider.targetRequestLiveCalls > 0
    && snapshot.provider.providerLeasedLiveRequests < snapshot.provider.targetRequestLiveCalls
  )
}

const hasRequestSlotWait = (snapshot: JudgmentDispatchTelemetrySnapshot): boolean => {
  return (
    snapshot.request.waitingForRequestSlot > 0
    || hasLifecycleState(snapshot.lifecycle, 'prompt', 'waitingForRequestSlot')
    || hasLifecycleState(snapshot.lifecycle, 'requestAttempt', 'waitingForRequestSlot')
  )
}

const getWorkerCapacitySaturatedBottleneck = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentBottleneckClassification | null => {
  const waiterCount = snapshot.request.requestSlotWaiters?.worker ?? 0
  const fallbackWaiterCount = snapshot.request.requestSlotWaiters?.fallback ?? 0
  const observedCapacityFilled =
    snapshot.provider.observedGlobalEffectiveProviderLimit > 0
    && snapshot.provider.observedGlobalProviderLiveRequests >= snapshot.provider.observedGlobalEffectiveProviderLimit
  const localCapacityFilled =
    snapshot.provider.effectiveProviderLimit > 0
    && snapshot.provider.localProviderLiveRequests >= snapshot.provider.effectiveProviderLimit
  const saturated = providerLiveRequestsBelowTarget(snapshot) && hasRequestSlotWait(snapshot)
  const source = waiterCount > 0 ? 'request.requestSlotWaiters.worker' : 'observedGlobalEffectiveProviderLimit'

  return saturated && fallbackWaiterCount === 0 && (waiterCount > 0 || observedCapacityFilled || localCapacityFilled)
    ? {bottleneck: 'workerCapacitySaturated', bottleneckSource: source, bottleneckSubreason: 'localWorkerAtCapacity'}
    : null
}

const getFallbackCapacitySaturatedBottleneck = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentBottleneckClassification | null => {
  const waiterCount = snapshot.request.requestSlotWaiters?.fallback ?? 0

  return providerLiveRequestsBelowTarget(snapshot) && waiterCount > 0
    ? {
        bottleneck: 'fallbackCapacitySaturated',
        bottleneckSource: 'request.requestSlotWaiters.fallback',
        bottleneckSubreason: 'sharedFallbackAtCapacity',
      }
    : null
}

const getProviderSaturatedBottleneck = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentBottleneckClassification | null => {
  const provider = snapshot.provider
  const saturated = provider.providerLimit > 0 && provider.providerLeasedPhysicalCalls >= provider.providerLimit

  return saturated && hasRequestPressure(snapshot)
    ? {
        bottleneck: 'providerSaturated',
        bottleneckSource: 'provider.providerLeasedPhysicalCalls',
        bottleneckSubreason: 'providerPhysicalCap',
      }
    : null
}

const getProviderAtTargetBottleneck = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentBottleneckClassification | null => {
  const provider = snapshot.provider
  const atTarget =
    provider.targetRequestLiveCalls > 0
    && provider.providerLeasedLiveRequests >= provider.targetRequestLiveCalls
    && provider.providerLeasedPhysicalCalls < provider.providerLimit

  return atTarget && hasRequestPressure(snapshot)
    ? {
        bottleneck: 'providerAtTarget',
        bottleneckSource: 'provider.providerLeasedLiveRequests',
        bottleneckSubreason: 'providerTargetReached',
      }
    : null
}

const getPromptPreparationBottleneck = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentBottleneckClassification | null => {
  const preparing = hasLifecycleState(snapshot.lifecycle, 'prompt', 'preparing')

  return preparing && providerLiveRequestsBelowTarget(snapshot)
    ? {
        bottleneck: 'promptPreparation',
        bottleneckSource: 'lifecycle:prompt:preparing',
        bottleneckSubreason: 'promptPreparationBacklog',
      }
    : null
}

const getRequestSlotWaitSubreason = (snapshot: JudgmentDispatchTelemetrySnapshot): JudgmentRequestSlotWaitSubreason => {
  const waitRecord =
    getLifecycleStateRecord(snapshot.lifecycle, 'requestAttempt', 'waitingForRequestSlot')
    ?? getLifecycleStateRecord(snapshot.lifecycle, 'prompt', 'waitingForRequestSlot')
  const recordSubreason = getCanonicalRequestSlotWaitSubreason(waitRecord?.closeoutReason)
  const waiters = snapshot.request.requestSlotWaiters

  return (
    recordSubreason
    ?? (waiters?.providerAdmission ? 'leaseAcquireContention' : null)
    ?? (waiters?.codex ? 'leaseAcquireContention' : null)
    ?? (snapshot.source.telemetryUnavailable ? 'ownerAdmissionUnavailable' : null)
    ?? 'noAcquireAttemptRecorded'
  )
}

const getRequestSlotWaitBottleneck = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentBottleneckClassification | null => {
  return hasRequestSlotWait(snapshot) && providerLiveRequestsBelowTarget(snapshot)
    ? {
        bottleneck: 'requestSlotWait',
        bottleneckSource: 'lifecycle:requestAttempt:waitingForRequestSlot',
        bottleneckSubreason: getRequestSlotWaitSubreason(snapshot),
      }
    : null
}

const getClaimingBottleneck = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentBottleneckClassification | null => {
  const readyCount = snapshot.provider.convergenceDiagnostics.readyCount
  const belowTarget = providerLiveRequestsBelowTarget(snapshot)
  const stableEnough =
    snapshot.provider.convergenceDiagnostics.preconditionsStableSinceMs
    >= judgmentBacklogControllerConstants.successfulLeaseWindowMs
  const underfed =
    snapshot.provider.localPromptBacklog < snapshot.provider.localPromptBacklogTarget
    || snapshot.provider.localRequestWorkBacklog < snapshot.provider.localRequestWorkBacklogTarget
    || stableEnough

  return readyCount > 0 && belowTarget && underfed
    ? {
        bottleneck: 'claiming',
        bottleneckSource: 'convergenceDiagnostics.readyCount',
        bottleneckSubreason: 'promptClaimBacklog',
      }
    : null
}

const getNoReadyWorkBottleneck = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentBottleneckClassification | null => {
  return snapshot.provider.convergenceDiagnostics.readyCount <= 0
    ? {
        bottleneck: 'noReadyWork',
        bottleneckSource: 'convergenceDiagnostics.readyCount',
        bottleneckSubreason: 'readyWorkUnavailable',
      }
    : null
}

const getBottleneckClassification = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentBottleneckClassification | null => {
  return (
    getCompletionPersistenceBottleneck(snapshot)
    ?? getEndpointUnavailableBottleneck(snapshot)
    ?? getEffectiveCapacityLimitedBottleneck(snapshot)
    ?? getWorkerCapacitySaturatedBottleneck(snapshot)
    ?? getFallbackCapacitySaturatedBottleneck(snapshot)
    ?? getProviderSaturatedBottleneck(snapshot)
    ?? getProviderAtTargetBottleneck(snapshot)
    ?? getPromptPreparationBottleneck(snapshot)
    ?? getRequestSlotWaitBottleneck(snapshot)
    ?? getClaimingBottleneck(snapshot)
    ?? getNoReadyWorkBottleneck(snapshot)
  )
}

const withBottleneckClassification = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
): JudgmentDispatchTelemetrySnapshot => {
  const classification = getBottleneckClassification(snapshot)

  return {
    ...snapshot,
    provider: {
      ...snapshot.provider,
      bottleneck: classification?.bottleneck ?? null,
      bottleneckSource: classification?.bottleneckSource ?? null,
      bottleneckSubreason: classification?.bottleneckSubreason ?? null,
    },
  }
}

const getLocalProviderTelemetry = async ({
  dispatch,
  input,
  lifecycle,
  request,
}: {
  dispatch: JudgmentDispatchPromptTelemetry
  input: JudgmentDispatchTelemetryInput
  lifecycle?: JudgmentLifecycleTelemetry
  request: JudgmentDispatchTelemetrySnapshot['request']
}): Promise<JudgmentProviderTelemetry> => {
  const snapshot = getProviderBucketSnapshotFromInput(input)
  const leaseTelemetry = await getProviderAdmissionLeaseTelemetry({providerKey: snapshot.providerKey}).catch(() => {
    return {
      providerKey: snapshot.providerKey,
      providerLeasedLiveRequests: 0,
      providerLeasedProbeCalls: 0,
      providerProbeOccupancyVersion: defaultProviderProbeOccupancyVersion,
      sampledAtMs: Date.now(),
    }
  })
  const providerLeasedPhysicalCalls =
    leaseTelemetry.providerLeasedLiveRequests + leaseTelemetry.providerLeasedProbeCalls
  const localProviderLiveRequests = getJudgmentProviderRequestStats({
    modelId: input.modelId,
    modelProvider: input.modelProvider,
    providerConnectionId: input.providerConnectionId,
    providerKey: snapshot.providerKey,
    providerMaxInflightRequests: input.providerMaxInflightRequests,
  }).localProviderLiveRequests
  const allocationSource = {
    aggregateCompleteness: 'complete' as const,
    freshWorkerCount: 1,
    staleWorkerCount: 0,
    unavailableWorkerCount: 0,
  }
  const providerTargetAllocationSnapshot = getProviderTargetAllocationSnapshot({
    probeOccupancySampledAtMs: leaseTelemetry.sampledAtMs,
    providerKey: snapshot.providerKey,
    providerLeasedLiveRequests: leaseTelemetry.providerLeasedLiveRequests,
    providerLeasedProbeCalls: leaseTelemetry.providerLeasedProbeCalls,
    providerLimit: snapshot.providerLimit,
    providerLimitVersion: snapshot.providerLimitVersion,
    providerProbeOccupancyVersion: leaseTelemetry.providerProbeOccupancyVersion,
    source: allocationSource,
    workers: [
      {
        effectiveProviderLimit: snapshot.providerLimit,
        localProviderLiveRequests,
        providerKey: snapshot.providerKey,
        providerLimitVersion: snapshot.providerLimitVersion,
        routeable: true,
        workerId: getDefaultJudgmentServerJobId(),
      },
    ],
  })
  const localWorkerAllocation = getProviderTargetAllocationWorkerSnapshot({
    snapshot: providerTargetAllocationSnapshot,
    workerId: getDefaultJudgmentServerJobId(),
  })
  const providerAvailableRequestLeases = providerTargetAllocationSnapshot.providerAvailableRequestLeases
  const normalRequestCapacity = providerTargetAllocationSnapshot.normalRequestCapacity
  const targetRequestLiveCalls = providerTargetAllocationSnapshot.targetRequestLiveCalls
  const effectiveProviderLimit = localWorkerAllocation?.effectiveProviderLimit ?? 0
  const expectedLocalLiveShare = localWorkerAllocation?.expectedLocalLiveShare ?? 0
  const localPromptBacklog = dispatch.providerDispatchActivePrompts + dispatch.providerDispatchQueuedPrompts
  const localRequestWorkBacklog = Math.max(localProviderLiveRequests, request.requestWorkBacklog)
  const allocationInputState = providerTargetAllocationSnapshot.allocationInputState
  const allocationCompleteCurrent = providerTargetAllocationSnapshot.allocationCompleteCurrent
  const readyCount = getReadyWorkCountForController({input, providerKey: snapshot.providerKey})
  const controller = getJudgmentBacklogControllerState({
    allocationCompleteCurrent,
    effectiveProviderLimit,
    expectedLocalLiveShare,
    hasHealthyEndpointOrEndpointlessPath: true,
    lifecycleAgesMs: getBacklogControllerLifecycleAgesMs(lifecycle),
    localPromptBacklog,
    localPromptBacklogTarget: dispatch.providerDispatchActivePromptLimit + dispatch.providerDispatchQueueLimit,
    localProviderLiveRequests,
    localRequestWorkBacklog,
    localRequestWorkBacklogTarget: expectedLocalLiveShare,
    normalRequestCapacity,
    providerAvailableRequestLeases,
    providerLeasedProbeCalls: leaseTelemetry.providerLeasedProbeCalls,
    providerLimit: snapshot.providerLimit,
    readyCount,
  })
  const convergenceDiagnostics = getConvergenceDiagnostics({
    allocationCompleteCurrent,
    allocationInputState,
    backlogReplenishmentAllowed: controller.backlogReplenishmentAllowed,
    normalRequestCapacity,
    preconditionChangedReason: controller.preconditionChangedReason,
    preconditionsStableSinceMs: controller.preconditionsStableSinceMs,
    providerAvailableRequestLeases,
    providerLimit: snapshot.providerLimit,
    readyCount,
    targetIncreaseAllowed: controller.targetIncreaseAllowed,
  })

  return withProviderApiReadModels({
    allocationCompleteCurrent,
    allocationInputState,
    bottleneck: null,
    bottleneckSource: null,
    bottleneckSubreason: null,
    convergenceDiagnostics,
    effectiveProviderLimit,
    endpointDiagnostics: [],
    expectedLocalLiveShare,
    localAdditionalLeaseHeadroom: controller.localAdditionalLeaseHeadroom,
    localAdditionalTargetHeadroom: controller.localAdditionalTargetHeadroom,
    localPromptBacklog,
    localPromptBacklogTarget: controller.localPromptBacklogTarget,
    localProviderLiveRequests,
    localProviderRequestFillPct: getFillPct(localProviderLiveRequests, effectiveProviderLimit),
    localRequestWorkBacklog,
    localRequestWorkBacklogTarget: controller.localRequestWorkBacklogTarget,
    normalRequestCapacity,
    observedAggregateLabel: 'bestEffort',
    observedGlobalEffectiveProviderLimit: effectiveProviderLimit,
    observedGlobalPromptBacklog: localPromptBacklog,
    observedGlobalProviderLiveRequests: localProviderLiveRequests,
    observedGlobalProviderRequestFillPct: getFillPct(localProviderLiveRequests, effectiveProviderLimit),
    observedGlobalRequestWorkBacklog: localRequestWorkBacklog,
    probeOccupancySampledAtMs: providerTargetAllocationSnapshot.probeOccupancySampledAtMs,
    providerAllocationVersion: providerTargetAllocationSnapshot.providerAllocationVersion,
    providerAvailableRequestLeases,
    providerKey: snapshot.providerKey,
    providerLeasedLiveRequests: leaseTelemetry.providerLeasedLiveRequests,
    providerLeasedPhysicalCalls,
    providerLeasedProbeCalls: leaseTelemetry.providerLeasedProbeCalls,
    providerLimit: snapshot.providerLimit,
    providerLimitVersion: snapshot.providerLimitVersion,
    providerProbeOccupancyVersion: leaseTelemetry.providerProbeOccupancyVersion,
    providerRequestFillPct: getFillPct(leaseTelemetry.providerLeasedLiveRequests, normalRequestCapacity),
    providerTargetAllocationSnapshot,
    targetRequestLiveCalls,
    unallocatedTargetLiveCalls: providerTargetAllocationSnapshot.unallocatedTargetLiveCalls,
  })
}

export const getLocalJudgmentDispatchTelemetry = async (
  input: JudgmentDispatchTelemetryInput,
): Promise<JudgmentDispatchTelemetrySnapshot> => {
  const [dispatchStats, lifecycle] = await Promise.all([
    getJudgmentDispatchProviderStats(input),
    getLocalLifecycleTelemetry(input),
  ])
  const dispatch = getDispatchTelemetryFromStats(dispatchStats)
  const request = getJudgmentRequestStats(input.jobId)
  const provider = await getLocalProviderTelemetry({dispatch, input, lifecycle, request})
  const source = getTelemetrySourceMetadata({
    freshWorkerCount: 1,
    providerKey: provider.providerKey,
    staleWorkerCount: 0,
    unavailableWorkerCount: 0,
  })

  return withBottleneckClassification({dispatch, ...(lifecycle ? {lifecycle} : {}), provider, request, source})
}

const withTelemetryWorkerId = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
  workerId: string,
): JudgmentDispatchTelemetrySnapshot => {
  return {...snapshot, source: {...snapshot.source, localWorkerId: workerId}}
}

const getUnavailableWorkerTelemetrySnapshot = ({
  authorityProvider,
  source,
  workerId,
}: {
  authorityProvider: JudgmentProviderTelemetry
  source: JudgmentTelemetrySourceMetadata
  workerId: string
}): JudgmentDispatchTelemetrySnapshot => {
  return {
    dispatch: getZeroDispatchStats(),
    provider: withProviderApiReadModels({
      ...authorityProvider,
      effectiveProviderLimit: 0,
      expectedLocalLiveShare: 0,
      localAdditionalLeaseHeadroom: 0,
      localAdditionalTargetHeadroom: 0,
      localPromptBacklog: 0,
      localPromptBacklogTarget: 0,
      localProviderLiveRequests: 0,
      localProviderRequestFillPct: null,
      localRequestWorkBacklog: 0,
      localRequestWorkBacklogTarget: 0,
      observedGlobalEffectiveProviderLimit: 0,
      observedGlobalPromptBacklog: 0,
      observedGlobalProviderLiveRequests: 0,
      observedGlobalProviderRequestFillPct: null,
      observedGlobalRequestWorkBacklog: 0,
    }),
    request: {
      inFlight: 0,
      pendingPersistedAttempts: 0,
      requestSlotWaiters: {codex: 0, fallback: 0, providerAdmission: 0, worker: 0},
      requestWorkBacklog: 0,
      waitingForRequestSlot: 0,
    },
    source: {...source, localWorkerId: workerId},
  }
}

const getProviderTargetAllocationSnapshotForTelemetry = ({
  authorityProvider,
  snapshots,
  source,
  unavailableWorkerIds,
}: {
  authorityProvider: JudgmentProviderTelemetry
  snapshots: JudgmentDispatchTelemetrySnapshot[]
  source: JudgmentTelemetrySourceMetadata
  unavailableWorkerIds: string[]
}): ProviderTargetAllocationSnapshot => {
  const unavailableWorkers = shouldAllocateUnavailableWorkerTelemetry(authorityProvider)
    ? unavailableWorkerIds.map((workerId) => {
        return getUnavailableProviderTargetAllocationWorkerInput({authorityProvider, workerId})
      })
    : []

  return getProviderTargetAllocationSnapshot({
    probeOccupancySampledAtMs: authorityProvider.probeOccupancySampledAtMs,
    providerKey: authorityProvider.providerKey,
    providerLeasedLiveRequests: authorityProvider.providerLeasedLiveRequests,
    providerLeasedProbeCalls: authorityProvider.providerLeasedProbeCalls,
    providerLimit: authorityProvider.providerLimit,
    providerLimitVersion: authorityProvider.providerLimitVersion,
    providerProbeOccupancyVersion: authorityProvider.providerProbeOccupancyVersion,
    source: getAllocationSourceMetadata(source),
    workers: [...snapshots.map(getProviderTargetAllocationWorkerInput), ...unavailableWorkers],
  })
}

const withProviderTargetAllocationSnapshot = ({
  allocationSnapshot,
  snapshot,
}: {
  allocationSnapshot: ProviderTargetAllocationSnapshot
  snapshot: JudgmentDispatchTelemetrySnapshot
}): JudgmentDispatchTelemetrySnapshot => {
  const workerAllocation = getProviderTargetAllocationWorkerSnapshot({
    snapshot: allocationSnapshot,
    workerId: snapshot.source.localWorkerId,
  })
  const expectedLocalLiveShare = workerAllocation?.expectedLocalLiveShare ?? 0
  const effectiveProviderLimit = workerAllocation?.effectiveProviderLimit ?? 0
  const controller = getJudgmentBacklogControllerState({
    activeHigherPriorityStopRules: snapshot.provider.convergenceDiagnostics.activeHigherPriorityStopRules,
    allocationCompleteCurrent: allocationSnapshot.allocationCompleteCurrent,
    effectiveProviderLimit,
    expectedLocalLiveShare,
    hasHealthyEndpointOrEndpointlessPath: snapshot.provider.convergenceDiagnostics.hasHealthyEndpointOrEndpointlessPath,
    lifecycleAgesMs: getBacklogControllerLifecycleAgesMs(snapshot.lifecycle),
    localPromptBacklog: snapshot.provider.localPromptBacklog,
    localPromptBacklogTarget: snapshot.provider.localPromptBacklogTarget,
    localProviderLiveRequests: snapshot.provider.localProviderLiveRequests,
    localRequestWorkBacklog: snapshot.provider.localRequestWorkBacklog,
    localRequestWorkBacklogTarget: snapshot.provider.localRequestWorkBacklogTarget,
    normalRequestCapacity: allocationSnapshot.normalRequestCapacity,
    preconditionsStableSinceMs: snapshot.provider.convergenceDiagnostics.preconditionsStableSinceMs,
    providerAvailableRequestLeases: allocationSnapshot.providerAvailableRequestLeases,
    providerLeasedProbeCalls: allocationSnapshot.providerLeasedProbeCalls,
    providerLimit: allocationSnapshot.providerLimit,
    readyCount: snapshot.provider.convergenceDiagnostics.readyCount,
  })
  const convergenceDiagnostics = {
    ...getConvergenceDiagnostics({
      allocationCompleteCurrent: allocationSnapshot.allocationCompleteCurrent,
      allocationInputState: allocationSnapshot.allocationInputState,
      backlogReplenishmentAllowed: controller.backlogReplenishmentAllowed,
      normalRequestCapacity: allocationSnapshot.normalRequestCapacity,
      preconditionChangedReason: controller.preconditionChangedReason,
      preconditionsStableSinceMs: controller.preconditionsStableSinceMs,
      providerAvailableRequestLeases: allocationSnapshot.providerAvailableRequestLeases,
      providerLimit: allocationSnapshot.providerLimit,
      readyCount: snapshot.provider.convergenceDiagnostics.readyCount,
      targetIncreaseAllowed: controller.targetIncreaseAllowed,
    }),
    activeHigherPriorityStopRules: snapshot.provider.convergenceDiagnostics.activeHigherPriorityStopRules,
    hasHealthyEndpointOrEndpointlessPath: snapshot.provider.convergenceDiagnostics.hasHealthyEndpointOrEndpointlessPath,
  }
  const provider = withProviderApiReadModels({
    ...snapshot.provider,
    allocationCompleteCurrent: allocationSnapshot.allocationCompleteCurrent,
    allocationInputState: allocationSnapshot.allocationInputState,
    convergenceDiagnostics,
    effectiveProviderLimit,
    expectedLocalLiveShare,
    localAdditionalLeaseHeadroom: controller.localAdditionalLeaseHeadroom,
    localAdditionalTargetHeadroom: controller.localAdditionalTargetHeadroom,
    localPromptBacklogTarget: controller.localPromptBacklogTarget,
    localProviderRequestFillPct: getFillPct(snapshot.provider.localProviderLiveRequests, effectiveProviderLimit),
    localRequestWorkBacklogTarget: controller.localRequestWorkBacklogTarget,
    normalRequestCapacity: allocationSnapshot.normalRequestCapacity,
    probeOccupancySampledAtMs: allocationSnapshot.probeOccupancySampledAtMs,
    providerAllocationVersion: allocationSnapshot.providerAllocationVersion,
    providerAvailableRequestLeases: allocationSnapshot.providerAvailableRequestLeases,
    providerLeasedLiveRequests: allocationSnapshot.providerLeasedLiveRequests,
    providerLeasedPhysicalCalls: allocationSnapshot.providerLeasedPhysicalCalls,
    providerLeasedProbeCalls: allocationSnapshot.providerLeasedProbeCalls,
    providerLimit: allocationSnapshot.providerLimit,
    providerLimitVersion: allocationSnapshot.providerLimitVersion,
    providerProbeOccupancyVersion: allocationSnapshot.providerProbeOccupancyVersion,
    providerRequestFillPct: getFillPct(
      allocationSnapshot.providerLeasedLiveRequests,
      allocationSnapshot.normalRequestCapacity,
    ),
    providerTargetAllocationSnapshot: allocationSnapshot,
    targetRequestLiveCalls: allocationSnapshot.targetRequestLiveCalls,
    unallocatedTargetLiveCalls: allocationSnapshot.unallocatedTargetLiveCalls,
  })

  return {...snapshot, provider}
}

const addRequestSlotWaiters = (
  left: JudgmentRequestSlotWaiterTelemetry | undefined,
  right: JudgmentRequestSlotWaiterTelemetry | undefined,
): JudgmentRequestSlotWaiterTelemetry => {
  return {
    codex: (left?.codex ?? 0) + (right?.codex ?? 0),
    fallback: (left?.fallback ?? 0) + (right?.fallback ?? 0),
    providerAdmission: (left?.providerAdmission ?? 0) + (right?.providerAdmission ?? 0),
    worker: (left?.worker ?? 0) + (right?.worker ?? 0),
  }
}

const mergeJudgmentDispatchTelemetrySnapshots = (
  snapshots: JudgmentDispatchTelemetrySnapshot[],
  source: JudgmentTelemetrySourceMetadata,
  authorityProvider?: JudgmentProviderTelemetry,
): JudgmentDispatchTelemetrySnapshot => {
  const mergedSnapshot = snapshots.reduce<JudgmentDispatchTelemetrySnapshot>((merged, snapshot) => {
    return {
      dispatch: {
        jobActivePrompts: merged.dispatch.jobActivePrompts + snapshot.dispatch.jobActivePrompts,
        jobQueuedPrompts: merged.dispatch.jobQueuedPrompts + snapshot.dispatch.jobQueuedPrompts,
        providerDispatchActivePromptFillPct: getFillPct(
          merged.dispatch.providerDispatchActivePrompts + snapshot.dispatch.providerDispatchActivePrompts,
          merged.dispatch.providerDispatchActivePromptLimit + snapshot.dispatch.providerDispatchActivePromptLimit,
        ),
        providerDispatchActivePromptLimit:
          merged.dispatch.providerDispatchActivePromptLimit + snapshot.dispatch.providerDispatchActivePromptLimit,
        providerDispatchActivePrompts:
          merged.dispatch.providerDispatchActivePrompts + snapshot.dispatch.providerDispatchActivePrompts,
        providerDispatchPrefetchFillPct: getFillPct(
          merged.dispatch.providerDispatchQueuedPrompts + snapshot.dispatch.providerDispatchQueuedPrompts,
          merged.dispatch.providerDispatchQueueLimit + snapshot.dispatch.providerDispatchQueueLimit,
        ),
        providerDispatchQueueLimit:
          merged.dispatch.providerDispatchQueueLimit + snapshot.dispatch.providerDispatchQueueLimit,
        providerDispatchQueuedPrompts:
          merged.dispatch.providerDispatchQueuedPrompts + snapshot.dispatch.providerDispatchQueuedPrompts,
      },
      request: {
        inFlight: merged.request.inFlight + snapshot.request.inFlight,
        pendingPersistedAttempts: merged.request.pendingPersistedAttempts + snapshot.request.pendingPersistedAttempts,
        requestSlotWaiters: addRequestSlotWaiters(
          merged.request.requestSlotWaiters,
          snapshot.request.requestSlotWaiters,
        ),
        requestWorkBacklog: merged.request.requestWorkBacklog + snapshot.request.requestWorkBacklog,
        waitingForRequestSlot: merged.request.waitingForRequestSlot + snapshot.request.waitingForRequestSlot,
      },
      provider: merged.provider,
      source: merged.source,
    }
  }, getZeroTelemetrySnapshot())
  const lifecycle = mergeJudgmentLifecycleTelemetry(
    snapshots.map((snapshot) => {
      return snapshot.lifecycle
    }),
  )
  const providerAuthority =
    authorityProvider ?? snapshots[0]?.provider ?? getZeroProviderTelemetry({providerKey: 'unknown'})
  const observedGlobalEffectiveProviderLimit = snapshots.reduce((sum, snapshot) => {
    return sum + snapshot.provider.effectiveProviderLimit
  }, 0)
  const observedGlobalProviderLiveRequests = snapshots.reduce((sum, snapshot) => {
    return sum + snapshot.provider.localProviderLiveRequests
  }, 0)
  const observedGlobalPromptBacklog = snapshots.reduce((sum, snapshot) => {
    return sum + snapshot.provider.localPromptBacklog
  }, 0)
  const observedGlobalRequestWorkBacklog = snapshots.reduce((sum, snapshot) => {
    return sum + snapshot.provider.localRequestWorkBacklog
  }, 0)
  const allocationCompleteCurrent = providerAuthority.allocationCompleteCurrent
  const allocationInputState = providerAuthority.allocationInputState
  const provider = withProviderApiReadModels({
    ...providerAuthority,
    allocationCompleteCurrent,
    allocationInputState,
    convergenceDiagnostics: {
      ...providerAuthority.convergenceDiagnostics,
      allocationCompleteCurrent,
      allocationInputState,
    },
    observedGlobalEffectiveProviderLimit,
    observedGlobalPromptBacklog,
    observedGlobalProviderLiveRequests,
    observedGlobalProviderRequestFillPct: getFillPct(
      observedGlobalProviderLiveRequests,
      observedGlobalEffectiveProviderLimit,
    ),
    observedGlobalRequestWorkBacklog,
  })
  const snapshot = {...mergedSnapshot, provider, source}

  return lifecycle ? {...snapshot, lifecycle} : snapshot
}

const getRemoteJudgmentDispatchTelemetry = async (
  input: JudgmentDispatchTelemetryInput,
  options: JudgmentDispatchTelemetryOptions,
): Promise<{
  freshRemoteWorkerCount: number
  snapshots: JudgmentDispatchTelemetrySnapshot[]
  staleWorkerCount: number
  unavailableWorkerIds: string[]
  unavailableWorkerCount: number
}> => {
  const getRecords = options.getJudgingWorkerRecords ?? getJudgingWorkerRecords
  const fetchTelemetry = options.fetchWorkerTelemetry ?? fetchWorkerJudgmentDispatchTelemetry
  const records = await getRecords()
  const freshRecords = records.filter((record) => {
    return !record.isStale
  })
  const staleWorkerCount = records.length - freshRecords.length
  const telemetry = await Promise.all(
    freshRecords.map(async (record) => {
      const snapshot = await fetchTelemetry(record, input)

      return {record, snapshot: snapshot ? withTelemetryWorkerId(snapshot, record.instanceId) : null}
    }),
  )

  return {
    freshRemoteWorkerCount: telemetry.filter(({snapshot}) => {
      return snapshot !== null
    }).length,
    snapshots: telemetry.flatMap(({snapshot}) => {
      return snapshot ? [snapshot] : []
    }),
    staleWorkerCount,
    unavailableWorkerIds: telemetry.flatMap(({record, snapshot}) => {
      return snapshot ? [] : [record.instanceId]
    }),
    unavailableWorkerCount: telemetry.filter(({snapshot}) => {
      return snapshot === null
    }).length,
  }
}

const withUnavailableWorkerLifecycleTelemetry = ({
  input,
  snapshot,
  unavailableWorkerCount,
}: {
  input: JudgmentDispatchTelemetryInput
  snapshot: JudgmentDispatchTelemetrySnapshot
  unavailableWorkerCount: number
}): JudgmentDispatchTelemetrySnapshot => {
  if (unavailableWorkerCount === 0 || !snapshot.lifecycle) {
    return snapshot
  }

  const lifecycle = getJudgmentLifecycleTelemetry({
    records: [
      ...snapshot.lifecycle.records,
      {
        count: unavailableWorkerCount,
        jobId: input.jobId,
        lifecycleKind: 'prompt',
        lifecycleState: 'telemetryUnavailable',
        providerKey: getProviderKeyForTelemetryInput(input),
        stateStartedAt: new Date().toISOString(),
      },
    ],
  })

  return {...snapshot, lifecycle}
}

const withLocalLifecycleTelemetry = ({
  localTelemetry,
  snapshot,
}: {
  localTelemetry: JudgmentDispatchTelemetrySnapshot
  snapshot: JudgmentDispatchTelemetrySnapshot
}): JudgmentDispatchTelemetrySnapshot => {
  const lifecycle = mergeJudgmentLifecycleTelemetry([snapshot.lifecycle, localTelemetry.lifecycle])

  return lifecycle ? {...snapshot, lifecycle} : snapshot
}

const withTelemetrySource = (
  snapshot: JudgmentDispatchTelemetrySnapshot,
  source: JudgmentTelemetrySourceMetadata,
): JudgmentDispatchTelemetrySnapshot => {
  const allocationInputState = source.aggregateCompleteness === 'complete' ? 'completeCurrent' : 'partialTelemetry'
  const allocationCompleteCurrent = source.aggregateCompleteness === 'complete'
  const provider = withProviderApiReadModels({
    ...snapshot.provider,
    allocationCompleteCurrent,
    allocationInputState,
    convergenceDiagnostics: {
      ...snapshot.provider.convergenceDiagnostics,
      allocationCompleteCurrent,
      allocationInputState,
    },
  })

  return {...snapshot, provider, source}
}

export const withJudgmentProviderEndpointDiagnostics = ({
  diagnostics,
  effectiveBaseURL,
  endpointAvailabilityKey,
  snapshot,
}: {
  diagnostics: {
    cooldownRemainingMs: number | null
    lastFailureKind: string | null
    lastFailureMessage: string | null
    localProbeLiveCount: number
    observedAggregateProbeLiveCount: number | null
    probeInProgress: boolean
    status: string
  } | null
  effectiveBaseURL: string | null
  endpointAvailabilityKey: string | null
  snapshot: JudgmentDispatchTelemetrySnapshot
}): JudgmentDispatchTelemetrySnapshot => {
  if (!diagnostics || !endpointAvailabilityKey) {
    return snapshot
  }

  const localProbeCooldownUntil =
    diagnostics.cooldownRemainingMs === null
      ? null
      : new Date(Date.now() + diagnostics.cooldownRemainingMs).toISOString()
  const endpointDiagnostics = [
    ...snapshot.provider.endpointDiagnostics.filter((entry) => {
      return entry.endpointAvailabilityKey !== endpointAvailabilityKey
    }),
    {
      cooldownRemainingMs: diagnostics.cooldownRemainingMs,
      effectiveBaseURL,
      endpointAvailabilityKey,
      endpointIdentity: effectiveBaseURL,
      lastFailureKind: diagnostics.lastFailureKind,
      lastFailureMessage: diagnostics.lastFailureMessage,
      localProbeCooldownUntil,
      localProbeLiveCount: diagnostics.localProbeLiveCount,
      localProbeState: diagnostics.status,
      observedAggregateProbeLiveCount: diagnostics.observedAggregateProbeLiveCount,
      probeInProgress: diagnostics.probeInProgress,
    },
  ]
  const source = getTelemetrySourceMetadata({
    endpointAvailabilityKeys: endpointDiagnostics.map((entry) => {
      return entry.endpointAvailabilityKey
    }),
    freshWorkerCount: snapshot.source.freshWorkerCount,
    localWorkerId: snapshot.source.localWorkerId,
    providerKey: snapshot.provider.providerKey,
    staleWorkerCount: snapshot.source.staleWorkerCount,
    unavailableWorkerCount: snapshot.source.unavailableWorkerCount,
  })
  const hasHealthyEndpointOrEndpointlessPath = diagnostics.status === 'healthy'
  const controller = getJudgmentBacklogControllerState({
    activeHigherPriorityStopRules: snapshot.provider.convergenceDiagnostics.activeHigherPriorityStopRules,
    allocationCompleteCurrent: snapshot.provider.allocationCompleteCurrent,
    effectiveProviderLimit: snapshot.provider.effectiveProviderLimit,
    expectedLocalLiveShare: snapshot.provider.expectedLocalLiveShare,
    hasHealthyEndpointOrEndpointlessPath,
    lifecycleAgesMs: getBacklogControllerLifecycleAgesMs(snapshot.lifecycle),
    localPromptBacklog: snapshot.provider.localPromptBacklog,
    localPromptBacklogTarget: snapshot.provider.localPromptBacklogTarget,
    localProviderLiveRequests: snapshot.provider.localProviderLiveRequests,
    localRequestWorkBacklog: snapshot.provider.localRequestWorkBacklog,
    localRequestWorkBacklogTarget: snapshot.provider.localRequestWorkBacklogTarget,
    normalRequestCapacity: snapshot.provider.normalRequestCapacity,
    preconditionsStableSinceMs: snapshot.provider.convergenceDiagnostics.preconditionsStableSinceMs,
    providerAvailableRequestLeases: snapshot.provider.providerAvailableRequestLeases,
    providerLeasedProbeCalls: snapshot.provider.providerLeasedProbeCalls,
    providerLimit: snapshot.provider.providerLimit,
    readyCount: snapshot.provider.convergenceDiagnostics.readyCount,
  })
  const convergenceDiagnostics = {
    ...snapshot.provider.convergenceDiagnostics,
    backlogReplenishmentAllowed: controller.backlogReplenishmentAllowed,
    hasHealthyEndpointOrEndpointlessPath,
    preconditionChangedReason: controller.preconditionChangedReason,
    preconditionsStableSinceMs: controller.preconditionsStableSinceMs,
    ...(controller.targetIncreaseAllowed === undefined
      ? {}
      : {targetIncreaseAllowed: controller.targetIncreaseAllowed}),
  }

  return withBottleneckClassification({
    ...snapshot,
    provider: withProviderApiReadModels({
      ...snapshot.provider,
      convergenceDiagnostics,
      endpointDiagnostics,
      localAdditionalLeaseHeadroom: controller.localAdditionalLeaseHeadroom,
      localAdditionalTargetHeadroom: controller.localAdditionalTargetHeadroom,
      localPromptBacklogTarget: controller.localPromptBacklogTarget,
      localRequestWorkBacklogTarget: controller.localRequestWorkBacklogTarget,
    }),
    source,
  })
}

export const getAggregatedJudgmentDispatchTelemetry = async (
  input: JudgmentDispatchTelemetryInput,
  options: JudgmentDispatchTelemetryOptions = {},
): Promise<JudgmentDispatchTelemetrySnapshot> => {
  const getLocalTelemetry = options.getLocalTelemetry ?? getLocalJudgmentDispatchTelemetry
  const shouldUseLocalOnly = options.shouldUseLocalTelemetryOnly ?? shouldCurrentServerRunJudgingLoops
  const localTelemetry = await getLocalTelemetry(input)

  if (shouldUseLocalOnly()) {
    return withBottleneckClassification(localTelemetry)
  }

  const remoteTelemetry = await getRemoteJudgmentDispatchTelemetry(input, options)
  const freshWorkerCount = 1 + remoteTelemetry.freshRemoteWorkerCount
  const source = getTelemetrySourceMetadata({
    freshWorkerCount,
    providerKey: localTelemetry.provider.providerKey,
    staleWorkerCount: remoteTelemetry.staleWorkerCount,
    unavailableWorkerCount: remoteTelemetry.unavailableWorkerCount,
  })
  const providerTargetAllocationSnapshot = getProviderTargetAllocationSnapshotForTelemetry({
    authorityProvider: localTelemetry.provider,
    snapshots: remoteTelemetry.snapshots,
    source,
    unavailableWorkerIds: remoteTelemetry.unavailableWorkerIds,
  })
  const allocationAuthorityTelemetry = withProviderTargetAllocationSnapshot({
    allocationSnapshot: providerTargetAllocationSnapshot,
    snapshot: localTelemetry,
  })
  const unavailableWorkerTelemetry = shouldAllocateUnavailableWorkerTelemetry(localTelemetry.provider)
    ? remoteTelemetry.unavailableWorkerIds.map((workerId) => {
        return getUnavailableWorkerTelemetrySnapshot({authorityProvider: localTelemetry.provider, source, workerId})
      })
    : []
  const allocationWorkerTelemetry = [...remoteTelemetry.snapshots, ...unavailableWorkerTelemetry].map((snapshot) => {
    return withProviderTargetAllocationSnapshot({allocationSnapshot: providerTargetAllocationSnapshot, snapshot})
  })

  return allocationWorkerTelemetry.length === 0
    ? withBottleneckClassification(
        withUnavailableWorkerLifecycleTelemetry({
          input,
          snapshot: withTelemetrySource(allocationAuthorityTelemetry, source),
          unavailableWorkerCount: remoteTelemetry.unavailableWorkerCount,
        }),
      )
    : withBottleneckClassification(
        withUnavailableWorkerLifecycleTelemetry({
          input,
          snapshot: withLocalLifecycleTelemetry({
            localTelemetry,
            snapshot: mergeJudgmentDispatchTelemetrySnapshots(
              allocationWorkerTelemetry,
              source,
              allocationAuthorityTelemetry.provider,
            ),
          }),
          unavailableWorkerCount: remoteTelemetry.unavailableWorkerCount,
        }),
      )
}
