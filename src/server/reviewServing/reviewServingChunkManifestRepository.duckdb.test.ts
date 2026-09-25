import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import type {ReviewServingChunkManifestRepositoryDatabase} from './reviewServingChunkManifestRepository.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('f1-rebuild-chunk-claim-lane')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

let database: ReviewServingChunkManifestRepositoryDatabase | null = null
let closeDatabase: (() => Promise<void>) | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const insertProject = async (projectId: string) => {
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', '${projectId}', 'model-claim-lane', TRUE, TRUE, FALSE, FALSE)
  `)
}

const insertRequestWithPendingChunk = async (input: {
  component: string
  priority: number
  projectId: string
  requestId: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_request (
      request_id, project_id, reason, requested_components_json, priority, status, admission_state, updated_at
    ) VALUES (
      '${input.requestId}',
      '${input.projectId}',
      'claimLaneTest',
      '["${input.component}"]'::JSON,
      ${input.priority},
      'admitted',
      'admitted',
      TIMESTAMPTZ '2026-09-23T10:00:00Z'
    )
  `)
  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id, snapshot_id, snapshot_status, review_config_hash, composed_identity_json, component_state_json,
      required_components_json, optional_components_json, source_watermarks_json, updated_at
    ) VALUES (
      '${input.projectId}',
      'snapshot-${input.projectId}',
      'candidate',
      'review-config-claim-lane',
      '{}'::JSON,
      '{"optional":[],"required":[]}'::JSON,
      '["${input.component}"]'::JSON,
      '[]'::JSON,
      '{}'::JSON,
      TIMESTAMPTZ '2026-09-23T10:00:00Z'
    )
  `)
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      chunk_id, request_id, project_id, snapshot_id, projection_component, projection_identity, chunk_start_key,
      chunk_end_key, status, admission_state, created_at, updated_at
    ) VALUES (
      'chunk-${input.requestId}',
      '${input.requestId}',
      '${input.projectId}',
      'snapshot-${input.projectId}',
      '${input.component}',
      '${input.component}:identity',
      'article-a',
      'article-z',
      'pending',
      'admitted',
      TIMESTAMPTZ '2026-09-23T10:00:00Z',
      TIMESTAMPTZ '2026-09-23T10:00:00Z'
    )
  `)
}

const claimAllInOrder = async (
  getNextClaimable: (typeof import('./reviewServingChunkManifestRepository.ts'))['getNextClaimableReviewServingRebuildChunk'],
  claimedRequestIds: readonly string[] = [],
): Promise<readonly string[]> => {
  const next = await getNextClaimable({now: '2026-09-23T11:00:00.000Z', releaseInactiveRequests: false}, getDatabase())

  if (next === null) {
    return claimedRequestIds
  }

  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'completed', started_at = current_timestamp, completed_at = current_timestamp
    WHERE chunk_id = '${next.chunkId}'
  `)

  return claimAllInOrder(getNextClaimable, [...claimedRequestIds, next.requestId ?? 'requestless'])
}

const getTimestampSql = (value: string | null | undefined) => {
  return value === null || value === undefined ? 'NULL' : `TIMESTAMPTZ '${value}'`
}

const clearRebuildState = async () => {
  await getDatabase().run('DELETE FROM app.review_rebuild_chunk_manifest')
  await getDatabase().run('DELETE FROM app.review_rebuild_request')
  await getDatabase().run('DELETE FROM app.review_serving_snapshot_manifest')
}

const insertSnapshot = async (input: {components: readonly string[]; projectId: string}) => {
  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id, snapshot_id, snapshot_status, review_config_hash, composed_identity_json, component_state_json,
      required_components_json, optional_components_json, source_watermarks_json, updated_at
    ) VALUES (
      '${input.projectId}',
      'snapshot-${input.projectId}',
      'candidate',
      'review-config-claim-lane',
      '{}'::JSON,
      '{"optional":[],"required":[]}'::JSON,
      '${JSON.stringify(input.components)}'::JSON,
      '[]'::JSON,
      '{}'::JSON,
      TIMESTAMPTZ '2026-09-23T08:00:00Z'
    )
  `)
}

const insertRequest = async (input: {
  admittedAt: string
  component: string
  priority: number
  projectId: string
  requestId: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_request (
      request_id, project_id, reason, requested_components_json, priority, status, admission_state, admitted_at,
      created_at, updated_at
    ) VALUES (
      '${input.requestId}',
      '${input.projectId}',
      'claimLaneTest',
      '["${input.component}"]'::JSON,
      ${input.priority},
      'admitted',
      'admitted',
      TIMESTAMPTZ '${input.admittedAt}',
      TIMESTAMPTZ '${input.admittedAt}',
      TIMESTAMPTZ '${input.admittedAt}'
    )
  `)
}

const insertChunk = async (input: {
  chunkId: string
  component: string
  leaseExpiresAt?: string | null
  leaseOwner?: string | null
  projectId: string
  requestId: string
  startedAt?: string | null
  status: 'completed' | 'pending' | 'running'
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      chunk_id, request_id, project_id, snapshot_id, projection_component, projection_identity, chunk_start_key,
      chunk_end_key, status, admission_state, lease_owner, lease_expires_at, started_at, created_at, updated_at
    ) VALUES (
      '${input.chunkId}',
      '${input.requestId}',
      '${input.projectId}',
      'snapshot-${input.projectId}',
      '${input.component}',
      '${input.component}:identity',
      '${input.chunkId}:a',
      '${input.chunkId}:z',
      '${input.status}',
      'admitted',
      ${input.leaseOwner === null || input.leaseOwner === undefined ? 'NULL' : `'${input.leaseOwner}'`},
      ${getTimestampSql(input.leaseExpiresAt)},
      ${getTimestampSql(input.startedAt)},
      TIMESTAMPTZ '2026-09-23T08:00:00Z',
      TIMESTAMPTZ '2026-09-23T08:00:00Z'
    )
  `)
}

const insertRequestWithPendingChunks = async (input: {
  admittedAt: string
  chunkCount: number
  component: string
  priority: number
  projectId: string
  requestId: string
}) => {
  await insertProject(input.projectId)
  await insertSnapshot({components: [input.component], projectId: input.projectId})
  await insertRequest(input)
  await Array.from({length: input.chunkCount}).reduce<Promise<void>>(async (previous, _chunk, chunkIndex) => {
    await previous
    await insertChunk({
      chunkId: `chunk-${input.requestId}-${chunkIndex}`,
      component: input.component,
      projectId: input.projectId,
      requestId: input.requestId,
      status: 'pending',
    })
  }, Promise.resolve())
}

const claimInRotation = async (
  repository: typeof import('./reviewServingChunkManifestRepository.ts'),
  claimCount: number,
  claimedRequestIds: readonly string[] = [],
): Promise<readonly string[]> => {
  const claimIndex = claimedRequestIds.length
  const next =
    claimIndex >= claimCount
      ? null
      : await repository.getNextClaimableReviewServingRebuildChunk(
          {
            claimOrder: repository.getReviewServingRebuildChunkClaimOrder(claimIndex),
            now: '2026-09-23T12:00:00.000Z',
            releaseInactiveRequests: false,
          },
          getDatabase(),
        )

  if (next === null) {
    return claimedRequestIds
  }

  const startedAt = new Date(Date.parse('2026-09-23T11:00:00.000Z') + claimIndex * 60_000).toISOString()

  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'completed', started_at = TIMESTAMPTZ '${startedAt}', completed_at = TIMESTAMPTZ '${startedAt}'
    WHERE chunk_id = '${next.chunkId}'
  `)

  return claimInRotation(repository, claimCount, [...claimedRequestIds, next.requestId ?? 'requestless'])
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  const appDatabase = getAppDatabaseService()

  database = appDatabase as ReviewServingChunkManifestRepositoryDatabase
  closeDatabase = () => {
    return appDatabase.close()
  }

  await appDatabase.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('connection-claim-lane', 'sglang', 'SGLang', TRUE, 'none', 'https://worker.example.test')
  `)
  await appDatabase.run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant, metadata_json)
    VALUES ('model-claim-lane', 'connection-claim-lane', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE, 'thinking', '{}'::JSON)
  `)
})

afterAll(async () => {
  await closeDatabase?.()
  tempRuntimeRoot.cleanup()
})

test('rebuild chunk claims in DuckDB run page parts of background refreshes after higher-priority bulk work', async () => {
  const {getNextClaimableReviewServingRebuildChunk} = await import('./reviewServingChunkManifestRepository.ts')
  const requests = [
    {component: 'selectedImport', priority: 100, projectId: 'project-refresh-100', requestId: 'request-refresh-100'},
    {component: 'selectedImport', priority: 499, projectId: 'project-refresh-499', requestId: 'request-refresh-499'},
    {component: 'posting', priority: 500, projectId: 'project-filters-500', requestId: 'request-filters-500'},
    {component: 'display', priority: 500, projectId: 'project-page-500', requestId: 'request-page-500'},
    {component: 'display', priority: 10_000, projectId: 'project-activation', requestId: 'request-activation-10000'},
  ]

  await requests.reduce<Promise<void>>(async (previous, request) => {
    await previous
    await insertProject(request.projectId)
    await insertRequestWithPendingChunk(request)
  }, Promise.resolve())

  expect(await claimAllInOrder(getNextClaimableReviewServingRebuildChunk)).toEqual([
    'request-activation-10000',
    'request-page-500',
    'request-filters-500',
    'request-refresh-499',
    'request-refresh-100',
  ])
})

test('rebuild chunk claims in DuckDB give every Nth claim to the least recently started request', async () => {
  const repository = await import('./reviewServingChunkManifestRepository.ts')
  const claimInterval = repository.reviewServingRebuildChunkLongestWaitingClaimInterval
  const busyClaims = Array.from({length: claimInterval - 1}, () => {
    return 'request-busy-activation'
  })

  await clearRebuildState()
  await insertRequestWithPendingChunks({
    admittedAt: '2026-09-23T08:00:00Z',
    chunkCount: claimInterval * 3,
    component: 'display',
    priority: 10_000,
    projectId: 'project-busy',
    requestId: 'request-busy-activation',
  })
  await insertRequestWithPendingChunks({
    admittedAt: '2026-09-23T09:00:00Z',
    chunkCount: 2,
    component: 'payload',
    priority: 100,
    projectId: 'project-quiet-payload',
    requestId: 'request-quiet-payload',
  })
  await insertRequestWithPendingChunks({
    admittedAt: '2026-09-23T09:30:00Z',
    chunkCount: 2,
    component: 'summary',
    priority: 50,
    projectId: 'project-quiet-summary',
    requestId: 'request-quiet-summary',
  })

  expect(await claimInRotation(repository, claimInterval * 2)).toEqual([
    ...busyClaims,
    'request-quiet-payload',
    ...busyClaims,
    'request-quiet-summary',
  ])
})

test('same-project backpressure in DuckDB ignores critical chunks whose running lease expired', async () => {
  const {getReviewServingRebuildChunkClaimWhere} = await import('./reviewServingChunkManifestRepository.ts')
  const getClaimableChunkIds = async (now: string) => {
    const rows = await getDatabase().queryJson<{chunkId: string}>(`
      SELECT candidate.chunk_id AS chunkId
      FROM app.review_rebuild_chunk_manifest candidate
      WHERE ${getReviewServingRebuildChunkClaimWhere({now, projectId: 'project-pressure'}, 'candidate')}
      ORDER BY candidate.chunk_id
    `)

    return rows.map((row) => {
      return row.chunkId
    })
  }

  await clearRebuildState()
  await insertProject('project-pressure')
  await insertSnapshot({components: ['payload', 'summary'], projectId: 'project-pressure'})
  await insertRequest({
    admittedAt: '2026-09-23T09:00:00Z',
    component: 'payload',
    priority: 100,
    projectId: 'project-pressure',
    requestId: 'request-pressure-payload',
  })
  await insertRequest({
    admittedAt: '2026-09-23T09:00:00Z',
    component: 'summary',
    priority: 50,
    projectId: 'project-pressure',
    requestId: 'request-pressure-summary',
  })
  await insertChunk({
    chunkId: 'chunk-pressure-payload',
    component: 'payload',
    leaseExpiresAt: '2026-09-23T11:30:00Z',
    leaseOwner: 'worker-before-restart',
    projectId: 'project-pressure',
    requestId: 'request-pressure-payload',
    startedAt: '2026-09-23T11:28:00Z',
    status: 'running',
  })
  await insertChunk({
    chunkId: 'chunk-pressure-summary',
    component: 'summary',
    projectId: 'project-pressure',
    requestId: 'request-pressure-summary',
    status: 'pending',
  })

  expect(await getClaimableChunkIds('2026-09-23T11:29:00.000Z')).toEqual([])
  expect(await getClaimableChunkIds('2026-09-23T11:31:00.000Z')).toEqual([
    'chunk-pressure-payload',
    'chunk-pressure-summary',
  ])
})

test('resetting expired running rebuild chunks in DuckDB only touches expired leases in scope', async () => {
  const {resetExpiredRunningReviewServingRebuildChunks} = await import('./reviewServingChunkManifestRepository.ts')
  const runningChunk = {
    component: 'payload',
    projectId: 'project-reset',
    requestId: 'request-reset',
    startedAt: '2026-09-23T10:00:00Z',
    status: 'running' as const,
  }

  await clearRebuildState()
  await insertChunk({
    ...runningChunk,
    chunkId: 'chunk-reset-expired',
    leaseExpiresAt: '2026-09-23T10:30:00Z',
    leaseOwner: 'worker-before-restart',
  })
  await insertChunk({...runningChunk, chunkId: 'chunk-reset-no-lease'})
  await insertChunk({
    ...runningChunk,
    chunkId: 'chunk-reset-live',
    leaseExpiresAt: '2026-09-23T11:30:00Z',
    leaseOwner: 'worker-live',
  })
  await insertChunk({...runningChunk, chunkId: 'chunk-reset-completed', status: 'completed'})
  await insertChunk({
    ...runningChunk,
    chunkId: 'chunk-reset-other-project',
    leaseExpiresAt: '2026-09-23T10:30:00Z',
    leaseOwner: 'worker-before-restart',
    projectId: 'project-reset-other',
  })

  await resetExpiredRunningReviewServingRebuildChunks(
    {now: '2026-09-23T11:00:00.000Z', projectId: 'project-reset'},
    getDatabase(),
  )

  expect(
    await getDatabase().queryJson(`
      SELECT
        chunk_id AS chunkId,
        status,
        lease_owner AS leaseOwner,
        lease_expires_at IS NOT NULL AS hasLease,
        started_at IS NOT NULL AS hasStartedAt
      FROM app.review_rebuild_chunk_manifest
      ORDER BY chunk_id
    `),
  ).toEqual([
    {chunkId: 'chunk-reset-completed', hasLease: false, hasStartedAt: true, leaseOwner: null, status: 'completed'},
    {chunkId: 'chunk-reset-expired', hasLease: false, hasStartedAt: true, leaseOwner: null, status: 'pending'},
    {chunkId: 'chunk-reset-live', hasLease: true, hasStartedAt: true, leaseOwner: 'worker-live', status: 'running'},
    {chunkId: 'chunk-reset-no-lease', hasLease: false, hasStartedAt: true, leaseOwner: null, status: 'pending'},
    {
      chunkId: 'chunk-reset-other-project',
      hasLease: true,
      hasStartedAt: true,
      leaseOwner: 'worker-before-restart',
      status: 'running',
    },
  ])
})
