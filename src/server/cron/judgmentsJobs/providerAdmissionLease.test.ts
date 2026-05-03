import {afterEach, expect, test} from 'bun:test'

import {
  acquireProviderAdmissionLease,
  getProviderBucketSnapshot,
  publishProviderBucketSnapshot,
  releaseProviderAdmissionLease,
  resetProviderAdmissionLeaseForTests,
} from './providerAdmissionLease.ts'

const getNonCodexCapacity = () => {
  return {maxBurst: 6, maxInflight: 6, workerCount: 1}
}

afterEach(() => {
  resetProviderAdmissionLeaseForTests()
})

test('provider bucket snapshot resolves null maxInflightRequests to the family default', () => {
  const snapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: null,
    modelId: 'model-openai',
    modelProvider: 'openai',
    providerConnectionId: 'connection-openai',
    providerName: 'OpenAI',
  })

  expect(snapshot).toMatchObject({
    maxInflightRequests: null,
    providerFamily: 'openai',
    providerId: 'connection-openai',
    providerKey: 'connection-openai',
    providerLimit: 6,
    providerName: 'OpenAI',
    providerUsesFamilyDefault: true,
    resolvedDefaultCapacity: 6,
  })
  expect(snapshot.providerLimitVersion).toHaveLength(64)
})

test('stale providerLimitVersion callers refresh instead of acquiring a new lease', () => {
  const firstSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 4,
    modelId: 'model-sglang',
    modelProvider: 'sglang',
    providerConnectionId: 'connection-sglang',
    providerConnectionUpdatedAt: '2026-05-03T10:00:00.000Z',
    providerName: 'SGLang',
  })
  const nextSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 2,
    modelId: 'model-sglang',
    modelProvider: 'sglang',
    providerConnectionId: 'connection-sglang',
    providerConnectionUpdatedAt: '2026-05-03T10:01:00.000Z',
    providerName: 'SGLang',
  })
  const result = acquireProviderAdmissionLease({
    holderToken: 'holder-b',
    leaseIdentity: 'request-b',
    nowMs: 1_000,
    snapshot: firstSnapshot,
  })

  expect(firstSnapshot.providerLimitVersion).not.toBe(nextSnapshot.providerLimitVersion)
  expect(result).toMatchObject({
    acquired: false,
    activeLeaseCount: 0,
    providerLimit: 2,
    providerLimitVersion: nextSnapshot.providerLimitVersion,
    reason: 'staleProviderLimitSnapshot',
    staleProviderLimitSnapshot: true,
  })
})

test('same-holder reacquire returns an advisory when its held snapshot is stale', () => {
  const firstSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 4,
    modelId: 'model-sglang',
    modelProvider: 'sglang',
    providerConnectionId: 'connection-sglang',
    providerConnectionUpdatedAt: '2026-05-03T10:00:00.000Z',
    providerName: 'SGLang',
  })
  const firstAcquire = acquireProviderAdmissionLease({
    holderToken: 'holder-a',
    leaseIdentity: 'request-a',
    nowMs: 1_000,
    snapshot: firstSnapshot,
  })
  const nextSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 2,
    modelId: 'model-sglang',
    modelProvider: 'sglang',
    providerConnectionId: 'connection-sglang',
    providerConnectionUpdatedAt: '2026-05-03T10:01:00.000Z',
    providerName: 'SGLang',
  })
  const reacquire = acquireProviderAdmissionLease({
    holderToken: 'holder-a',
    leaseIdentity: 'request-a',
    nowMs: 2_000,
    snapshot: firstSnapshot,
  })

  expect(firstAcquire).toMatchObject({acquired: true, alreadyHeld: false, staleProviderLimitSnapshot: false})
  expect(reacquire).toMatchObject({
    acquired: true,
    activeLeaseCount: 1,
    alreadyHeld: true,
    providerLimit: 2,
    providerLimitVersion: firstSnapshot.providerLimitVersion,
    staleProviderLimitSnapshot: true,
  })
  expect(reacquire.currentSnapshot.providerLimitVersion).toBe(nextSnapshot.providerLimitVersion)
})

test('limit decrease drains down without admitting new leases while active leases exceed the current limit', () => {
  const firstSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 3,
    modelId: 'model-drain',
    modelProvider: 'openai',
    providerConnectionId: 'connection-drain',
    providerConnectionUpdatedAt: '2026-05-03T10:00:00.000Z',
    providerName: 'OpenAI',
  })

  expect(
    ['request-a', 'request-b', 'request-c'].map((leaseIdentity) => {
      return acquireProviderAdmissionLease({
        holderToken: leaseIdentity,
        leaseIdentity,
        nowMs: 1_000,
        snapshot: firstSnapshot,
      }).acquired
    }),
  ).toEqual([true, true, true])

  const nextSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 1,
    modelId: 'model-drain',
    modelProvider: 'openai',
    providerConnectionId: 'connection-drain',
    providerConnectionUpdatedAt: '2026-05-03T10:01:00.000Z',
    providerName: 'OpenAI',
  })
  const blocked = acquireProviderAdmissionLease({
    holderToken: 'holder-new',
    leaseIdentity: 'request-new',
    nowMs: 2_000,
    snapshot: nextSnapshot,
  })

  expect(blocked).toMatchObject({
    acquired: false,
    activeLeaseCount: 3,
    providerLimit: 1,
    reason: 'capacity',
    staleProviderLimitSnapshot: false,
  })

  expect(
    releaseProviderAdmissionLease({
      holderToken: 'request-a',
      leaseIdentity: 'request-a',
      providerKey: nextSnapshot.providerKey,
    }),
  ).toBe(true)
  expect(
    releaseProviderAdmissionLease({
      holderToken: 'request-b',
      leaseIdentity: 'request-b',
      providerKey: nextSnapshot.providerKey,
    }),
  ).toBe(true)

  const stillBlockedAtLimit = acquireProviderAdmissionLease({
    holderToken: 'holder-new',
    leaseIdentity: 'request-new',
    nowMs: 3_000,
    snapshot: nextSnapshot,
  })

  expect(stillBlockedAtLimit).toMatchObject({acquired: false, activeLeaseCount: 1, reason: 'capacity'})
  expect(
    releaseProviderAdmissionLease({
      holderToken: 'request-c',
      leaseIdentity: 'request-c',
      providerKey: nextSnapshot.providerKey,
    }),
  ).toBe(true)
  expect(
    acquireProviderAdmissionLease({
      holderToken: 'holder-new',
      leaseIdentity: 'request-new',
      nowMs: 4_000,
      snapshot: nextSnapshot,
    }),
  ).toMatchObject({acquired: true, activeLeaseCount: 1, alreadyHeld: false})
})

test('owner-backed synthetic provider ids and versions are stable across owner restart', () => {
  const firstSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: null,
    modelId: 'model-owner-backed',
    modelProvider: 'sglang',
    providerConnectionId: null,
    providerName: 'Qwen',
    useOwnerBackedSyntheticProviderId: true,
  })

  resetProviderAdmissionLeaseForTests()

  const restartedSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: null,
    modelId: 'model-owner-backed',
    modelProvider: 'sglang',
    providerConnectionId: null,
    providerName: 'Qwen',
    useOwnerBackedSyntheticProviderId: true,
  })

  expect(firstSnapshot.providerId).toBe('owner-backed:model-owner-backed')
  expect(restartedSnapshot.providerId).toBe(firstSnapshot.providerId)
  expect(restartedSnapshot.providerKey).toBe(firstSnapshot.providerKey)
  expect(restartedSnapshot.providerLimitVersion).toBe(firstSnapshot.providerLimitVersion)
})

test('publishing a same-limit provider setting change still rotates providerLimitVersion', () => {
  const firstSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 2,
    modelId: 'model-version',
    modelProvider: 'openai',
    providerConnectionId: 'connection-version',
    providerConnectionUpdatedAt: '2026-05-03T10:00:00.000Z',
    providerName: 'OpenAI',
  })
  const nextSnapshot = {
    ...firstSnapshot,
    providerLimitVersion: getProviderBucketSnapshot({
      getNonCodexCapacity,
      maxInflightRequests: 2,
      modelId: 'model-version',
      modelProvider: 'openai',
      providerConnectionId: 'connection-version',
      providerConnectionUpdatedAt: '2026-05-03T10:01:00.000Z',
      providerName: 'OpenAI',
    }).providerLimitVersion,
  }

  publishProviderBucketSnapshot(nextSnapshot)

  expect(
    acquireProviderAdmissionLease({
      holderToken: 'holder-version',
      leaseIdentity: 'request-version',
      nowMs: 1_000,
      snapshot: firstSnapshot,
    }),
  ).toMatchObject({
    acquired: false,
    providerLimit: 2,
    reason: 'staleProviderLimitSnapshot',
    staleProviderLimitSnapshot: true,
  })
})
