import {expect, mock, test} from 'bun:test'

import type {DuckdbOwnerConnectionRecord} from '../../utils/duckdbOwnerConnections.ts'
import {
  getAggregatedJudgmentDispatchTelemetry,
  judgmentBottleneckSubreasonValues,
  judgmentBottleneckValues,
  type JudgmentDispatchTelemetryInput,
  type JudgmentDispatchTelemetrySnapshot,
} from './judgmentDispatchTelemetry.ts'
import {getJudgmentLifecycleTelemetry, type JudgmentLifecycleTelemetryRecord} from './judgmentLifecycleTelemetry.ts'

const input = {
  jobId: 'job-a',
  providerConnectionId: 'connection-a',
  providerMaxInflightRequests: 20,
  providerUsesFamilyDefault: false,
} satisfies JudgmentDispatchTelemetryInput

const now = '2026-04-27T00:00:00.000Z'

const createSnapshot = (
  overrides: {
    dispatch?: Partial<JudgmentDispatchTelemetrySnapshot['dispatch']>
    lifecycleRecords?: JudgmentLifecycleTelemetryRecord[]
    provider?: Partial<JudgmentDispatchTelemetrySnapshot['provider']>
    request?: Partial<JudgmentDispatchTelemetrySnapshot['request']>
  } = {},
): JudgmentDispatchTelemetrySnapshot => {
  const lifecycle = overrides.lifecycleRecords
    ? getJudgmentLifecycleTelemetry({now: new Date(now), records: overrides.lifecycleRecords})
    : undefined
  const provider = {
    allocationCompleteCurrent: true,
    allocationInputState: 'completeCurrent',
    bottleneck: null,
    bottleneckSource: null,
    bottleneckSubreason: null,
    convergenceDiagnostics: {
      activeHigherPriorityStopRules: [],
      allocationCompleteCurrent: true,
      allocationInputState: 'completeCurrent',
      backlogReplenishmentAllowed: false,
      hasHealthyEndpointOrEndpointlessPath: true,
      normalRequestCapacityPositive: true,
      preconditionChangedReason: null,
      preconditionsStableSinceMs: 0,
      providerAcceptingRequests: true,
      providerLimitPositive: true,
      readyCount: 0,
    },
    effectiveProviderLimit: 20,
    endpointDiagnostics: [],
    expectedLocalLiveShare: 19,
    localAdditionalLeaseHeadroom: 19,
    localAdditionalTargetHeadroom: 19,
    localPromptBacklog: 0,
    localPromptBacklogTarget: 40,
    localProviderLiveRequests: 0,
    localProviderRequestFillPct: 0,
    localRequestWorkBacklog: 0,
    localRequestWorkBacklogTarget: 19,
    normalRequestCapacity: 20,
    observedAggregateLabel: 'bestEffort' as const,
    observedGlobalEffectiveProviderLimit: 20,
    observedGlobalPromptBacklog: 0,
    observedGlobalProviderLiveRequests: 0,
    observedGlobalProviderRequestFillPct: 0,
    observedGlobalRequestWorkBacklog: 0,
    probeOccupancySampledAtMs: 0,
    providerAllocationVersion: 'allocation-a',
    providerAvailableRequestLeases: 20,
    providerKey: 'connection-a',
    providerLeasedLiveRequests: 0,
    providerLeasedPhysicalCalls: 0,
    providerLeasedProbeCalls: 0,
    providerLimit: 20,
    providerLimitVersion: 'version-a',
    providerProbeOccupancyVersion: 'probe-version-a',
    providerRequestFillPct: 0,
    targetRequestLiveCalls: 19,
    unallocatedTargetLiveCalls: 0,
    ...overrides.provider,
  } satisfies JudgmentDispatchTelemetrySnapshot['provider']

  return {
    dispatch: {
      jobActivePrompts: 0,
      jobQueuedPrompts: 0,
      providerDispatchActivePromptFillPct: 0,
      providerDispatchActivePromptLimit: 20,
      providerDispatchActivePrompts: 0,
      providerDispatchPrefetchFillPct: 0,
      providerDispatchQueueLimit: 20,
      providerDispatchQueuedPrompts: 0,
      ...overrides.dispatch,
    },
    ...(lifecycle ? {lifecycle} : {}),
    provider,
    request: {
      inFlight: 0,
      pendingPersistedAttempts: 0,
      requestWorkBacklog: 0,
      waitingForRequestSlot: 0,
      ...overrides.request,
    },
    source: {
      aggregateCompleteness: 'complete',
      endpointCoverage: [],
      freshWorkerCount: 1,
      localWorkerId: 'test-worker',
      observedAggregatesAreBestEffort: true,
      providerCoverage: [
        {
          aggregateCompleteness: 'complete',
          freshWorkerCount: 1,
          providerKey: provider.providerKey,
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

const createJudgingRecord = (overrides: Partial<DuckdbOwnerConnectionRecord> = {}): DuckdbOwnerConnectionRecord => {
  return {
    apiServerPort: 3003,
    capabilities: ['judging'],
    connectionId: 'judge-worker-a',
    duckdbOwnerUrl: 'http://127.0.0.1:3002',
    firstSeenAt: now,
    hostname: 'localhost',
    instanceId: 'judge-worker-a',
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

const getProviderWithReadyWork = (
  overrides: Partial<JudgmentDispatchTelemetrySnapshot['provider']> = {},
): JudgmentDispatchTelemetrySnapshot['provider'] => {
  const provider = createSnapshot().provider

  return {
    ...provider,
    ...overrides,
    convergenceDiagnostics: {
      ...provider.convergenceDiagnostics,
      backlogReplenishmentAllowed: true,
      preconditionsStableSinceMs: 15_000,
      readyCount: 12,
      ...(overrides.convergenceDiagnostics ?? {}),
    },
  }
}

test('aggregates fresh judge-worker telemetry when this process does not judge', async () => {
  const records = [createJudgingRecord(), createJudgingRecord({instanceId: 'judge-worker-b', listenPort: 3004})]
  const fetchWorkerTelemetry = mock(async (record: DuckdbOwnerConnectionRecord) => {
    return record.listenPort === 3003
      ? createSnapshot({
          dispatch: {
            jobActivePrompts: 12,
            jobQueuedPrompts: 4,
            providerDispatchActivePrompts: 12,
            providerDispatchQueuedPrompts: 4,
          },
          provider: {localProviderLiveRequests: 15},
          request: {inFlight: 15, pendingPersistedAttempts: 2},
        })
      : createSnapshot({
          dispatch: {
            jobActivePrompts: 3,
            jobQueuedPrompts: 1,
            providerDispatchActivePrompts: 3,
            providerDispatchQueuedPrompts: 1,
          },
          provider: {localProviderLiveRequests: 4},
          request: {inFlight: 4, pendingPersistedAttempts: 1},
        })
  })

  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry,
    getJudgingWorkerRecords: async () => {
      return records
    },
    getLocalTelemetry: async () => {
      return createSnapshot({request: {inFlight: 0, pendingPersistedAttempts: 0}})
    },
    shouldUseLocalTelemetryOnly: () => {
      return false
    },
  })

  expect(telemetry).toMatchObject({
    dispatch: {
      jobActivePrompts: 15,
      jobQueuedPrompts: 5,
      providerDispatchActivePromptLimit: 40,
      providerDispatchActivePrompts: 15,
      providerDispatchQueueLimit: 40,
      providerDispatchQueuedPrompts: 5,
    },
    provider: {
      observedAggregateLabel: 'bestEffort',
      observedGlobalEffectiveProviderLimit: 40,
      observedGlobalProviderLiveRequests: 19,
    },
    request: {inFlight: 19, pendingPersistedAttempts: 3},
    source: {
      aggregateCompleteness: 'complete',
      freshWorkerCount: 3,
      staleWorkerCount: 0,
      telemetryUnavailable: false,
      unavailableWorkerCount: 0,
    },
  })
  expect(fetchWorkerTelemetry).toHaveBeenCalledTimes(2)
})

test('uses fresh worker local lease telemetry when owner authority reports no live leases', async () => {
  const records = [createJudgingRecord(), createJudgingRecord({instanceId: 'judge-worker-b', listenPort: 3004})]
  const fetchWorkerTelemetry = mock(async (record: DuckdbOwnerConnectionRecord) => {
    return record.listenPort === 3003
      ? createSnapshot({
          provider: {localProviderLiveRequests: 15, providerLeasedLiveRequests: 15, providerLeasedPhysicalCalls: 15},
          request: {inFlight: 15},
        })
      : createSnapshot({
          provider: {localProviderLiveRequests: 4, providerLeasedLiveRequests: 4, providerLeasedPhysicalCalls: 4},
          request: {inFlight: 4},
        })
  })

  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry,
    getJudgingWorkerRecords: async () => {
      return records
    },
    getLocalTelemetry: async () => {
      return createSnapshot({request: {inFlight: 0, pendingPersistedAttempts: 0}})
    },
    shouldUseLocalTelemetryOnly: () => {
      return false
    },
  })

  expect(telemetry.provider).toMatchObject({
    leaseAuthority: {
      providerAvailableRequestLeases: 1,
      providerLeasedLiveRequests: 19,
      providerLeasedPhysicalCalls: 19,
      providerRequestFillPct: 95,
    },
    providerAvailableRequestLeases: 1,
    providerLeasedLiveRequests: 19,
    providerLeasedPhysicalCalls: 19,
  })
})

test('falls back to local telemetry when judge-worker telemetry is unavailable', async () => {
  const localTelemetry = createSnapshot({
    dispatch: {jobActivePrompts: 0, providerDispatchActivePromptLimit: 20, providerDispatchQueueLimit: 20},
    request: {inFlight: 0, pendingPersistedAttempts: 0},
  })

  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry: async () => {
      return null
    },
    getJudgingWorkerRecords: async () => {
      return [createJudgingRecord()]
    },
    getLocalTelemetry: async () => {
      return localTelemetry
    },
    shouldUseLocalTelemetryOnly: () => {
      return false
    },
  })

  expect(telemetry).toMatchObject({
    dispatch: localTelemetry.dispatch,
    provider: {
      allocationCompleteCurrent: false,
      allocationInputState: 'partialTelemetry',
      convergenceDiagnostics: {allocationCompleteCurrent: false, allocationInputState: 'partialTelemetry'},
    },
    request: localTelemetry.request,
    source: {
      aggregateCompleteness: 'partial',
      freshWorkerCount: 1,
      staleWorkerCount: 0,
      telemetryUnavailable: true,
      unavailableWorkerCount: 1,
    },
  })
})

test('does not report partial allocation as a bottleneck when fresh workers cover target capacity', async () => {
  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry: async () => {
      return createSnapshot({provider: {localProviderLiveRequests: 2}, request: {inFlight: 2}})
    },
    getJudgingWorkerRecords: async () => {
      return [createJudgingRecord(), createJudgingRecord({instanceId: 'stale-worker', isStale: true, listenPort: 3004})]
    },
    getLocalTelemetry: async () => {
      return createSnapshot({provider: getProviderWithReadyWork({providerLeasedLiveRequests: 2})})
    },
    shouldUseLocalTelemetryOnly: () => {
      return false
    },
  })

  expect(telemetry.provider).toMatchObject({
    allocationCompleteCurrent: false,
    allocationInputState: 'partialTelemetry',
    bottleneck: 'claiming',
    bottleneckSubreason: 'promptClaimBacklog',
    convergenceDiagnostics: {backlogReplenishmentAllowed: true},
    observedGlobalEffectiveProviderLimit: 20,
    unallocatedTargetLiveCalls: 0,
  })
})

test('allocates target capacity to unavailable fresh worker telemetry when leases and ready work exist', async () => {
  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry: async () => {
      return null
    },
    getJudgingWorkerRecords: async () => {
      return [createJudgingRecord()]
    },
    getLocalTelemetry: async () => {
      return createSnapshot({provider: getProviderWithReadyWork()})
    },
    shouldUseLocalTelemetryOnly: () => {
      return false
    },
  })

  expect(telemetry.provider).toMatchObject({
    allocationCompleteCurrent: false,
    allocationInputState: 'partialTelemetry',
    bottleneck: 'claiming',
    bottleneckSubreason: 'promptClaimBacklog',
    observedGlobalEffectiveProviderLimit: 20,
    unallocatedTargetLiveCalls: 0,
  })
  expect(telemetry.provider.providerTargetAllocationSnapshot?.workers).toEqual([
    {
      effectiveProviderLimit: 20,
      expectedLocalLiveShare: 19,
      localProviderLiveRequests: 0,
      providerKey: 'connection-a',
      providerLimitVersion: 'version-a',
      routeable: true,
      workerId: 'judge-worker-a',
    },
  ])
  expect(telemetry.source).toMatchObject({
    aggregateCompleteness: 'partial',
    telemetryUnavailable: true,
    unavailableWorkerCount: 1,
  })
})

test('merges prompt and request-attempt lifecycle telemetry from fresh workers', async () => {
  const records = [createJudgingRecord(), createJudgingRecord({instanceId: 'judge-worker-b', listenPort: 3004})]
  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry: async (record) => {
      return record.listenPort === 3003
        ? createSnapshot({
            lifecycleRecords: [
              {
                jobId: input.jobId,
                lifecycleKind: 'prompt',
                lifecycleState: 'dispatchQueued',
                providerKey: 'provider-a',
                queueRecordId: 'queue-a',
                stateStartedAt: now,
              },
              {
                jobId: input.jobId,
                lifecycleKind: 'requestAttempt',
                lifecycleState: 'liveRequest',
                providerKey: 'provider-a',
                requestAttemptId: 'attempt-a',
                stateStartedAt: now,
              },
            ],
          })
        : createSnapshot({
            lifecycleRecords: [
              {
                jobId: input.jobId,
                lifecycleKind: 'requestAttempt',
                lifecycleState: 'persistingCompletion',
                providerKey: 'provider-a',
                requestAttemptId: 'attempt-b',
                stateStartedAt: now,
              },
            ],
          })
    },
    getJudgingWorkerRecords: async () => {
      return records
    },
    getLocalTelemetry: async () => {
      return createSnapshot()
    },
    shouldUseLocalTelemetryOnly: () => {
      return false
    },
  })

  expect(
    telemetry.lifecycle?.summaries.map((summary) => {
      return [summary.lifecycleKind, summary.lifecycleState, summary.count]
    }),
  ).toEqual([
    ['prompt', 'dispatchQueued', 1],
    ['requestAttempt', 'liveRequest', 1],
    ['requestAttempt', 'persistingCompletion', 1],
  ])
  expect(
    telemetry.lifecycle?.attemptSummaries.map((summary) => {
      return [summary.requestAttemptId, summary.lifecycleState, summary.count]
    }),
  ).toEqual([
    ['attempt-a', 'liveRequest', 1],
    ['attempt-b', 'persistingCompletion', 1],
  ])
})

test('records unavailable worker telemetry as lifecycle diagnostics when local lifecycle truth exists', async () => {
  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry: async () => {
      return null
    },
    getJudgingWorkerRecords: async () => {
      return [createJudgingRecord()]
    },
    getLocalTelemetry: async () => {
      return createSnapshot({
        lifecycleRecords: [
          {
            jobId: input.jobId,
            lifecycleKind: 'prompt',
            lifecycleState: 'claimed',
            providerKey: 'provider-a',
            queueRecordId: 'queue-a',
            stateStartedAt: now,
          },
        ],
      })
    },
    shouldUseLocalTelemetryOnly: () => {
      return false
    },
  })

  expect(
    telemetry.lifecycle?.summaries.map((summary) => {
      return [summary.lifecycleKind, summary.lifecycleState, summary.count]
    }),
  ).toEqual([
    ['prompt', 'claimed', 1],
    ['prompt', 'telemetryUnavailable', 1],
  ])
})

test('uses local telemetry without polling workers when this process judges', async () => {
  const fetchWorkerTelemetry = mock(async () => {
    return createSnapshot({request: {inFlight: 99, pendingPersistedAttempts: 99}})
  })
  const localTelemetry = createSnapshot({request: {inFlight: 7, pendingPersistedAttempts: 2}})

  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    fetchWorkerTelemetry,
    getJudgingWorkerRecords: async () => {
      return [createJudgingRecord()]
    },
    getLocalTelemetry: async () => {
      return localTelemetry
    },
    shouldUseLocalTelemetryOnly: () => {
      return true
    },
  })

  expect(telemetry).toEqual({
    ...localTelemetry,
    provider: {
      ...localTelemetry.provider,
      bottleneck: 'noReadyWork',
      bottleneckSource: 'convergenceDiagnostics.readyCount',
      bottleneckSubreason: 'readyWorkUnavailable',
    },
  })
  expect(fetchWorkerTelemetry).not.toHaveBeenCalled()
})

test('bottleneck subreasons do not overlap primary bottleneck values', () => {
  const bottlenecks = new Set<string>(judgmentBottleneckValues)
  const overlap = judgmentBottleneckSubreasonValues.filter((value) => {
    return bottlenecks.has(value)
  })

  expect(overlap).toEqual([])
})

test('classifies completion persistence before endpoint and capacity bottlenecks', async () => {
  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    getLocalTelemetry: async () => {
      return createSnapshot({
        lifecycleRecords: [
          {
            closeoutReason: 'completion_outbox',
            jobId: input.jobId,
            lifecycleKind: 'prompt',
            lifecycleState: 'persisting',
            providerKey: 'connection-a',
            queueRecordId: 'queue-persisting',
            stateStartedAt: now,
          },
        ],
        provider: getProviderWithReadyWork({
          convergenceDiagnostics: {
            ...createSnapshot().provider.convergenceDiagnostics,
            backlogReplenishmentAllowed: false,
            hasHealthyEndpointOrEndpointlessPath: false,
            preconditionChangedReason: 'endpointRouteability',
            preconditionsStableSinceMs: 15_000,
            readyCount: 12,
          },
          effectiveProviderLimit: 0,
          endpointDiagnostics: [
            {
              cooldownRemainingMs: 30_000,
              effectiveBaseURL: 'http://provider.test/v1',
              endpointAvailabilityKey: 'connection-a::http://provider.test',
              endpointIdentity: 'http://provider.test',
              lastFailureKind: 'endpoint_unavailable',
              lastFailureMessage: 'cooldown',
              localEndpointProbeCooldownUntil: now,
              localEndpointProbeLive: 0,
              localEndpointProbeState: 'cooldown',
              observedGlobalEndpointProbeLive: 0,
              probeInProgress: false,
            },
          ],
        }),
      })
    },
    shouldUseLocalTelemetryOnly: () => {
      return true
    },
  })

  expect(telemetry.provider).toMatchObject({
    bottleneck: 'completionPersistence',
    bottleneckSource: 'lifecycle:prompt:persisting',
    bottleneckSubreason: 'completionJournal',
  })
})

test('distinguishes provider target from provider physical saturation', async () => {
  const createProviderTelemetry = (providerLeasedPhysicalCalls: number) => {
    return getProviderWithReadyWork({
      providerLeasedLiveRequests: 19,
      providerLeasedPhysicalCalls,
      providerLimit: 20,
      targetRequestLiveCalls: 19,
    })
  }
  const atTarget = await getAggregatedJudgmentDispatchTelemetry(input, {
    getLocalTelemetry: async () => {
      return createSnapshot({provider: createProviderTelemetry(19), request: {waitingForRequestSlot: 1}})
    },
    shouldUseLocalTelemetryOnly: () => {
      return true
    },
  })
  const saturated = await getAggregatedJudgmentDispatchTelemetry(input, {
    getLocalTelemetry: async () => {
      return createSnapshot({provider: createProviderTelemetry(20), request: {waitingForRequestSlot: 1}})
    },
    shouldUseLocalTelemetryOnly: () => {
      return true
    },
  })

  expect(atTarget.provider).toMatchObject({
    bottleneck: 'providerAtTarget',
    bottleneckSubreason: 'providerTargetReached',
  })
  expect(saturated.provider).toMatchObject({
    bottleneck: 'providerSaturated',
    bottleneckSubreason: 'providerPhysicalCap',
  })
})

test('classifies request slot waits with a concrete non-primary subreason', async () => {
  const telemetry = await getAggregatedJudgmentDispatchTelemetry(input, {
    getLocalTelemetry: async () => {
      return createSnapshot({
        provider: getProviderWithReadyWork({providerLeasedLiveRequests: 4}),
        request: {waitingForRequestSlot: 1},
      })
    },
    shouldUseLocalTelemetryOnly: () => {
      return true
    },
  })

  expect(telemetry.provider).toMatchObject({
    bottleneck: 'requestSlotWait',
    bottleneckSource: 'lifecycle:requestAttempt:waitingForRequestSlot',
    bottleneckSubreason: 'noAcquireAttemptRecorded',
  })
})
