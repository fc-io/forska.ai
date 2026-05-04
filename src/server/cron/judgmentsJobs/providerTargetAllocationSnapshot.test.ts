import {expect, test} from 'bun:test'

import {getProviderTargetAllocationSnapshot} from './providerTargetAllocationSnapshot.ts'

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
