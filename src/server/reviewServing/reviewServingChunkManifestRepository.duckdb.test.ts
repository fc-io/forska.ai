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
