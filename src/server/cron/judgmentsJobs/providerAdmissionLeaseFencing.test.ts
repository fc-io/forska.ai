import {afterAll, afterEach, beforeAll, expect, test} from 'bun:test'

import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'
import {
  acquireProviderAdmissionLeaseOnCurrentOwner,
  expireProviderAdmissionLeasesOnCurrentOwner,
  getProviderAdmissionProbeLeaseIdentity,
  getProviderAdmissionRequestLeaseIdentity,
  getProviderBucketSnapshot,
  heartbeatProviderAdmissionLeaseOnCurrentOwner,
  reconcileProviderAdmissionLeasesOnCurrentOwner,
  releaseProviderAdmissionLeaseOnCurrentOwner,
  releaseProviderAdmissionLeaseWithResultOnCurrentOwner,
  resetProviderAdmissionLeaseForTests,
} from './providerAdmissionLease.ts'

const tempRuntimeRoot = createTempRuntimeRoot('f1-provider-admission-lease-fencing')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
process.env.RUN_SERVER_JUDGING = 'false'
process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

type LeaseInsert = {
  acquiredAt?: Date
  endpointAvailabilityKey?: string | null
  expiresAt?: Date
  heartbeatAt?: Date
  holderToken?: string
  leaseIdentity: string
  leaseKind: 'probe' | 'request'
  probeAttemptId?: string | null
  providerKey?: string
  requestAttemptId?: string | null
}

const getNonCodexCapacity = () => {
  return {maxBurst: 6, maxInflight: 6, workerCount: 1}
}

let closeDatabase: (() => Promise<void>) | null = null
let queryDatabase: (<T>(statement: string) => Promise<T[]>) | null = null
let runDatabase: ((statement: string) => Promise<void>) | null = null

const getInsertLeaseSql = ({
  acquiredAt = new Date('2026-05-04T10:00:00.000Z'),
  endpointAvailabilityKey = null,
  expiresAt = new Date('2026-05-04T10:01:00.000Z'),
  heartbeatAt = new Date('2026-05-04T10:00:00.000Z'),
  holderToken = 'holder-token',
  leaseIdentity,
  leaseKind,
  probeAttemptId = null,
  providerKey = 'provider-a',
  requestAttemptId = null,
}: LeaseInsert): string => {
  return `
    INSERT INTO app.provider_admission_lease (
      provider_key,
      lease_kind,
      lease_identity,
      request_attempt_id,
      endpoint_availability_key,
      probe_attempt_id,
      holder_token,
      acquired_at,
      heartbeat_at,
      expires_at
    ) VALUES (
      ${getSqlLiteral(providerKey)},
      ${getSqlLiteral(leaseKind)},
      ${getSqlLiteral(leaseIdentity)},
      ${getSqlLiteral(requestAttemptId)},
      ${getSqlLiteral(endpointAvailabilityKey)},
      ${getSqlLiteral(probeAttemptId)},
      ${getSqlLiteral(holderToken)},
      ${getSqlLiteral(acquiredAt)},
      ${getSqlLiteral(heartbeatAt)},
      ${getSqlLiteral(expiresAt)}
    )
  `
}

const insertLease = async (input: LeaseInsert): Promise<void> => {
  if (!runDatabase) {
    throw new Error('Test database not initialized')
  }

  await runDatabase(getInsertLeaseSql(input))
}

const expectLeaseInsertFailure = async (input: LeaseInsert): Promise<void> => {
  const error = await insertLease(input).then(
    () => {
      return null
    },
    (caughtError: unknown) => {
      return caughtError instanceof Error ? caughtError : new Error(String(caughtError))
    },
  )

  expect(error).toBeInstanceOf(Error)
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../../db/migrateDuckdb.ts'),
      import('../../services/appDatabaseService.ts'),
      import('../../utils/duckdbService.ts'),
      import('../../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const database = getAppDatabaseService()

  closeDatabase = () => {
    return database.close()
  }
  queryDatabase = <T>(statement: string) => {
    return database.queryJson<T>(statement)
  }
  runDatabase = (statement: string) => {
    return database.run(statement)
  }
})

afterEach(async () => {
  await runDatabase?.('DELETE FROM app.provider_admission_lease')
  resetProviderAdmissionLeaseForTests()
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('provider admission lease migration creates only the live lease shape', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  const columns = await queryDatabase<{columnName: string}>(`
    SELECT column_name AS columnName
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND table_name = 'provider_admission_lease'
    ORDER BY ordinal_position
  `)
  const indexes = await queryDatabase<{indexName: string}>(`
    SELECT index_name AS indexName
    FROM duckdb_indexes()
    WHERE schema_name = 'app'
      AND table_name = 'provider_admission_lease'
    ORDER BY index_name
  `)

  expect(
    columns.map((column) => {
      return column.columnName
    }),
  ).toEqual([
    'provider_key',
    'lease_kind',
    'lease_identity',
    'request_attempt_id',
    'endpoint_availability_key',
    'probe_attempt_id',
    'holder_token',
    'acquired_at',
    'heartbeat_at',
    'expires_at',
  ])
  expect(
    columns.some((column) => {
      return column.columnName.includes('closed') || column.columnName.includes('quarantine')
    }),
  ).toBe(false)
  expect(
    indexes.some((index) => {
      return index.indexName === 'idx_app_provider_admission_lease_expiry'
    }),
  ).toBe(true)
})

test('request and probe leases persist through the canonical non-null identity', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  const requestLeaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-a')
  const endpointAvailabilityKey = 'provider-a::http://localhost:30001'
  const probeLeaseIdentity = getProviderAdmissionProbeLeaseIdentity({
    endpointAvailabilityKey,
    probeAttemptId: 'probe-attempt-a',
  })

  await insertLease({
    holderToken: 'request-holder',
    leaseIdentity: requestLeaseIdentity,
    leaseKind: 'request',
    requestAttemptId: 'request-attempt-a',
  })
  await insertLease({
    endpointAvailabilityKey,
    holderToken: 'probe-holder',
    leaseIdentity: probeLeaseIdentity,
    leaseKind: 'probe',
    probeAttemptId: 'probe-attempt-a',
  })

  const rows = await queryDatabase<{leaseIdentity: string; leaseKind: string; requestAttemptId: string | null}>(`
    SELECT
      lease_identity AS leaseIdentity,
      lease_kind AS leaseKind,
      request_attempt_id AS requestAttemptId
    FROM app.provider_admission_lease
    ORDER BY lease_kind DESC
  `)

  expect(rows).toEqual([
    {leaseIdentity: requestLeaseIdentity, leaseKind: 'request', requestAttemptId: 'request-attempt-a'},
    {leaseIdentity: probeLeaseIdentity, leaseKind: 'probe', requestAttemptId: null},
  ])
})

test('lease identity uniqueness fences duplicate request attempts even when nullable ids differ', async () => {
  const requestLeaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-a')

  await insertLease({
    holderToken: 'request-holder-a',
    leaseIdentity: requestLeaseIdentity,
    leaseKind: 'request',
    requestAttemptId: 'request-attempt-a',
  })
  await expectLeaseInsertFailure({
    holderToken: 'request-holder-b',
    leaseIdentity: requestLeaseIdentity,
    leaseKind: 'request',
    providerKey: 'provider-b',
    requestAttemptId: 'request-attempt-a',
  })
})

test('shape checks reject weakened request and probe identities', async () => {
  await expectLeaseInsertFailure({
    holderToken: 'missing-request-id',
    leaseIdentity: getProviderAdmissionRequestLeaseIdentity('request-attempt-missing'),
    leaseKind: 'request',
    requestAttemptId: null,
  })
  await expectLeaseInsertFailure({
    holderToken: 'mismatched-request-id',
    leaseIdentity: getProviderAdmissionRequestLeaseIdentity('request-attempt-a'),
    leaseKind: 'request',
    requestAttemptId: 'request-attempt-b',
  })
  await expectLeaseInsertFailure({
    endpointAvailabilityKey: 'provider-a::http://localhost:30001',
    holderToken: 'mismatched-probe-id',
    leaseIdentity: getProviderAdmissionProbeLeaseIdentity({
      endpointAvailabilityKey: 'provider-a::http://localhost:30001',
      probeAttemptId: 'probe-attempt-a',
    }),
    leaseKind: 'probe',
    probeAttemptId: 'probe-attempt-b',
  })
})

test('release deletes the live lease row instead of retaining closed history', async () => {
  if (!queryDatabase || !runDatabase) {
    throw new Error('Test database not initialized')
  }

  const requestLeaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-release')

  await insertLease({
    holderToken: 'request-release-holder',
    leaseIdentity: requestLeaseIdentity,
    leaseKind: 'request',
    requestAttemptId: 'request-attempt-release',
  })
  await runDatabase(`
    DELETE FROM app.provider_admission_lease
    WHERE lease_identity = ${getSqlLiteral(requestLeaseIdentity)}
  `)

  const [row] = await queryDatabase<{leaseCount: number}>(`
    SELECT COUNT(*) AS leaseCount
    FROM app.provider_admission_lease
  `)

  expect(Number(row?.leaseCount)).toBe(0)
})

test('current owner acquire persists a lease and same-holder reacquire does not mutate timing', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  const firstSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 2,
    modelId: 'model-owner-acquire',
    modelProvider: 'openai',
    providerConnectionId: 'connection-owner-acquire',
    providerConnectionUpdatedAt: '2026-05-04T10:00:00.000Z',
    providerName: 'OpenAI',
  })
  const leaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-owner-acquire')
  const firstAcquire = await acquireProviderAdmissionLeaseOnCurrentOwner({
    holderToken: 'holder-a',
    leaseIdentity,
    nowMs: 1_000,
    requestAttemptId: 'request-attempt-owner-acquire',
    snapshot: firstSnapshot,
  })
  const [persistedBefore] = await queryDatabase<{
    acquiredAt: string
    expiresAt: string
    heartbeatAt: string
    holderToken: string
  }>(`
    SELECT
      acquired_at AS acquiredAt,
      heartbeat_at AS heartbeatAt,
      expires_at AS expiresAt,
      holder_token AS holderToken
    FROM app.provider_admission_lease
    WHERE lease_identity = ${getSqlLiteral(leaseIdentity)}
  `)
  const nextSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 1,
    modelId: 'model-owner-acquire',
    modelProvider: 'openai',
    providerConnectionId: 'connection-owner-acquire',
    providerConnectionUpdatedAt: '2026-05-04T10:01:00.000Z',
    providerName: 'OpenAI',
  })
  const reacquire = await acquireProviderAdmissionLeaseOnCurrentOwner({
    holderToken: 'holder-a',
    leaseIdentity,
    nowMs: 2_000,
    requestAttemptId: 'request-attempt-owner-acquire',
    snapshot: firstSnapshot,
  })
  const [persistedAfter] = await queryDatabase<{
    acquiredAt: string
    expiresAt: string
    heartbeatAt: string
    holderToken: string
  }>(`
    SELECT
      acquired_at AS acquiredAt,
      heartbeat_at AS heartbeatAt,
      expires_at AS expiresAt,
      holder_token AS holderToken
    FROM app.provider_admission_lease
    WHERE lease_identity = ${getSqlLiteral(leaseIdentity)}
  `)

  expect(firstAcquire).toMatchObject({acquired: true, activeLeaseCount: 1, alreadyHeld: false})
  expect(reacquire).toMatchObject({
    acquired: true,
    activeLeaseCount: 1,
    alreadyHeld: true,
    providerLimit: 1,
    providerLimitVersion: firstSnapshot.providerLimitVersion,
    staleProviderLimitSnapshot: true,
  })
  expect(reacquire.currentSnapshot.providerLimitVersion).toBe(nextSnapshot.providerLimitVersion)
  expect(persistedAfter).toEqual(persistedBefore)
})

test('current owner acquire returns alreadyHeld for a different fresh holder without replacing the row', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  const snapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 2,
    modelId: 'model-holder-fence',
    modelProvider: 'openai',
    providerConnectionId: 'connection-holder-fence',
    providerConnectionUpdatedAt: '2026-05-04T10:00:00.000Z',
    providerName: 'OpenAI',
  })
  const leaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-holder-fence')

  await acquireProviderAdmissionLeaseOnCurrentOwner({
    holderToken: 'holder-a',
    leaseIdentity,
    nowMs: 1_000,
    requestAttemptId: 'request-attempt-holder-fence',
    snapshot,
  })

  const blocked = await acquireProviderAdmissionLeaseOnCurrentOwner({
    holderToken: 'holder-b',
    leaseIdentity,
    nowMs: 2_000,
    requestAttemptId: 'request-attempt-holder-fence',
    snapshot,
  })
  const [row] = await queryDatabase<{holderToken: string; leaseCount: number}>(`
    SELECT holder_token AS holderToken, COUNT(*) OVER () AS leaseCount
    FROM app.provider_admission_lease
    WHERE lease_identity = ${getSqlLiteral(leaseIdentity)}
  `)

  expect(blocked).toMatchObject({acquired: false, alreadyHeld: true, reason: 'alreadyHeld'})
  expect(row?.holderToken).toBe('holder-a')
  expect(Number(row?.leaseCount)).toBe(1)
})

test('current owner acquire rejects stale provider limit versions before expiring stale rows', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  const firstSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 2,
    modelId: 'model-stale-expiry',
    modelProvider: 'openai',
    providerConnectionId: 'connection-stale-expiry',
    providerConnectionUpdatedAt: '2026-05-04T10:00:00.000Z',
    providerName: 'OpenAI',
  })
  const leaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-stale-expiry')

  await insertLease({
    acquiredAt: new Date('1970-01-01T00:00:01.000Z'),
    expiresAt: new Date('1970-01-01T00:00:02.000Z'),
    heartbeatAt: new Date('1970-01-01T00:00:01.000Z'),
    holderToken: 'holder-stale',
    leaseIdentity,
    leaseKind: 'request',
    providerKey: firstSnapshot.providerKey,
    requestAttemptId: 'request-attempt-stale-expiry',
  })

  const nextSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 1,
    modelId: 'model-stale-expiry',
    modelProvider: 'openai',
    providerConnectionId: 'connection-stale-expiry',
    providerConnectionUpdatedAt: '2026-05-04T10:01:00.000Z',
    providerName: 'OpenAI',
  })
  const rejected = await acquireProviderAdmissionLeaseOnCurrentOwner({
    holderToken: 'holder-new',
    leaseIdentity,
    nowMs: 3_000,
    requestAttemptId: 'request-attempt-stale-expiry',
    snapshot: firstSnapshot,
  })
  const [row] = await queryDatabase<{leaseCount: number}>(`
    SELECT COUNT(*) AS leaseCount
    FROM app.provider_admission_lease
    WHERE lease_identity = ${getSqlLiteral(leaseIdentity)}
  `)

  expect(rejected).toMatchObject({
    acquired: false,
    providerLimitVersion: nextSnapshot.providerLimitVersion,
    reason: 'staleProviderLimitSnapshot',
    staleProviderLimitSnapshot: true,
  })
  expect(Number(row?.leaseCount)).toBe(1)
})

test('current owner acquire counts request and probe leases before admitting', async () => {
  const snapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 2,
    modelId: 'model-physical-cap',
    modelProvider: 'openai',
    providerConnectionId: 'connection-physical-cap',
    providerConnectionUpdatedAt: '2026-05-04T10:00:00.000Z',
    providerName: 'OpenAI',
  })
  const requestLeaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-physical-cap')
  const probeLeaseIdentity = getProviderAdmissionProbeLeaseIdentity({
    endpointAvailabilityKey: 'connection-physical-cap::http://localhost:30001',
    probeAttemptId: 'probe-attempt-physical-cap',
  })
  const blockedLeaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-physical-cap-blocked')

  await acquireProviderAdmissionLeaseOnCurrentOwner({
    holderToken: 'request-holder',
    leaseIdentity: requestLeaseIdentity,
    nowMs: 1_000,
    requestAttemptId: 'request-attempt-physical-cap',
    snapshot,
  })
  await acquireProviderAdmissionLeaseOnCurrentOwner({
    endpointAvailabilityKey: 'connection-physical-cap::http://localhost:30001',
    holderToken: 'probe-holder',
    leaseIdentity: probeLeaseIdentity,
    leaseKind: 'probe',
    nowMs: 1_000,
    probeAttemptId: 'probe-attempt-physical-cap',
    snapshot,
  })

  const blocked = await acquireProviderAdmissionLeaseOnCurrentOwner({
    holderToken: 'blocked-holder',
    leaseIdentity: blockedLeaseIdentity,
    nowMs: 2_000,
    requestAttemptId: 'request-attempt-physical-cap-blocked',
    snapshot,
  })

  expect(blocked).toMatchObject({acquired: false, activeLeaseCount: 2, reason: 'capacity'})
})

test('current owner acquire serializes concurrent inserts below provider limit', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  const snapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 1,
    modelId: 'model-concurrent-acquire',
    modelProvider: 'openai',
    providerConnectionId: 'connection-concurrent-acquire',
    providerConnectionUpdatedAt: '2026-05-04T10:00:00.000Z',
    providerName: 'OpenAI',
  })
  const results = await Promise.all(
    ['a', 'b'].map((suffix) => {
      return acquireProviderAdmissionLeaseOnCurrentOwner({
        holderToken: `holder-${suffix}`,
        leaseIdentity: getProviderAdmissionRequestLeaseIdentity(`request-attempt-concurrent-${suffix}`),
        nowMs: 1_000,
        requestAttemptId: `request-attempt-concurrent-${suffix}`,
        snapshot,
      })
    }),
  )
  const [row] = await queryDatabase<{leaseCount: number}>(`
    SELECT COUNT(*) AS leaseCount
    FROM app.provider_admission_lease
    WHERE provider_key = ${getSqlLiteral(snapshot.providerKey)}
  `)

  expect(
    results.filter((result) => {
      return result.acquired
    }),
  ).toHaveLength(1)
  expect(Number(row?.leaseCount)).toBe(1)
})

test('current owner release and expiry serialize behind holder fencing', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  const snapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 2,
    modelId: 'model-release-expire',
    modelProvider: 'openai',
    providerConnectionId: 'connection-release-expire',
    providerConnectionUpdatedAt: '2026-05-04T10:00:00.000Z',
    providerName: 'OpenAI',
  })
  const leaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-release-expire')

  await acquireProviderAdmissionLeaseOnCurrentOwner({
    holderToken: 'holder-a',
    leaseIdentity,
    nowMs: 1_000,
    requestAttemptId: 'request-attempt-release-expire',
    snapshot,
    ttlMs: 1,
  })

  expect(
    await releaseProviderAdmissionLeaseOnCurrentOwner({
      holderToken: 'holder-b',
      leaseIdentity,
      providerKey: snapshot.providerKey,
    }),
  ).toBe(false)
  expect(await expireProviderAdmissionLeasesOnCurrentOwner({nowMs: 2_000, providerKey: snapshot.providerKey})).toEqual({
    expiredLeaseCount: 1,
  })

  const [row] = await queryDatabase<{leaseCount: number}>(`
    SELECT COUNT(*) AS leaseCount
    FROM app.provider_admission_lease
    WHERE lease_identity = ${getSqlLiteral(leaseIdentity)}
  `)

  expect(Number(row?.leaseCount)).toBe(0)
})

test('current owner heartbeat extends only the exact held lease across provider version changes', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  const firstSnapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 2,
    modelId: 'model-heartbeat-fence',
    modelProvider: 'openai',
    providerConnectionId: 'connection-heartbeat-fence',
    providerConnectionUpdatedAt: '2026-05-04T10:00:00.000Z',
    providerName: 'OpenAI',
  })
  const leaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-heartbeat-fence')

  await acquireProviderAdmissionLeaseOnCurrentOwner({
    holderToken: 'holder-a',
    leaseIdentity,
    nowMs: 1_000,
    requestAttemptId: 'request-attempt-heartbeat-fence',
    snapshot: firstSnapshot,
    ttlMs: 2_000,
  })

  getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 1,
    modelId: 'model-heartbeat-fence',
    modelProvider: 'openai',
    providerConnectionId: 'connection-heartbeat-fence',
    providerConnectionUpdatedAt: '2026-05-04T10:01:00.000Z',
    providerName: 'OpenAI',
  })

  const blocked = await heartbeatProviderAdmissionLeaseOnCurrentOwner({
    holderToken: 'holder-b',
    leaseIdentity,
    nowMs: 2_000,
    providerKey: firstSnapshot.providerKey,
    ttlMs: 10_000,
  })
  const extended = await heartbeatProviderAdmissionLeaseOnCurrentOwner({
    holderToken: 'holder-a',
    leaseIdentity,
    nowMs: 3_000,
    providerKey: firstSnapshot.providerKey,
    ttlMs: 10_000,
  })
  const [row] = await queryDatabase<{
    expiresAt: string
    heartbeatAt: string
    holderToken: string
    providerKey: string
  }>(`
    SELECT
      expires_at AS expiresAt,
      heartbeat_at AS heartbeatAt,
      holder_token AS holderToken,
      provider_key AS providerKey
    FROM app.provider_admission_lease
    WHERE lease_identity = ${getSqlLiteral(leaseIdentity)}
  `)

  expect(blocked).toEqual({heartbeat: false, reason: 'notHolder'})
  expect(extended).toMatchObject({
    heartbeat: true,
    lease: {holderToken: 'holder-a', providerKey: firstSnapshot.providerKey},
  })
  expect(new Date(row?.expiresAt ?? '').getTime()).toBe(13_000)
  expect(new Date(row?.heartbeatAt ?? '').getTime()).toBe(3_000)
  expect(row).toMatchObject({holderToken: 'holder-a', providerKey: firstSnapshot.providerKey})
})

test('current owner release result reports notHolder without deleting another holder lease', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  const snapshot = getProviderBucketSnapshot({
    getNonCodexCapacity,
    maxInflightRequests: 2,
    modelId: 'model-release-result',
    modelProvider: 'openai',
    providerConnectionId: 'connection-release-result',
    providerConnectionUpdatedAt: '2026-05-04T10:00:00.000Z',
    providerName: 'OpenAI',
  })
  const leaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-release-result')

  await acquireProviderAdmissionLeaseOnCurrentOwner({
    holderToken: 'holder-a',
    leaseIdentity,
    nowMs: 1_000,
    requestAttemptId: 'request-attempt-release-result',
    snapshot,
  })

  expect(
    await releaseProviderAdmissionLeaseWithResultOnCurrentOwner({
      holderToken: 'holder-b',
      leaseIdentity,
      providerKey: snapshot.providerKey,
    }),
  ).toEqual({released: false, reason: 'notHolder'})

  const [row] = await queryDatabase<{holderToken: string; leaseCount: number}>(`
    SELECT holder_token AS holderToken, COUNT(*) OVER () AS leaseCount
    FROM app.provider_admission_lease
    WHERE lease_identity = ${getSqlLiteral(leaseIdentity)}
  `)

  expect(row?.holderToken).toBe('holder-a')
  expect(Number(row?.leaseCount)).toBe(1)
  expect(
    await releaseProviderAdmissionLeaseWithResultOnCurrentOwner({
      holderToken: 'holder-a',
      leaseIdentity,
      providerKey: snapshot.providerKey,
    }),
  ).toEqual({released: true})
})

test('current owner reconciliation closes exact request leases without closing probes', async () => {
  if (!queryDatabase) {
    throw new Error('Test database not initialized')
  }

  const providerKey = 'provider-reconcile'
  const requestLeaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-reconcile-terminal')
  const demotedLeaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-reconcile-demoted')
  const freshLeaseIdentity = getProviderAdmissionRequestLeaseIdentity('request-attempt-reconcile-fresh')
  const endpointAvailabilityKey = 'provider-reconcile::http://localhost:30001'
  const probeLeaseIdentity = getProviderAdmissionProbeLeaseIdentity({
    endpointAvailabilityKey,
    probeAttemptId: 'probe-attempt-reconcile-terminal',
  })

  await insertLease({
    holderToken: 'terminal-holder',
    leaseIdentity: requestLeaseIdentity,
    leaseKind: 'request',
    providerKey,
    requestAttemptId: 'request-attempt-reconcile-terminal',
  })
  await insertLease({
    endpointAvailabilityKey,
    holderToken: 'probe-holder',
    leaseIdentity: probeLeaseIdentity,
    leaseKind: 'probe',
    probeAttemptId: 'probe-attempt-reconcile-terminal',
    providerKey,
  })
  await insertLease({
    holderToken: 'demoted-holder',
    leaseIdentity: demotedLeaseIdentity,
    leaseKind: 'request',
    providerKey,
    requestAttemptId: 'request-attempt-reconcile-demoted',
  })
  await insertLease({
    holderToken: 'fresh-holder',
    leaseIdentity: freshLeaseIdentity,
    leaseKind: 'request',
    providerKey,
    requestAttemptId: 'request-attempt-reconcile-fresh',
  })

  const result = await reconcileProviderAdmissionLeasesOnCurrentOwner({
    holderGraceMs: 1_000,
    holderWorkerDemotions: [
      {demotedAtMs: 1_000, freshness: 'demoted', holderToken: 'demoted-holder'},
      {freshness: 'fresh', holderToken: 'fresh-holder', observedAtMs: 2_000},
    ],
    nowMs: 3_000,
    terminalRequestAttemptCloseouts: [{providerKey, requestAttemptId: 'request-attempt-reconcile-terminal'}],
  })
  const rows = await queryDatabase<{leaseIdentity: string; leaseKind: string}>(`
    SELECT lease_identity AS leaseIdentity, lease_kind AS leaseKind
    FROM app.provider_admission_lease
    WHERE provider_key = ${getSqlLiteral(providerKey)}
    ORDER BY lease_kind ASC, lease_identity ASC
  `)

  expect(result).toMatchObject({
    durableRequestCloseoutLeaseCount: 1,
    holderDemotionLeaseCount: 1,
    suspectFreshHolderLeaseCount: 1,
  })
  expect(rows).toEqual([
    {leaseIdentity: probeLeaseIdentity, leaseKind: 'probe'},
    {leaseIdentity: freshLeaseIdentity, leaseKind: 'request'},
  ])

  const proofResult = await reconcileProviderAdmissionLeasesOnCurrentOwner({
    suspectFreshProofs: [
      {holderToken: 'probe-holder', leaseIdentity: probeLeaseIdentity, leaseKind: 'probe', providerKey},
    ],
  })
  const remainingRows = await queryDatabase<{leaseIdentity: string; leaseKind: string}>(`
    SELECT lease_identity AS leaseIdentity, lease_kind AS leaseKind
    FROM app.provider_admission_lease
    WHERE provider_key = ${getSqlLiteral(providerKey)}
    ORDER BY lease_kind ASC, lease_identity ASC
  `)

  expect(proofResult).toMatchObject({suspectFreshProofLeaseCount: 1})
  expect(remainingRows).toEqual([{leaseIdentity: freshLeaseIdentity, leaseKind: 'request'}])
})
