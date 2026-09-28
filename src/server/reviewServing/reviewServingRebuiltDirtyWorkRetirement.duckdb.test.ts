import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-rebuilt-dirty-work-retirement')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const chunkStartedMinutesAgo = 5

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
  startedNow?: boolean
  startKey: string
}) => {
  const startedAtSql = input.startedNow
    ? 'current_timestamp'
    : `current_timestamp - INTERVAL '${chunkStartedMinutesAgo} minutes'`
  const completedAtSql = input.startedNow
    ? 'current_timestamp'
    : `current_timestamp - INTERVAL '${chunkStartedMinutesAgo - 1} minutes'`

  await getDatabase().run(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      chunk_id, project_id, projection_component, projection_identity, chunk_start_key, chunk_end_key, status,
      started_at, completed_at, snapshot_id, request_id, output_base_generation, last_error
    ) VALUES (
      '${input.chunkId}', '${input.projectId}', '${input.component}', '${input.component}:${input.projectId}',
      '${input.startKey}', '${input.endKey}', 'completed', ${startedAtSql},
      ${completedAtSql}, '${input.snapshotId}', 'rebuild:${input.projectId}', 0,
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
  updatedMinutesAgo: number
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_serving_dirty_work (
      dirty_work_id, project_id, scope_kind, scope_id, article_id, projection_component, projection_identity,
      dirty_kind, source_partition, first_source_high_water_mark, latest_source_high_water_mark, latest_delta_id,
      status, created_at, updated_at
    ) VALUES (
      '${input.dirtyWorkId}', '${input.projectId}', 'article', '${input.projectId}:${input.articleId}',
      '${input.articleId}', '${input.component}', '${input.component}:${input.projectId}', 'article.judgmentInput.updated',
      'article:all', 7, 7, 'delta-${input.dirtyWorkId}', '${input.status}',
      current_timestamp - INTERVAL '${input.updatedMinutesAgo} minutes',
      current_timestamp - INTERVAL '${input.updatedMinutesAgo} minutes'
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

test('unheld dirty work that a completed rebuild chunk re-read is completed, the rest keeps waiting for a patch', async () => {
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
    updatedMinutesAgo: 30,
  })
  await insertDirtyWork({
    articleId: 'article-c',
    component: 'payload',
    dirtyWorkId: 'dirty-parked-before-chunk',
    projectId: 'project-rebuilt',
    status: 'blocked_by_rebuild',
    updatedMinutesAgo: 20,
  })
  await insertDirtyWork({
    articleId: 'article-d',
    component: 'payload',
    dirtyWorkId: 'dirty-after-chunk',
    projectId: 'project-rebuilt',
    status: 'pending',
    updatedMinutesAgo: 1,
  })
  await insertDirtyWork({
    articleId: 'article-x',
    component: 'payload',
    dirtyWorkId: 'dirty-outside-range',
    projectId: 'project-rebuilt',
    status: 'pending',
    updatedMinutesAgo: 30,
  })
  await insertDirtyWork({
    articleId: 'article-e',
    component: 'payload',
    dirtyWorkId: 'dirty-running',
    projectId: 'project-rebuilt',
    status: 'running',
    updatedMinutesAgo: 10,
  })
  await insertDirtyWork({
    articleId: 'article-f',
    component: 'payload',
    dirtyWorkId: 'dirty-stale-claim',
    projectId: 'project-rebuilt',
    status: 'running',
    updatedMinutesAgo: 30,
  })
  await insertDirtyWork({
    articleId: 'article-b',
    component: 'display',
    dirtyWorkId: 'dirty-superseded-chunk',
    projectId: 'project-rebuilt',
    status: 'pending',
    updatedMinutesAgo: 30,
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
    updatedMinutesAgo: 30,
  })

  resetReviewServingRebuiltDirtyWorkRetirementForTests()

  const startedAtMs = Date.now()
  const retirement = await retireReviewServingDirtyWorkRebuiltByChunks({nowMs: startedAtMs})
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

  expect(retirement).toEqual({retiredCount: 3, scanned: true})
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
    {
      claimStatus: 'completed',
      dirtyWorkId: 'dirty-stale-claim',
      lifecycleReason: 'covered_by_rebuild',
      status: 'completed',
    },
    {claimStatus: 'pending', dirtyWorkId: 'dirty-superseded-chunk', lifecycleReason: null, status: 'pending'},
  ])
  expect(
    await getDatabase().queryJson<{count: number}>(`
      SELECT COUNT(*)::INTEGER AS count
      FROM app.review_serving_dirty_work_ack
      WHERE dirty_work_id IN ('dirty-before-chunk', 'dirty-parked-before-chunk', 'dirty-stale-claim')
    `),
  ).toEqual([{count: 3}])
  expect(await retireReviewServingDirtyWorkRebuiltByChunks({nowMs: startedAtMs + 10_000})).toEqual({
    retiredCount: 0,
    scanned: true,
  })
  expect(await retireReviewServingDirtyWorkRebuiltByChunks({nowMs: startedAtMs + 20_000})).toEqual({
    retiredCount: 0,
    scanned: false,
  })
})

test('a row the projector claimed and released after its chunk started is retired, a row changed after the chunk started is not', async () => {
  const [
    {resetReviewServingRebuiltDirtyWorkRetirementForTests, retireReviewServingDirtyWorkRebuiltByChunks},
    {claimReviewServingDirtyWork, releaseReviewServingDirtyWorkClaims, upsertReviewServingDirtyWork},
    {getReviewServingDirtyWorkScopeForChange},
  ] = await Promise.all([
    import('./reviewServingRebuiltDirtyWorkRetirement.ts'),
    import('./reviewServingDirtyWorkService.ts'),
    import('./reviewServingProjectorDomain.ts'),
  ])
  const projectId = 'project-churned'
  const pause = () => {
    return new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  const upsertDisplayChange = async (articleId: string, sourceHighWaterMark: number) => {
    const scope = getReviewServingDirtyWorkScopeForChange({
      changeKind: 'article.display.updated',
      dirtyRangeEnd: null,
      dirtyRangeStart: null,
      sourceHighWaterMark,
      sourcePartition: 'article:all',
      values: {articleId, changedDisplayFieldNames: ['title'], projectId, sourceHighWaterMark},
    })

    if (scope === null) {
      throw new Error('expected an article dirty-work scope')
    }

    return upsertReviewServingDirtyWork(
      {
        latestDeltaId: `delta-${articleId}`,
        projectionComponent: 'display',
        projectionIdentity: `display:${projectId}`,
        scope,
      },
      getDatabase(),
    )
  }

  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', '${projectId}', 'model-churned', TRUE, TRUE, FALSE, FALSE)
  `)
  await insertSnapshot({components: ['display'], projectId, snapshotId: 'snapshot-churned', status: 'active'})

  const changedBeforeChunk = await upsertDisplayChange('article-b', 11)

  await pause()
  await insertCompletedChunk({
    chunkId: 'chunk-churned-display',
    component: 'display',
    endKey: 'article-m',
    projectId,
    snapshotId: 'snapshot-churned',
    startedNow: true,
    startKey: 'article-a',
  })
  await pause()

  const changedAfterChunk = await upsertDisplayChange('article-c', 12)

  await pause()

  const claims = await claimReviewServingDirtyWork({limit: 10, projectionComponent: 'display'}, getDatabase())

  await releaseReviewServingDirtyWorkClaims(
    claims.map((claim) => {
      return claim.dirtyWorkId
    }),
    getDatabase(),
  )

  resetReviewServingRebuiltDirtyWorkRetirementForTests()

  const retirement = await retireReviewServingDirtyWorkRebuiltByChunks({projectId})
  const dirtyWork = await getDatabase().queryJson<{
    dirtyWorkId: string
    lifecycleReason: string | null
    releasedAfterChunk: boolean
    status: string
  }>(`
    SELECT
      dirty.dirty_work_id AS dirtyWorkId,
      dirty.status,
      dirty.lifecycle_reason AS lifecycleReason,
      dirty.updated_at > chunk.started_at AS releasedAfterChunk
    FROM app.review_serving_dirty_work dirty
    CROSS JOIN app.review_rebuild_chunk_manifest chunk
    WHERE dirty.project_id = '${projectId}'
      AND chunk.chunk_id = 'chunk-churned-display'
    ORDER BY dirty.article_id
  `)

  expect(claims).toHaveLength(2)
  expect(retirement).toEqual({retiredCount: 1, scanned: true})
  expect(dirtyWork).toEqual([
    {
      dirtyWorkId: changedBeforeChunk.dirtyWorkId,
      lifecycleReason: 'covered_by_rebuild',
      releasedAfterChunk: true,
      status: 'completed',
    },
    {
      dirtyWorkId: changedAfterChunk.dirtyWorkId,
      lifecycleReason: 'released',
      releasedAfterChunk: true,
      status: 'pending',
    },
  ])
})
