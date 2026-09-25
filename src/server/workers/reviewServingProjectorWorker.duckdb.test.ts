import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {ReviewServingDirtyWorkClaim} from '../reviewServing/reviewServingDirtyWorkService.ts'
import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-queue-candidate-patches')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const projectId = 'project-queue'
const reviewConfigHash = 'review-config-queue'
const queueIdentity = 'queue:project-queue'
const projectScopeIdentity = 'projectScope:project-queue'
const selectedImportSnapshotId = 'selected-import-queue'
const rebuildRangeStart = 'article-00'
const rebuildRangeEnd = 'article-20'

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

type QueueRow = {articleId: string; priorityBucket: number; queueKind: string; snapshotId: string}

const getComponentStateJson = (queueBaseGeneration: number) => {
  return JSON.stringify({
    optional: [],
    required: [
      {baseGeneration: '0', component: 'projectScope', patchWatermark: '0', projectionIdentity: projectScopeIdentity},
      {
        baseGeneration: String(queueBaseGeneration),
        component: 'queue',
        patchWatermark: '0',
        projectionIdentity: queueIdentity,
      },
    ],
  })
}

const insertSnapshot = async (input: {queueBaseGeneration?: number; snapshotId: string; status: string}) => {
  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id, snapshot_id, snapshot_status, review_config_hash, composed_identity_json, component_state_json,
      required_components_json, optional_components_json, source_watermarks_json, selected_import_snapshot_id
    ) VALUES (
      '${projectId}',
      '${input.snapshotId}',
      '${input.status}',
      '${reviewConfigHash}',
      '{}'::JSON,
      '${getComponentStateJson(input.queueBaseGeneration ?? 0)}'::JSON,
      '["projectScope", "queue"]'::JSON,
      '[]'::JSON,
      '{}'::JSON,
      '${selectedImportSnapshotId}'
    )
  `)
}

const insertQueueRebuildChunk = async (input: {
  chunkAdmissionState?: string
  chunkStatus: string
  outputBaseGeneration?: number
  requestStatus: string
  snapshotId: string
}) => {
  const requestId = `rebuild:${input.snapshotId}`

  await getDatabase().run(`
    INSERT INTO app.review_rebuild_request (
      request_id, project_id, reason, requested_components_json, priority, status, admission_state
    ) VALUES (
      '${requestId}', '${projectId}', 'searchDirtyWork', '["search"]'::JSON, 75, '${input.requestStatus}', 'admitted'
    )
  `)
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      chunk_id, request_id, project_id, snapshot_id, projection_component, projection_identity, chunk_start_key,
      chunk_end_key, output_base_generation, status, admission_state
    ) VALUES (
      'chunk:${input.snapshotId}',
      '${requestId}',
      '${projectId}',
      '${input.snapshotId}',
      'queue',
      '${queueIdentity}',
      '${rebuildRangeStart}',
      '${rebuildRangeEnd}',
      ${input.outputBaseGeneration ?? 0},
      '${input.chunkStatus}',
      '${input.chunkAdmissionState ?? 'admitted'}'
    )
  `)
}

const getQueueClaim = (articleId: string): ReviewServingDirtyWorkClaim => {
  return {
    articleId,
    dirtyKind: 'llmJudgment',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: `dirty-work:${articleId}`,
    firstSourceHighWaterMark: 5,
    latestDeltaId: null,
    latestSourceHighWaterMark: 5,
    projectId,
    projectionComponent: 'queue',
    projectionIdentity: queueIdentity,
    scopeId: `article:${articleId}`,
    scopeKind: 'article',
    sourcePartition: 'judgmentSqliteOutboxImport:job-queue',
    status: 'running',
  }
}

const getQueueRows = async (snapshotId?: string) => {
  return getDatabase().queryJson<QueueRow>(`
    SELECT snapshot_id AS snapshotId, article_id AS articleId, queue_kind AS queueKind, priority_bucket AS priorityBucket
    FROM mart.review_unassessed_queue_article_rank_serving_v4
    WHERE project_id = '${projectId}'
      ${snapshotId === undefined ? '' : `AND snapshot_id = '${snapshotId}'`}
    ORDER BY snapshot_id, article_id, queue_kind
  `)
}

const getSnapshotArticleIds = (rows: readonly QueueRow[], snapshotId: string) => {
  return [
    ...new Set(
      rows
        .filter((row) => {
          return row.snapshotId === snapshotId
        })
        .map((row) => {
          return row.articleId
        }),
    ),
  ]
}

const getRowsWithoutSnapshot = (rows: readonly QueueRow[]) => {
  return rows.map((row) => {
    return {articleId: row.articleId, priorityBucket: row.priorityBucket, queueKind: row.queueKind}
  })
}

beforeAll(async () => {
  const [{migrateDuckdb}, {getAppDatabaseService}, {resetDuckdbServiceForTests}, {resetServerRuntimeRoleForTests}] =
    await Promise.all([
      import('../../db/migrateDuckdb.ts'),
      import('../services/appDatabaseService.ts'),
      import('../utils/duckdbService.ts'),
      import('../utils/serverRuntimeRole.ts'),
    ])
  const {upsertReviewServingProjectionIdentityManifest} =
    await import('../reviewServing/reviewServingManifestRepository.ts')

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  database = getAppDatabaseService()

  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('connection-queue', 'sglang', 'SGLang', TRUE, 'none', 'https://worker.example.test')
  `)
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant, metadata_json)
    VALUES ('model-queue', 'connection-queue', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-122B-A10B', 'Qwen 122B', 'manual', TRUE, 'thinking', '{}'::JSON)
  `)
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', '${projectId}', 'model-queue', TRUE, TRUE, FALSE, FALSE)
  `)
  await getDatabase().run(`INSERT INTO app.prompt (id, original_text) VALUES ('prompt-queue', 'Is it relevant?')`)
  await getDatabase().run(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, archived)
    VALUES ('project-prompt-queue', '${projectId}', 'prompt-queue', 0, TRUE, FALSE)
  `)
  await getDatabase().run(`
    INSERT INTO mart.project_scope_article (project_id, article_id, in_curated_scope, in_route_scope, article_created_at)
    VALUES
      ('${projectId}', 'article-10', TRUE, FALSE, TIMESTAMPTZ '2026-09-20T10:00:00Z'),
      ('${projectId}', 'article-50', TRUE, FALSE, TIMESTAMPTZ '2026-09-20T11:00:00Z')
  `)
  await upsertReviewServingProjectionIdentityManifest(
    {
      baseGeneration: 0,
      definitionVersion: 'queue:test',
      inputWatermark: 0,
      patchWatermark: 0,
      projectId,
      projectionComponent: 'queue',
      projectionIdentity: queueIdentity,
      reviewConfigHash,
      status: 'active',
    },
    getDatabase(),
  )

  await insertSnapshot({snapshotId: 'snapshot-active', status: 'active'})
  await insertSnapshot({snapshotId: 'snapshot-rebuilding', status: 'candidate'})
  await insertQueueRebuildChunk({chunkStatus: 'pending', requestStatus: 'admitted', snapshotId: 'snapshot-rebuilding'})
  await insertSnapshot({snapshotId: 'snapshot-rebuilt', status: 'candidate'})
  await insertQueueRebuildChunk({chunkStatus: 'completed', requestStatus: 'admitted', snapshotId: 'snapshot-rebuilt'})
  await insertSnapshot({snapshotId: 'snapshot-reused', status: 'candidate'})
  await insertSnapshot({snapshotId: 'snapshot-failed-request', status: 'candidate'})
  await insertQueueRebuildChunk({
    chunkStatus: 'pending',
    requestStatus: 'failed',
    snapshotId: 'snapshot-failed-request',
  })
  await insertSnapshot({queueBaseGeneration: 1, snapshotId: 'snapshot-other-generation', status: 'candidate'})
  await insertQueueRebuildChunk({
    chunkStatus: 'pending',
    outputBaseGeneration: 0,
    requestStatus: 'admitted',
    snapshotId: 'snapshot-other-generation',
  })
  await insertSnapshot({snapshotId: 'snapshot-unadmitted-chunk', status: 'candidate'})
  await insertQueueRebuildChunk({
    chunkAdmissionState: 'blocked_over_budget',
    chunkStatus: 'pending',
    requestStatus: 'admitted',
    snapshotId: 'snapshot-unadmitted-chunk',
  })
  await getDatabase().run(`
    INSERT INTO mart.review_unassessed_queue_article_rank_serving_v4 (
      project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, article_id, activity_sort_at
    ) VALUES (
      '${projectId}', '${reviewConfigHash}', 'snapshot-rebuilding', 'unassessed', 1, 'article-10',
      TIMESTAMPTZ '2026-09-01T00:00:00Z'
    )
  `)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('queue patches skip candidate rows that a pending rebuild chunk will rebuild and still reach every other snapshot', async () => {
  const {getDefaultReviewServingProjectorRunners} = await import('./reviewServingProjectorWorker.ts')
  const {projectReviewServingQueueRebuildRows} = await import('../reviewServing/reviewServingQueueProjector.ts')
  const runner = getDefaultReviewServingProjectorRunners(getDatabase() as never).queue

  await runner?.({
    claims: [getQueueClaim('article-10'), getQueueClaim('article-50')],
    component: 'queue',
    wakeId: 'wake-queue',
  })

  const patchedRows = await getQueueRows()

  expect(getSnapshotArticleIds(patchedRows, 'snapshot-active')).toEqual(['article-10', 'article-50'])
  expect(getSnapshotArticleIds(patchedRows, 'snapshot-rebuilt')).toEqual(['article-10', 'article-50'])
  expect(getSnapshotArticleIds(patchedRows, 'snapshot-reused')).toEqual(['article-10', 'article-50'])
  expect(getSnapshotArticleIds(patchedRows, 'snapshot-failed-request')).toEqual(['article-10', 'article-50'])
  expect(getSnapshotArticleIds(patchedRows, 'snapshot-other-generation')).toEqual(['article-10', 'article-50'])
  expect(getSnapshotArticleIds(patchedRows, 'snapshot-unadmitted-chunk')).toEqual(['article-10', 'article-50'])
  expect(getSnapshotArticleIds(patchedRows, 'snapshot-rebuilding')).toEqual(['article-50'])

  await projectReviewServingQueueRebuildRows(
    {
      baseGeneration: 0,
      chunkEndArticleId: rebuildRangeEnd,
      chunkStartArticleId: rebuildRangeStart,
      projectId,
      projectScopeIdentity,
      reviewConfigHash,
      selectedImportSnapshotId,
      snapshotId: 'snapshot-rebuilding',
    },
    getDatabase(),
  )

  expect(getRowsWithoutSnapshot(await getQueueRows('snapshot-rebuilding'))).toEqual(
    getRowsWithoutSnapshot(await getQueueRows('snapshot-active')),
  )
})
