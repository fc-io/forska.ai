import {afterAll, afterEach, beforeAll, expect, test} from 'bun:test'

import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {createTempRuntimeRoot} from '../../test/createTempRuntimeRoot.ts'
import {
  getProviderAdmissionProbeLeaseIdentity,
  getProviderAdmissionRequestLeaseIdentity,
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
