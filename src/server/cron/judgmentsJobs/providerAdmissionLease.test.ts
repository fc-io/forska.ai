import {afterEach, expect, test} from 'bun:test'

import {
  acquireProviderAdmissionLease,
  acquireProviderAdmissionLeaseThroughOwner,
  getProviderAdmissionLeaseTelemetry,
  getProviderAdmissionLeaseTiming,
  getProviderAdmissionProbeLeaseIdentity,
  getProviderAdmissionRequestLeaseIdentity,
  getProviderBucketSnapshot,
  heartbeatProviderAdmissionLease,
  heartbeatProviderAdmissionLeaseThroughOwner,
  providerAdmissionLeaseHeartbeatIntervalMs,
  providerAdmissionLeaseTtlMs,
  publishProviderBucketSnapshot,
  releaseProviderAdmissionLease,
  releaseProviderAdmissionLeaseWithResult,
  releaseProviderAdmissionLeaseWithResultThroughOwner,
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

test('judge workers use local provider admission leases instead of owner RPCs', async () => {
  const originalServerRole = process.env.SERVER_ROLE
  process.env.SERVER_ROLE = 'judge-worker'

  try {
    const snapshot = getProviderBucketSnapshot({
      getNonCodexCapacity,
      maxInflightRequests: 1,
      modelId: 'model-local-owner-backed',
      modelProvider: 'sglang',
      providerConnectionId: 'connection-local-owner-backed',
      providerName: 'SGLang',
    })
    const leaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-local-owner-backed')
    const acquire = await acquireProviderAdmissionLeaseThroughOwner({
      holderToken: 'holder-local-owner-backed',
      leaseIdentity,
      requestAttemptId: 'request-local-owner-backed',
      snapshot,
    })

    expect(acquire.acquired).toBe(true)
    expect(await getProviderAdmissionLeaseTelemetry({providerKey: snapshot.providerKey})).toMatchObject({
      providerKey: snapshot.providerKey,
      providerLeasedLiveRequests: 1,
      providerLeasedProbeCalls: 0,
    })
    expect(
      await heartbeatProviderAdmissionLeaseThroughOwner({
        holderToken: 'holder-local-owner-backed',
        leaseIdentity,
        providerKey: snapshot.providerKey,
      }),
    ).toMatchObject({heartbeat: true})
    expect(
      await releaseProviderAdmissionLeaseWithResultThroughOwner({
        holderToken: 'holder-local-owner-backed',
        leaseIdentity,
        providerKey: snapshot.providerKey,
      }),
    ).toEqual({released: true})
  } finally {
    if (originalServerRole === undefined) {
      delete process.env.SERVER_ROLE
    } else {
      process.env.SERVER_ROLE = originalServerRole
    }
  }
})

test('request and probe lease identities are non-null canonical values', () => {
  expect(getProviderAdmissionRequestLeaseIdentity(' request-attempt-a ')).toBe('request:request-attempt-a')
  expect(
    getProviderAdmissionProbeLeaseIdentity({
      endpointAvailabilityKey: 'connection-a::http://localhost:30001',
      probeAttemptId: 'probe-attempt-a',
    }),
  ).toBe('probe:connection-a::http://localhost:30001:probe-attempt-a')
  expect(() => {
    getProviderAdmissionRequestLeaseIdentity(' ')
  }).toThrow('requestAttemptId is required')
  expect(() => {
    getProviderAdmissionProbeLeaseIdentity({
      endpointAvailabilityKey: 'connection-a::http://localhost:30001',
      probeAttemptId: '',
    })
  }).toThrow('probeAttemptId is required')
})

test('provider admission lease timing uses the injected owner clock', () => {
  const timing = getProviderAdmissionLeaseTiming({
    clock: {
      now: () => {
        return new Date('2026-05-04T10:00:00.000Z')
      },
    },
  })

  expect(timing).toEqual({
    acquiredAt: new Date('2026-05-04T10:00:00.000Z'),
    expiresAt: new Date('2026-05-04T10:01:00.000Z'),
    heartbeatAt: new Date('2026-05-04T10:00:00.000Z'),
    heartbeatIntervalMs: providerAdmissionLeaseHeartbeatIntervalMs,
    ttlMs: providerAdmissionLeaseTtlMs,
  })
})

test('provider admission lease timing clamps custom ttl to a positive expiry window', () => {
  const timing = getProviderAdmissionLeaseTiming({
    clock: {
      now: () => {
        return new Date('2026-05-04T10:00:00.000Z')
      },
    },
    ttlMs: 0,
  })

  expect(timing).toMatchObject({expiresAt: new Date('2026-05-04T10:00:00.001Z'), heartbeatIntervalMs: 1, ttlMs: 1})
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

test('in-memory provider admission heartbeat extends request leases without touching DuckDB', () => {
  const snapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 2,
    modelId: 'model-memory-heartbeat',
    modelProvider: 'sglang',
    providerConnectionId: 'connection-memory-heartbeat',
    providerName: 'SGLang',
  })
  const leaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-memory')

  expect(
    acquireProviderAdmissionLease({holderToken: 'holder-memory', leaseIdentity, nowMs: 1_000, snapshot, ttlMs: 10_000}),
  ).toMatchObject({acquired: true})

  const heartbeat = heartbeatProviderAdmissionLease({
    holderToken: 'holder-memory',
    leaseIdentity,
    nowMs: 5_000,
    providerKey: snapshot.providerKey,
    ttlMs: 20_000,
  })

  if (!heartbeat.heartbeat) {
    throw new Error('Expected in-memory heartbeat to succeed')
  }

  expect(heartbeat.lease).toMatchObject({
    expiresAtMs: 25_000,
    heartbeatAtMs: 5_000,
    holderToken: 'holder-memory',
    leaseIdentity,
    leaseKind: 'request',
    providerKey: snapshot.providerKey,
    requestAttemptId: 'request-attempt-memory',
  })
})

test('in-memory provider admission release result distinguishes missing and wrong holders', () => {
  const snapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 2,
    modelId: 'model-memory-release',
    modelProvider: 'sglang',
    providerConnectionId: 'connection-memory-release',
    providerName: 'SGLang',
  })
  const endpointAvailabilityKey = 'connection-memory-release::http://localhost:30001'
  const leaseIdentity = getProviderAdmissionProbeLeaseIdentity({
    endpointAvailabilityKey,
    probeAttemptId: 'probe-attempt-memory',
  })

  expect(
    acquireProviderAdmissionLease({holderToken: 'probe-holder-memory', leaseIdentity, nowMs: 1_000, snapshot}),
  ).toMatchObject({acquired: true})

  expect(
    releaseProviderAdmissionLeaseWithResult({
      holderToken: 'different-holder',
      leaseIdentity,
      providerKey: snapshot.providerKey,
    }),
  ).toEqual({released: false, reason: 'notHolder'})
  expect(
    releaseProviderAdmissionLeaseWithResult({
      holderToken: 'probe-holder-memory',
      leaseIdentity,
      providerKey: snapshot.providerKey,
    }),
  ).toEqual({released: true})
  expect(
    releaseProviderAdmissionLeaseWithResult({
      holderToken: 'probe-holder-memory',
      leaseIdentity,
      providerKey: snapshot.providerKey,
    }),
  ).toEqual({released: false, reason: 'missing'})
})
