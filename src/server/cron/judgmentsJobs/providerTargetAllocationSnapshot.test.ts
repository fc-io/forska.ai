import {expect, test} from 'bun:test'

import {
  getJudgmentBacklogControllerState,
  getProviderTargetAllocationSnapshot,
  judgmentBacklogControllerConstants,
} from './providerTargetAllocationSnapshot.ts'

const completeSource = {
  aggregateCompleteness: 'complete' as const,
  freshWorkerCount: 3,
  staleWorkerCount: 0,
  unavailableWorkerCount: 0,
}

test('allocates deterministic integer shares and redistributes capped worker remainder', () => {
  const snapshot = getProviderTargetAllocationSnapshot({
    probeOccupancySampledAtMs: 1_000,
    providerKey: 'provider-a',
    providerLeasedLiveRequests: 0,
    providerLeasedProbeCalls: 1,
    providerLimit: 11,
    providerLimitVersion: 'limit-a',
    providerProbeOccupancyVersion: 'probe-a',
    source: completeSource,
    workers: [
      {
        effectiveProviderLimit: 10,
        providerKey: 'provider-a',
        providerLimitVersion: 'limit-a',
        routeable: true,
        workerId: 'worker-z',
      },
      {
        effectiveProviderLimit: 2,
        providerKey: 'provider-a',
        providerLimitVersion: 'limit-a',
        routeable: true,
        workerId: 'worker-a',
      },
      {
        effectiveProviderLimit: 10,
        providerKey: 'provider-a',
        providerLimitVersion: 'limit-a',
        routeable: true,
        workerId: 'worker-m',
      },
    ],
  })

  expect(
    snapshot.workers.map((worker) => {
      return [worker.workerId, worker.effectiveProviderLimit, worker.expectedLocalLiveShare]
    }),
  ).toEqual([
    ['worker-a', 2, 2],
    ['worker-m', 10, 4],
    ['worker-z', 10, 4],
  ])
  expect(snapshot).toMatchObject({
    allocationCompleteCurrent: true,
    allocationInputState: 'completeCurrent',
    normalRequestCapacity: 10,
    targetRequestLiveCalls: 10,
    unallocatedTargetLiveCalls: 0,
  })
})

test('marks stale provider limit input incomplete and prevents new target headroom', () => {
  const snapshot = getProviderTargetAllocationSnapshot({
    probeOccupancySampledAtMs: 1_000,
    providerKey: 'provider-a',
    providerLeasedLiveRequests: 0,
    providerLeasedProbeCalls: 0,
    providerLimit: 5,
    providerLimitVersion: 'limit-current',
    providerProbeOccupancyVersion: 'probe-a',
    source: completeSource,
    workers: [
      {
        effectiveProviderLimit: 5,
        providerKey: 'provider-a',
        providerLimitVersion: 'limit-stale',
        routeable: true,
        workerId: 'worker-a',
      },
    ],
  })

  expect(snapshot).toMatchObject({
    allocationCompleteCurrent: false,
    allocationInputState: 'partialTelemetry',
    incompleteInputs: [{reason: 'staleProviderLimitVersion', workerId: 'worker-a'}],
    targetRequestLiveCalls: 5,
    unallocatedTargetLiveCalls: 5,
  })
  expect(snapshot.workers).toEqual([
    {
      effectiveProviderLimit: 0,
      expectedLocalLiveShare: 0,
      localProviderLiveRequests: 0,
      providerKey: 'provider-a',
      providerLimitVersion: 'limit-stale',
      routeable: false,
      workerId: 'worker-a',
    },
  ])
})

test('allocates fresh routeable workers when aggregate telemetry is partial', () => {
  const snapshot = getProviderTargetAllocationSnapshot({
    probeOccupancySampledAtMs: 1_000,
    providerKey: 'provider-a',
    providerLeasedLiveRequests: 2,
    providerLeasedProbeCalls: 0,
    providerLimit: 10,
    providerLimitVersion: 'limit-current',
    providerProbeOccupancyVersion: 'probe-a',
    source: {...completeSource, aggregateCompleteness: 'partial', staleWorkerCount: 1},
    workers: [
      {
        effectiveProviderLimit: 10,
        providerKey: 'provider-a',
        providerLimitVersion: 'limit-current',
        routeable: true,
        workerId: 'worker-a',
      },
    ],
  })

  expect(snapshot).toMatchObject({
    allocationCompleteCurrent: false,
    allocationInputState: 'partialTelemetry',
    incompleteInputs: [{reason: 'partialTelemetry', workerId: null}],
    providerAvailableRequestLeases: 8,
    targetRequestLiveCalls: 10,
    unallocatedTargetLiveCalls: 0,
  })
  expect(snapshot.workers).toEqual([
    {
      effectiveProviderLimit: 10,
      expectedLocalLiveShare: 10,
      localProviderLiveRequests: 0,
      providerKey: 'provider-a',
      providerLimitVersion: 'limit-current',
      routeable: true,
      workerId: 'worker-a',
    },
  ])
})

test('uses probe occupancy version in allocation identity and capacity input', () => {
  const firstSnapshot = getProviderTargetAllocationSnapshot({
    probeOccupancySampledAtMs: 1_000,
    providerKey: 'provider-a',
    providerLeasedLiveRequests: 1,
    providerLeasedProbeCalls: 1,
    providerLimit: 5,
    providerLimitVersion: 'limit-a',
    providerProbeOccupancyVersion: 'probe-a',
    source: {...completeSource, freshWorkerCount: 1},
    workers: [
      {
        effectiveProviderLimit: 10,
        providerKey: 'provider-a',
        providerLimitVersion: 'limit-a',
        routeable: true,
        workerId: 'worker-a',
      },
    ],
  })
  const nextSnapshot = getProviderTargetAllocationSnapshot({
    ...firstSnapshot,
    providerProbeOccupancyVersion: 'probe-b',
    source: {...completeSource, freshWorkerCount: 1},
    workers: [
      {
        effectiveProviderLimit: 10,
        providerKey: 'provider-a',
        providerLimitVersion: 'limit-a',
        routeable: true,
        workerId: 'worker-a',
      },
    ],
  })

  expect(firstSnapshot.providerAllocationVersion).not.toBe(nextSnapshot.providerAllocationVersion)
  expect(firstSnapshot.workers[0]).toMatchObject({effectiveProviderLimit: 4, expectedLocalLiveShare: 4})
  expect(firstSnapshot).toMatchObject({
    normalRequestCapacity: 4,
    providerAvailableRequestLeases: 3,
    providerLeasedPhysicalCalls: 2,
    targetRequestLiveCalls: 4,
  })
})

test('adaptive backlog controller preserves filled targets until hysteresis allows growth', () => {
  const baseInput = {
    allocationCompleteCurrent: true,
    effectiveProviderLimit: 8,
    expectedLocalLiveShare: 8,
    hasHealthyEndpointOrEndpointlessPath: true,
    localPromptBacklog: 16,
    localPromptBacklogTarget: 16,
    localProviderLiveRequests: 4,
    localRequestWorkBacklog: 8,
    localRequestWorkBacklogTarget: 8,
    normalRequestCapacity: 8,
    preconditionsStableSinceMs: judgmentBacklogControllerConstants.targetIncreaseHysteresisMs - 1,
    providerAvailableRequestLeases: 4,
    providerLeasedProbeCalls: 0,
    providerLimit: 8,
    readyCount: 20,
  }

  const held = getJudgmentBacklogControllerState(baseInput)
  const increased = getJudgmentBacklogControllerState({
    ...baseInput,
    preconditionsStableSinceMs: judgmentBacklogControllerConstants.targetIncreaseHysteresisMs,
  })

  expect(held).toMatchObject({
    backlogReplenishmentAllowed: true,
    localAdditionalLeaseHeadroom: 0,
    localAdditionalTargetHeadroom: 0,
    localPromptBacklogTarget: 16,
    localRequestWorkBacklogTarget: 8,
    targetIncreaseAllowed: false,
  })
  expect(increased).toMatchObject({
    backlogReplenishmentAllowed: true,
    localAdditionalLeaseHeadroom: 1,
    localAdditionalTargetHeadroom: 1,
    localPromptBacklogTarget: 17,
    localRequestWorkBacklogTarget: 9,
    targetIncreaseAllowed: true,
  })
})

test('adaptive backlog controller allows lease-gated replenishment with partial telemetry', () => {
  const state = getJudgmentBacklogControllerState({
    allocationCompleteCurrent: false,
    effectiveProviderLimit: 8,
    expectedLocalLiveShare: 8,
    hasHealthyEndpointOrEndpointlessPath: true,
    localPromptBacklog: 3,
    localPromptBacklogTarget: 16,
    localProviderLiveRequests: 2,
    localRequestWorkBacklog: 2,
    localRequestWorkBacklogTarget: 8,
    normalRequestCapacity: 8,
    preconditionsStableSinceMs: judgmentBacklogControllerConstants.targetIncreaseHysteresisMs,
    providerAvailableRequestLeases: 6,
    providerLeasedProbeCalls: 0,
    providerLimit: 8,
    readyCount: 20,
  })

  expect(state).toMatchObject({
    backlogReplenishmentAllowed: true,
    localAdditionalLeaseHeadroom: 6,
    localAdditionalTargetHeadroom: 6,
    localPromptBacklogTarget: 16,
    localRequestWorkBacklogTarget: 8,
    preconditionChangedReason: null,
    targetIncreaseAllowed: false,
  })
})
