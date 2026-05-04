import {expect, test} from 'bun:test'

import type {DuckdbOwnerConnectionRecord} from '../../utils/duckdbOwnerConnections.ts'
import {
  getAggregatedJudgmentDispatchTelemetry,
  type JudgmentDispatchTelemetryInput,
  type JudgmentDispatchTelemetrySnapshot,
} from './judgmentDispatchTelemetry.ts'

const now = '2026-05-04T00:00:00.000Z'

const input = {
  jobId: 'job-a',
  providerConnectionId: 'provider-a',
  providerKey: 'provider-a',
  providerLimit: 11,
  providerLimitVersion: 'limit-a',
  providerMaxInflightRequests: 11,
  providerUsesFamilyDefault: false,
} satisfies JudgmentDispatchTelemetryInput

const createJudgingRecord = (overrides: Partial<DuckdbOwnerConnectionRecord> = {}): DuckdbOwnerConnectionRecord => {
  return {
    apiServerPort: 3003,
    capabilities: ['judging'],
    connectionId: 'worker-a',
    duckdbOwnerUrl: 'http://127.0.0.1:3002',
    firstSeenAt: now,
    hostname: 'localhost',
    instanceId: 'worker-a',
    isCurrentProcess: false,
    isStale: false,
    lastHeartbeatAt: now,
    lastProxyAt: null,
    lastRequestPath: null,
    lastSeenAt: now,
    listenPort: 3003,
    memoryLimit: '20GB',
    pid: 1003,
    processStartedAt: now,
    proxyCount: 0,
    runtimeProfile: 'primary',
    runtimeVersion: 'split-runtime-v1',
    serverRole: 'judge-worker',
    service: 'judge-worker-server',
    startedAt: now,
    takeover: {
      candidate: false,
      intent: 'none',
      observedAt: now,
      ownerFreshness: 'owner_fresh',
      ownerHeartbeatAt: now,
      ownerLeaseId: 'lease-a',
      ownerUrl: 'http://127.0.0.1:3002',
    },
    throughputProfile: {
      batchSize: null,
      martRefreshDrainEligible: false,
      maxCyclesPerWake: null,
      pollIntervalMs: null,
      profile: 'non-maintenance',
    },
    ...overrides,
  }
}

const createSnapshot = ({
  effectiveProviderLimit,
  localProviderLiveRequests,
  workerId,
}: {
  effectiveProviderLimit: number
  localProviderLiveRequests: number
  workerId: string
}): JudgmentDispatchTelemetrySnapshot => {
  return {
    dispatch: {
      jobActivePrompts: localProviderLiveRequests,
      jobQueuedPrompts: 0,
      providerDispatchActivePromptFillPct: null,
      providerDispatchActivePromptLimit: 11,
      providerDispatchActivePrompts: localProviderLiveRequests,
      providerDispatchPrefetchFillPct: null,
      providerDispatchQueueLimit: 11,
      providerDispatchQueuedPrompts: 0,
    },
    provider: {
      allocationCompleteCurrent: true,
      allocationInputState: 'completeCurrent',
      bottleneck: null,
      bottleneckSource: null,
      bottleneckSubreason: null,
      convergenceDiagnostics: {
        activeHigherPriorityStopRules: [],
        allocationCompleteCurrent: true,
        allocationInputState: 'completeCurrent',
        backlogReplenishmentAllowed: true,
        hasHealthyEndpointOrEndpointlessPath: true,
        normalRequestCapacityPositive: true,
        preconditionChangedReason: null,
        preconditionsStableSinceMs: 0,
        providerAcceptingRequests: true,
        providerLimitPositive: true,
        readyCount: 20,
      },
      effectiveProviderLimit,
      endpointDiagnostics: [],
      expectedLocalLiveShare: 0,
      localAdditionalLeaseHeadroom: 0,
      localAdditionalTargetHeadroom: 0,
      localPromptBacklog: localProviderLiveRequests,
      localPromptBacklogTarget: 22,
      localProviderLiveRequests,
      localProviderRequestFillPct: null,
      localRequestWorkBacklog: localProviderLiveRequests,
      localRequestWorkBacklogTarget: 0,
      normalRequestCapacity: 11,
      observedAggregateLabel: 'bestEffort',
      observedGlobalEffectiveProviderLimit: effectiveProviderLimit,
      observedGlobalPromptBacklog: localProviderLiveRequests,
      observedGlobalProviderLiveRequests: localProviderLiveRequests,
      observedGlobalProviderRequestFillPct: null,
      observedGlobalRequestWorkBacklog: localProviderLiveRequests,
      probeOccupancySampledAtMs: 0,
      providerAllocationVersion: 'worker-local-allocation',
      providerAvailableRequestLeases: 11,
      providerKey: 'provider-a',
      providerLeasedLiveRequests: 0,
      providerLeasedPhysicalCalls: 0,
      providerLeasedProbeCalls: 0,
      providerLimit: 11,
      providerLimitVersion: 'limit-a',
      providerProbeOccupancyVersion: 'worker-probe',
      providerRequestFillPct: null,
      targetRequestLiveCalls: 11,
      unallocatedTargetLiveCalls: 0,
    },
    request: {
      inFlight: localProviderLiveRequests,
      pendingPersistedAttempts: 0,
      requestWorkBacklog: localProviderLiveRequests,
      waitingForRequestSlot: 0,
    },
    source: {
      aggregateCompleteness: 'complete',
      endpointCoverage: [],
      freshWorkerCount: 1,
      localWorkerId: workerId,
      observedAggregatesAreBestEffort: true,
      providerCoverage: [
        {
          aggregateCompleteness: 'complete',
          freshWorkerCount: 1,
          providerKey: 'provider-a',
          staleWorkerCount: 0,
          unavailableWorkerCount: 0,
        },
      ],
      staleWorkerCount: 0,
      telemetryUnavailable: false,
      unavailableWorkerCount: 0,
    },
  }
}

test('owner telemetry publishes a complete provider target allocation snapshot for fresh workers', async () => {
  const localTelemetry = createSnapshot({effectiveProviderLimit: 11, localProviderLiveRequests: 0, workerId: 'owner'})
  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry: async (record) => {
      return record.instanceId === 'worker-a'
        ? createSnapshot({effectiveProviderLimit: 2, localProviderLiveRequests: 1, workerId: 'worker-a'})
        : createSnapshot({effectiveProviderLimit: 10, localProviderLiveRequests: 3, workerId: 'worker-b'})
    },
    getJudgingWorkerRecords: async () => {
      return [
        createJudgingRecord({instanceId: 'worker-b', listenPort: 3004}),
        createJudgingRecord({instanceId: 'worker-a', listenPort: 3003}),
      ]
    },
    getLocalTelemetry: async () => {
      return {
        ...localTelemetry,
        provider: {
          ...localTelemetry.provider,
          probeOccupancySampledAtMs: 123,
          providerLeasedLiveRequests: 4,
          providerLeasedPhysicalCalls: 5,
          providerLeasedProbeCalls: 1,
          providerProbeOccupancyVersion: 'probe-owner',
        },
      }
    },
    shouldUseLocalTelemetryOnly: () => {
      return false
    },
  })

  expect(telemetry.provider.providerTargetAllocationSnapshot).toMatchObject({
    allocationCompleteCurrent: true,
    allocationInputState: 'completeCurrent',
    normalRequestCapacity: 10,
    probeOccupancySampledAtMs: 123,
    providerAllocationVersion: 'local:limit-a:probe-owner',
    providerProbeOccupancyVersion: 'probe-owner',
    targetRequestLiveCalls: 10,
    unallocatedTargetLiveCalls: 0,
    workers: [
      {effectiveProviderLimit: 2, expectedLocalLiveShare: 2, routeable: true, workerId: 'worker-a'},
      {effectiveProviderLimit: 10, expectedLocalLiveShare: 8, routeable: true, workerId: 'worker-b'},
    ],
  })
  expect(telemetry.provider).toMatchObject({
    allocationCompleteCurrent: true,
    expectedLocalLiveShare: 0,
    normalRequestCapacity: 10,
    providerAllocationVersion: 'local:limit-a:probe-owner',
    targetRequestLiveCalls: 10,
  })
})
