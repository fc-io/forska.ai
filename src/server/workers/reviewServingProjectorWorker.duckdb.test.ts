import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {ReviewServingProjectionComponent} from '../reviewServing/reviewServingContracts.ts'
import type {ReviewServingDirtyWorkClaim} from '../reviewServing/reviewServingDirtyWorkService.ts'
import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import type {ReviewServingProjectorWorkerDependencies} from './reviewServingProjectorWorker.ts'

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

const cascadeProjectId = 'project-cascade'
const cascadeComponents = ['display', 'humanStatus'] as const

const getCascadeIdentity = (component: ReviewServingProjectionComponent) => {
  return `${component}:${cascadeProjectId}`
}

const insertCascadeSnapshot = async (input: {snapshotId: string; status: string}) => {
  const componentState = {
    optional: [],
    required: cascadeComponents.map((component) => {
      return {
        baseGeneration: '0',
        component,
        patchWatermark: '0',
        projectionIdentity: getCascadeIdentity(component),
        requirement: 'required',
      }
    }),
  }

  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id, snapshot_id, snapshot_status, review_config_hash, composed_identity_json, component_state_json,
      required_components_json, optional_components_json, source_watermarks_json, selected_import_snapshot_id
    ) VALUES (
      '${cascadeProjectId}',
      '${input.snapshotId}',
      '${input.status}',
      '${reviewConfigHash}',
      '{}'::JSON,
      '${JSON.stringify(componentState)}'::JSON,
      '${JSON.stringify(cascadeComponents)}'::JSON,
      '[]'::JSON,
      '{}'::JSON,
      'selected-import-cascade'
    )
  `)
}

const insertCascadeRequest = async (input: {priority: number; reason: string; requestId: string}) => {
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_request (
      request_id, project_id, reason, requested_components_json, priority, status, admission_state
    ) VALUES (
      '${input.requestId}', '${cascadeProjectId}', '${input.reason}', '["display"]'::JSON, ${input.priority},
      'admitted', 'admitted'
    )
  `)
}

const insertCascadeChunk = async (input: {
  component: ReviewServingProjectionComponent
  requestId: string
  snapshotId: string
  status: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      chunk_id, request_id, project_id, snapshot_id, projection_component, projection_identity, chunk_start_key,
      chunk_end_key, output_base_generation, status, admission_state
    ) VALUES (
      'chunk:${input.requestId}:${input.snapshotId}:${input.component}',
      '${input.requestId}',
      '${cascadeProjectId}',
      '${input.snapshotId}',
      '${input.component}',
      '${getCascadeIdentity(input.component)}',
      'article-00',
      'article-99',
      0,
      '${input.status}',
      'admitted'
    )
  `)
}

const getCascadeRequestStates = async () => {
  return getDatabase().queryJson<{lastError: string | null; requestId: string; status: string}>(`
    SELECT request_id AS requestId, status, last_error AS lastError
    FROM app.review_rebuild_request
    WHERE project_id = '${cascadeProjectId}'
    ORDER BY request_id
  `)
}

const getCascadeSnapshotStates = async () => {
  return getDatabase().queryJson<{lastError: string | null; snapshotId: string; status: string}>(`
    SELECT snapshot_id AS snapshotId, snapshot_status AS status, last_error AS lastError
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = '${cascadeProjectId}'
    ORDER BY snapshot_id
  `)
}

const getFinalizationCycleDependencies = (): ReviewServingProjectorWorkerDependencies => {
  const unexpectedChunkWork = async (): Promise<never> => {
    throw new Error('finalization cycle must not claim rebuild chunks')
  }

  return {
    cleanupDirtyWorkRetention: async () => {
      return {
        compactedAcknowledgements: [],
        compactedLaneCount: 0,
        deletedAcknowledgementCount: 0,
        deletedDirtyWorkCount: 0,
      }
    },
    cleanupStaleCandidateSnapshots: async () => {
      return {failedSnapshots: [], projectIds: [], remainingStaleCandidateCount: 0, skippedSnapshotCount: 0}
    },
    getCleanupTargets: async () => {
      return []
    },
    getDatabase: () => {
      return getDatabase() as never
    },
    rebuildChunkService: {
      claimChunk: unexpectedChunkWork,
      failChunk: unexpectedChunkWork,
      getNextChunk: async () => {
        return null
      },
      heartbeatChunk: unexpectedChunkWork,
      isChunkComplete: unexpectedChunkWork,
      runClaimedChunk: unexpectedChunkWork,
    },
    sleep: async () => {},
    wakeProjectors: async () => {
      return {blockedRebuilds: [], failures: [], promotions: [], releasedClaimIds: [], runs: [], status: 'idle'}
    },
  }
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

test('a finished rebuild leaves a candidate another rebuild is still building to that rebuild when its promotion fails', async () => {
  const {runReviewServingProjectorWorkerOnce} = await import('./reviewServingProjectorWorker.ts')
  const {upsertReviewServingProjectionIdentityManifest} =
    await import('../reviewServing/reviewServingManifestRepository.ts')

  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${cascadeProjectId}', '${cascadeProjectId}', 'model-queue', TRUE, TRUE, FALSE, FALSE)
  `)
  await getDatabase().run(`
    INSERT INTO app.review_selected_import_snapshot (selected_import_snapshot_id, project_id, project_scope_identity, status)
    VALUES ('selected-import-cascade', '${cascadeProjectId}', 'projectScope:${cascadeProjectId}', 'completed')
  `)
  await cascadeComponents.reduce<Promise<void>>(async (previous, component) => {
    await previous
    await upsertReviewServingProjectionIdentityManifest(
      {
        baseGeneration: 0,
        definitionVersion: `${component}:test`,
        inputWatermark: 0,
        patchWatermark: 0,
        projectId: cascadeProjectId,
        projectionComponent: component,
        projectionIdentity: getCascadeIdentity(component),
        reviewConfigHash,
        status: 'candidate',
      },
      getDatabase(),
    )
  }, Promise.resolve())
  await insertCascadeSnapshot({snapshotId: 'snapshot-cascade-active', status: 'active'})
  await insertCascadeSnapshot({snapshotId: 'snapshot-cascade-building', status: 'candidate'})
  await insertCascadeSnapshot({snapshotId: 'snapshot-cascade-orphan', status: 'candidate'})
  await insertCascadeRequest({priority: 100, reason: 'humanStatusBootstrapTest', requestId: 'rebuild:cascade-owner'})
  await insertCascadeChunk({
    component: 'humanStatus',
    requestId: 'rebuild:cascade-owner',
    snapshotId: 'snapshot-cascade-building',
    status: 'pending',
  })
  await insertCascadeRequest({priority: 10_000, reason: 'displayDirtyWorkTest', requestId: 'rebuild:cascade-shared'})
  await insertCascadeChunk({
    component: 'display',
    requestId: 'rebuild:cascade-shared',
    snapshotId: 'snapshot-cascade-building',
    status: 'completed',
  })
  await insertCascadeRequest({priority: 50, reason: 'displayOrphanTest', requestId: 'rebuild:cascade-orphan'})
  await insertCascadeChunk({
    component: 'display',
    requestId: 'rebuild:cascade-orphan',
    snapshotId: 'snapshot-cascade-orphan',
    status: 'completed',
  })

  const runFinalizationCycle = () => {
    return runReviewServingProjectorWorkerOnce(
      {rebuildProjectId: cascadeProjectId, workerId: 'worker-cascade'},
      getFinalizationCycleDependencies(),
    )
  }

  await runFinalizationCycle()
  await runFinalizationCycle()

  const missingHumanStatus = 'required component humanStatus is missing from snapshot state'

  expect(await getCascadeRequestStates()).toEqual([
    {lastError: missingHumanStatus, requestId: 'rebuild:cascade-orphan', status: 'failed'},
    {lastError: null, requestId: 'rebuild:cascade-owner', status: 'admitted'},
    {lastError: null, requestId: 'rebuild:cascade-shared', status: 'completed'},
  ])
  expect(await getCascadeSnapshotStates()).toEqual([
    {lastError: null, snapshotId: 'snapshot-cascade-active', status: 'active'},
    {lastError: null, snapshotId: 'snapshot-cascade-building', status: 'candidate'},
    {lastError: missingHumanStatus, snapshotId: 'snapshot-cascade-orphan', status: 'failed'},
  ])
})
