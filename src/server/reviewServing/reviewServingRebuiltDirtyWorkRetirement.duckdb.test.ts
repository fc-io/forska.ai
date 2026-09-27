import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-rebuilt-dirty-work-retirement')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const chunkStartedAt = '2026-09-28T01:00:00Z'

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const insertSnapshot = async (input: {
  components: readonly string[]
  projectId: string
  snapshotId: string
  status: 'active' | 'candidate'
}) => {
  const componentState = {
    optional: input.components.map((component) => {
      return {
        baseGeneration: '0',
        component,
        patchWatermark: '0',
        projectionIdentity: `${component}:${input.projectId}`,
        requirement: 'optional',
      }
    }),
    required: [],
  }

  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id, snapshot_id, snapshot_status, review_config_hash, composed_identity_json, component_state_json,
      required_components_json, optional_components_json, source_watermarks_json
    ) VALUES (
      '${input.projectId}', '${input.snapshotId}', '${input.status}', 'review-config', '{}',
      '${JSON.stringify(componentState)}', '[]', '${JSON.stringify(input.components)}', '{}'
    )
  `)
}

const insertCompletedChunk = async (input: {
  chunkId: string
  component: string
  endKey: string
  lastError?: string
  projectId: string
  snapshotId: string
  startKey: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      chunk_id, project_id, projection_component, projection_identity, chunk_start_key, chunk_end_key, status,
      started_at, completed_at, snapshot_id, request_id, output_base_generation, last_error
    ) VALUES (
      '${input.chunkId}', '${input.projectId}', '${input.component}', '${input.component}:${input.projectId}',
      '${input.startKey}', '${input.endKey}', 'completed', TIMESTAMPTZ '${chunkStartedAt}',
      TIMESTAMPTZ '${chunkStartedAt}' + INTERVAL 1 MINUTE, '${input.snapshotId}', 'rebuild:${input.projectId}', 0,
      ${input.lastError === undefined ? 'NULL' : `'${input.lastError}'`}
    )
  `)
}

const insertDirtyWork = async (input: {
  articleId: string
  component: string
  dirtyWorkId: string
  projectId: string
  status: string
  updatedAt: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_serving_dirty_work (
      dirty_work_id, project_id, scope_kind, scope_id, article_id, projection_component, projection_identity,
      dirty_kind, source_partition, first_source_high_water_mark, latest_source_high_water_mark, latest_delta_id,
      status, created_at, updated_at
    ) VALUES (
      '${input.dirtyWorkId}', '${input.projectId}', 'article', '${input.projectId}:${input.articleId}',
      '${input.articleId}', '${input.component}', '${input.component}:${input.projectId}', 'article.judgmentInput.updated',
      'article:all', 7, 7, 'delta-${input.dirtyWorkId}', '${input.status}', TIMESTAMPTZ '${input.updatedAt}',
      TIMESTAMPTZ '${input.updatedAt}'
    )
  `)
  await getDatabase().run(`
    INSERT INTO app.review_serving_dirty_work_claim_state (
      dirty_work_id, project_id, projection_component, projection_identity, source_partition, status,
      latest_source_high_water_mark
    ) VALUES (
      '${input.dirtyWorkId}', '${input.projectId}', '${input.component}', '${input.component}:${input.projectId}',
      'article:all', '${input.status}', 7
    )
  `)
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

  database = getAppDatabaseService()
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('dirty work that a completed rebuild chunk re-read is completed, the rest keeps waiting for a patch', async () => {
  const {resetReviewServingRebuiltDirtyWorkRetirementForTests, retireReviewServingDirtyWorkRebuiltByChunks} =
    await import('./reviewServingRebuiltDirtyWorkRetirement.ts')

  await insertSnapshot({
    components: ['payload', 'display'],
    projectId: 'project-rebuilt',
    snapshotId: 'snapshot-active',
    status: 'active',
  })
  await insertCompletedChunk({
    chunkId: 'chunk-payload',
    component: 'payload',
    endKey: 'article-m',
    projectId: 'project-rebuilt',
    snapshotId: 'snapshot-active',
    startKey: 'article-a',
  })
  await insertCompletedChunk({
    chunkId: 'chunk-display-superseded',
    component: 'display',
    endKey: 'article-z',
    lastError: 'superseded by retired snapshot',
    projectId: 'project-rebuilt',
    snapshotId: 'snapshot-active',
    startKey: 'article-a',
  })
  await insertDirtyWork({
    articleId: 'article-b',
    component: 'payload',
    dirtyWorkId: 'dirty-before-chunk',
    projectId: 'project-rebuilt',
    status: 'pending',
    updatedAt: '2026-09-28T00:30:00Z',
  })
  await insertDirtyWork({
    articleId: 'article-c',
    component: 'payload',
    dirtyWorkId: 'dirty-parked-before-chunk',
    projectId: 'project-rebuilt',
    status: 'blocked_by_rebuild',
    updatedAt: '2026-09-28T00:40:00Z',
  })
  await insertDirtyWork({
    articleId: 'article-d',
    component: 'payload',
    dirtyWorkId: 'dirty-after-chunk',
    projectId: 'project-rebuilt',
    status: 'pending',
    updatedAt: '2026-09-28T01:05:00Z',
  })
  await insertDirtyWork({
    articleId: 'article-x',
    component: 'payload',
    dirtyWorkId: 'dirty-outside-range',
    projectId: 'project-rebuilt',
    status: 'pending',
    updatedAt: '2026-09-28T00:30:00Z',
  })
  await insertDirtyWork({
    articleId: 'article-e',
    component: 'payload',
    dirtyWorkId: 'dirty-running',
    projectId: 'project-rebuilt',
    status: 'running',
    updatedAt: '2026-09-28T00:30:00Z',
  })
  await insertDirtyWork({
    articleId: 'article-b',
    component: 'display',
    dirtyWorkId: 'dirty-superseded-chunk',
    projectId: 'project-rebuilt',
    status: 'pending',
    updatedAt: '2026-09-28T00:30:00Z',
  })

  await insertSnapshot({
    components: ['payload'],
    projectId: 'project-with-candidate',
    snapshotId: 'snapshot-other-active',
    status: 'active',
  })
  await insertSnapshot({
    components: ['payload'],
    projectId: 'project-with-candidate',
    snapshotId: 'snapshot-other-candidate',
    status: 'candidate',
  })
  await insertCompletedChunk({
    chunkId: 'chunk-other-payload',
    component: 'payload',
    endKey: 'article-m',
    projectId: 'project-with-candidate',
    snapshotId: 'snapshot-other-active',
    startKey: 'article-a',
  })
  await insertDirtyWork({
    articleId: 'article-b',
    component: 'payload',
    dirtyWorkId: 'dirty-candidate-still-needs-patch',
    projectId: 'project-with-candidate',
    status: 'pending',
    updatedAt: '2026-09-28T00:30:00Z',
  })

  resetReviewServingRebuiltDirtyWorkRetirementForTests()

  const retirement = await retireReviewServingDirtyWorkRebuiltByChunks({nowMs: Date.parse('2026-09-28T02:00:00Z')})
  const dirtyWork = await getDatabase().queryJson<{
    claimStatus: string
    dirtyWorkId: string
    lifecycleReason: string | null
    status: string
  }>(`
    SELECT
      dirty.dirty_work_id AS dirtyWorkId,
      dirty.status,
      dirty.lifecycle_reason AS lifecycleReason,
      claim_state.status AS claimStatus
    FROM app.review_serving_dirty_work dirty
    INNER JOIN app.review_serving_dirty_work_claim_state claim_state
      ON claim_state.dirty_work_id = dirty.dirty_work_id
    ORDER BY dirty.dirty_work_id
  `)

  expect(retirement).toEqual({retiredCount: 2, scanned: true})
  expect(dirtyWork).toEqual([
    {claimStatus: 'pending', dirtyWorkId: 'dirty-after-chunk', lifecycleReason: null, status: 'pending'},
    {
      claimStatus: 'completed',
      dirtyWorkId: 'dirty-before-chunk',
      lifecycleReason: 'covered_by_rebuild',
      status: 'completed',
    },
    {
      claimStatus: 'pending',
      dirtyWorkId: 'dirty-candidate-still-needs-patch',
      lifecycleReason: null,
      status: 'pending',
    },
    {claimStatus: 'pending', dirtyWorkId: 'dirty-outside-range', lifecycleReason: null, status: 'pending'},
    {
      claimStatus: 'completed',
      dirtyWorkId: 'dirty-parked-before-chunk',
      lifecycleReason: 'covered_by_rebuild',
      status: 'completed',
    },
    {claimStatus: 'running', dirtyWorkId: 'dirty-running', lifecycleReason: null, status: 'running'},
    {claimStatus: 'pending', dirtyWorkId: 'dirty-superseded-chunk', lifecycleReason: null, status: 'pending'},
  ])
  expect(
    await getDatabase().queryJson<{count: number}>(`
      SELECT COUNT(*)::INTEGER AS count
      FROM app.review_serving_dirty_work_ack
      WHERE dirty_work_id IN ('dirty-before-chunk', 'dirty-parked-before-chunk')
    `),
  ).toEqual([{count: 2}])
  expect(await retireReviewServingDirtyWorkRebuiltByChunks({nowMs: Date.parse('2026-09-28T02:00:10Z')})).toEqual({
    retiredCount: 0,
    scanned: true,
  })
  expect(await retireReviewServingDirtyWorkRebuiltByChunks({nowMs: Date.parse('2026-09-28T02:00:20Z')})).toEqual({
    retiredCount: 0,
    scanned: false,
  })
})
