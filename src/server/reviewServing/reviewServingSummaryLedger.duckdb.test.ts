import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Effect} from 'effect'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {reviewServingListModes} from './reviewServingContracts.ts'
import type {ReviewServingProjectorServiceDependencies} from './reviewServingProjectorService.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-summary-ledger')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const jobPartition = 'judgmentSqliteOutboxImport:job-summary'
const seedSourceWatermarks = {judgmentSqliteOutboxImport: 10}
const initialArticleIds = ['article-a', 'article-b', 'article-x'] as const
const firstBucket = {end: 'article-b', start: 'article-a'}
const secondBucket = {end: 'article-x', start: 'article-x'}
const articleYears: Record<string, number> = {
  'article-a': 2020,
  'article-b': 2021,
  'article-n': 2021,
  'article-x': 2022,
}

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

type SnapshotInput = {projectId: string; reviewConfigHash: string; snapshotId: string}
type DirtyWorkRow = {articleId: string; lifecycleReason: string | null; status: string}
type ChunkInput = {end: string; start: string; status: 'completed' | 'pending' | 'running'}

const getIdentity = (component: string, projectId: string) => {
  return `${component}:${projectId}`
}

const getPromptId = (projectId: string) => {
  return `prompt-${projectId}`
}

const insertJudgment = async (input: {answer: string; articleId: string; projectId: string}) => {
  await getDatabase().run(`
    UPDATE app.judgment
    SET
      deleted_at = current_timestamp,
      delete_generation = (SELECT MAX(existing.delete_generation) + 1 FROM app.judgment existing)
    WHERE article_id = '${input.articleId}' AND prompt_id = '${getPromptId(input.projectId)}' AND deleted_at IS NULL
  `)
  await getDatabase().run(`
    INSERT INTO app.judgment (
      id, article_id, prompt_id, project_id, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images,
      delete_generation, is_answered, answered_original, created_at, updated_at
    ) VALUES (
      'judgment-${input.projectId}-${input.articleId}-${input.answer}-' || CAST(random() AS VARCHAR),
      '${input.articleId}', '${getPromptId(input.projectId)}', '${input.projectId}',
      'model-summary', TRUE, TRUE, FALSE, FALSE, 0, TRUE, '${input.answer}', current_timestamp, current_timestamp
    )
  `)
}

const insertScopeArticle = async (input: {articleId: string; projectId: string}) => {
  await getDatabase().run(`
    INSERT INTO mart.project_scope_article (project_id, article_id, in_curated_scope, in_route_scope, article_created_at)
    VALUES ('${input.projectId}', '${input.articleId}', TRUE, FALSE, TIMESTAMPTZ '2026-09-20T10:00:00Z')
  `)
  await getDatabase().run(`
    INSERT INTO mart.review_selected_article_import_current_v4 (
      project_id, project_scope_identity, selected_import_snapshot_id, article_id, import_route_id, source_record_key
    ) VALUES (
      '${input.projectId}', '${getIdentity('projectScope', input.projectId)}', 'selected-import-${input.projectId}',
      '${input.articleId}', 'route-${input.projectId}', 'record-${input.articleId}'
    )
  `)
  await getDatabase().run(`
    INSERT INTO app.review_import_article_hot_field (
      import_route_id, article_id, source_record_key, publication_year, duplicate_flag, conflict_flag
    ) VALUES (
      'route-${input.projectId}', '${input.articleId}', 'record-${input.articleId}', ${articleYears[input.articleId]},
      FALSE, FALSE
    )
  `)
}

const insertProject = async (projectId: string) => {
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', '${projectId}', 'model-summary', TRUE, TRUE, FALSE, FALSE)
  `)
  await getDatabase().run(
    `INSERT INTO app.prompt (id, original_text) VALUES ('${getPromptId(projectId)}', 'Relevant?')`,
  )
  await getDatabase().run(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, archived)
    VALUES ('project-prompt-${projectId}', '${projectId}', '${getPromptId(projectId)}', 0, TRUE, FALSE)
  `)
  await getDatabase().run(`
    INSERT INTO app.review_selected_import_snapshot (selected_import_snapshot_id, project_id, project_scope_identity, status)
    VALUES ('selected-import-${projectId}', '${projectId}', '${getIdentity('projectScope', projectId)}', 'completed')
  `)
  await initialArticleIds.reduce<Promise<void>>(async (previous, articleId) => {
    await previous
    await insertScopeArticle({articleId, projectId})
  }, Promise.resolve())
  await insertJudgment({answer: 'yes', articleId: 'article-a', projectId})
  await insertJudgment({answer: 'no', articleId: 'article-b', projectId})
}

const getCurrentReviewConfigHash = async (projectId: string) => {
  const {getCurrentReviewServingReviewConfigHash} = await import('./reviewServingReviewConfig.ts')
  const reviewConfigHash = await getCurrentReviewServingReviewConfigHash(projectId, getDatabase())

  if (reviewConfigHash === null) {
    throw new Error(`missing review config hash for ${projectId}`)
  }

  return reviewConfigHash
}

const upsertProjectionManifests = async (input: {projectId: string; reviewConfigHash: string}) => {
  const {upsertReviewServingProjectionIdentityManifest} = await import('./reviewServingManifestRepository.ts')

  await [
    {component: 'projectScope', status: 'active'},
    {component: 'display', status: 'active'},
    {component: 'payload', status: 'candidate'},
    {component: 'summary', status: 'candidate'},
  ].reduce<Promise<void>>(async (previous, manifest) => {
    await previous
    await upsertReviewServingProjectionIdentityManifest(
      {
        baseGeneration: 0,
        definitionVersion: `${manifest.component}:test`,
        inputWatermark: 10,
        inputWatermarks: seedSourceWatermarks,
        patchWatermark: 0,
        projectId: input.projectId,
        projectionComponent: manifest.component as 'display' | 'payload' | 'projectScope' | 'summary',
        projectionIdentity: getIdentity(manifest.component, input.projectId),
        reviewConfigHash: input.reviewConfigHash,
        status: manifest.status as 'active' | 'candidate',
      },
      getDatabase(),
    )
  }, Promise.resolve())
}

const getComponentState = (component: string, projectId: string, requirement: string) => {
  return {
    baseGeneration: '0',
    component,
    patchWatermark: '0',
    projectionIdentity: getIdentity(component, projectId),
    requirement,
  }
}

const insertSnapshot = async (input: SnapshotInput & {hasSummary: boolean; status: 'active' | 'candidate'}) => {
  const optionalComponents = input.hasSummary ? ['payload', 'summary'] : ['payload']
  const componentState = {
    optional: optionalComponents.map((component) => {
      return getComponentState(component, input.projectId, 'optional')
    }),
    required: ['projectScope', 'display'].map((component) => {
      return getComponentState(component, input.projectId, 'required')
    }),
  }

  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id, snapshot_id, snapshot_status, review_config_hash, composed_identity_json, component_state_json,
      required_components_json, optional_components_json, source_watermarks_json, selected_import_snapshot_id
    ) VALUES (
      '${input.projectId}',
      '${input.snapshotId}',
      '${input.status}',
      '${input.reviewConfigHash}',
      '{}'::JSON,
      '${JSON.stringify(componentState)}'::JSON,
      '["projectScope", "display"]'::JSON,
      '${JSON.stringify(optionalComponents)}'::JSON,
      '${JSON.stringify(seedSourceWatermarks)}'::JSON,
      'selected-import-${input.projectId}'
    )
  `)
}

const writeArticleServingState = async (input: SnapshotInput & {articleId: string; assessed: boolean}) => {
  await getDatabase().run(`
    DELETE FROM mart.review_article_serving_list_mode_state_v4
    WHERE project_id = '${input.projectId}' AND snapshot_id = '${input.snapshotId}' AND article_id = '${input.articleId}';
    DELETE FROM mart.review_unassessed_queue_serving_v4
    WHERE project_id = '${input.projectId}' AND snapshot_id = '${input.snapshotId}' AND article_id = '${input.articleId}';
    DELETE FROM mart.review_unassessed_queue_article_rank_serving_v4
    WHERE project_id = '${input.projectId}' AND snapshot_id = '${input.snapshotId}' AND article_id = '${input.articleId}';
    INSERT INTO mart.review_article_serving_list_mode_state_v4 (
      project_id, review_config_hash, snapshot_id, article_id, has_llm_list_mode, has_human_list_mode,
      has_both_list_mode, has_unassessed_list_mode, llm_status, llm_has_judgment
    ) VALUES (
      '${input.projectId}', '${input.reviewConfigHash}', '${input.snapshotId}', '${input.articleId}',
      ${input.assessed}, TRUE, TRUE, ${!input.assessed}, ${input.assessed ? "'answered'" : "'unassessed'"}, ${input.assessed}
    )
  `)

  if (!input.assessed) {
    await getDatabase().run(`
      INSERT INTO mart.review_unassessed_queue_serving_v4 (
        project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, activity_sort_at, article_id,
        prompt_ids, queue_updated_at
      ) VALUES (
        '${input.projectId}', '${input.reviewConfigHash}', '${input.snapshotId}', 'unassessed', 0,
        TIMESTAMPTZ '2026-09-20T10:00:00Z', '${input.articleId}', ['${getPromptId(input.projectId)}'], current_timestamp
      );
      INSERT INTO mart.review_unassessed_queue_article_rank_serving_v4 (
        project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, article_id, activity_sort_at,
        queue_updated_at
      ) VALUES (
        '${input.projectId}', '${input.reviewConfigHash}', '${input.snapshotId}', 'unassessed', 0, '${input.articleId}',
        TIMESTAMPTZ '2026-09-20T10:00:00Z', current_timestamp
      )
    `)
  }
}

const insertServingArticle = async (input: SnapshotInput & {articleId: string; assessed: boolean}) => {
  await getDatabase().run(`
    INSERT INTO mart.review_article_serving_base_v4 (
      project_id, review_config_hash, snapshot_id, base_generation, patch_watermark, article_id, article_created_at,
      sort_key, activity_sort_at
    ) VALUES (
      '${input.projectId}', '${input.reviewConfigHash}', '${input.snapshotId}', 0, 0, '${input.articleId}',
      TIMESTAMPTZ '2026-09-20T10:00:00Z', TIMESTAMPTZ '2026-09-20T10:00:00Z', TIMESTAMPTZ '2026-09-20T10:00:00Z'
    )
  `)
  await writeArticleServingState(input)
}

const projectPayloadRows = async (input: SnapshotInput) => {
  const {projectReviewServingJudgmentPayloadRows} = await import('./reviewServingJudgmentPayloadProjector.ts')

  await projectReviewServingJudgmentPayloadRows(
    {
      listModeKeys: reviewServingListModes,
      modelId: 'model-summary',
      projectId: input.projectId,
      reviewConfigHash: input.reviewConfigHash,
      snapshotId: input.snapshotId,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    },
    getDatabase() as never,
  )
}

const insertUpstreamRows = async (input: SnapshotInput) => {
  await insertServingArticle({...input, articleId: 'article-a', assessed: true})
  await insertServingArticle({...input, articleId: 'article-b', assessed: true})
  await insertServingArticle({...input, articleId: 'article-x', assessed: false})
  await projectPayloadRows(input)
}

const getSummaryProjectorInput = (input: SnapshotInput) => {
  return {
    acknowledgeClaims: false,
    baseGeneration: 0,
    claims: [],
    listModeKeys: reviewServingListModes,
    projectId: input.projectId,
    projectScopeIdentity: getIdentity('projectScope', input.projectId),
    projectionIdentity: getIdentity('summary', input.projectId),
    reviewConfigHash: input.reviewConfigHash,
    selectedImportSnapshotId: `selected-import-${input.projectId}`,
    snapshotId: input.snapshotId,
  }
}

const getRequestId = (projectId: string) => {
  return `rebuild-${projectId}`
}

const getChunkId = (projectId: string, index: number) => {
  return `chunk-${projectId}-${index}`
}

const insertSummaryRebuild = async (input: SnapshotInput & {chunks: readonly ChunkInput[]}) => {
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_request (
      request_id, project_id, reason, requested_components_json, source_watermarks_json, identity_json, priority, status,
      admission_state
    ) VALUES (
      '${getRequestId(input.projectId)}', '${input.projectId}', 'summaryDirtyWork', '["summary"]'::JSON,
      '${JSON.stringify({dirtySourceWatermarks: seedSourceWatermarks})}'::JSON,
      '${JSON.stringify({componentSet: ['projectScope', 'display', 'payload', 'summary'], reviewConfigHash: input.reviewConfigHash})}'::JSON,
      50, 'admitted', 'admitted'
    )
  `)
  await input.chunks.reduce<Promise<void>>(async (previous, chunk, index) => {
    await previous
    await getDatabase().run(`
      INSERT INTO app.review_rebuild_chunk_manifest (
        chunk_id, request_id, project_id, snapshot_id, projection_component, projection_identity, chunk_start_key,
        chunk_end_key, output_base_generation, status, admission_state, lease_owner, lease_expires_at
      ) VALUES (
        '${getChunkId(input.projectId, index)}', '${getRequestId(input.projectId)}', '${input.projectId}',
        '${input.snapshotId}', 'summary', '${getIdentity('summary', input.projectId)}', '${chunk.start}', '${chunk.end}', 0,
        'pending', 'admitted', NULL, NULL
      )
    `)

    if (chunk.status === 'completed') {
      await runSummaryChunk({...input, index})
    }

    if (chunk.status === 'running') {
      await getDatabase().run(`
        UPDATE app.review_rebuild_chunk_manifest
        SET status = 'running', lease_owner = 'worker-test', lease_expires_at = current_timestamp + INTERVAL '10 minutes'
        WHERE chunk_id = '${getChunkId(input.projectId, index)}'
      `)
    }
  }, Promise.resolve())
}

const runSummaryChunk = async (input: SnapshotInput & {index: number}) => {
  const {projectReviewServingSummaries} = await import('./reviewServingSummaryProjector.ts')
  const [chunk] = await getDatabase().queryJson<{chunkEndKey: string; chunkStartKey: string}>(`
    SELECT chunk_start_key AS chunkStartKey, chunk_end_key AS chunkEndKey
    FROM app.review_rebuild_chunk_manifest
    WHERE chunk_id = '${getChunkId(input.projectId, input.index)}'
  `)

  await projectReviewServingSummaries(
    {
      ...getSummaryProjectorInput(input),
      chunkEndArticleId: chunk?.chunkEndKey,
      chunkId: getChunkId(input.projectId, input.index),
      chunkStartArticleId: chunk?.chunkStartKey,
      requestId: getRequestId(input.projectId),
    },
    getDatabase() as never,
  )
  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, completed_at = current_timestamp
    WHERE chunk_id = '${getChunkId(input.projectId, input.index)}'
  `)
}

const finalizeSummaryRebuild = async (input: SnapshotInput) => {
  const {reduceReviewServingSummaryRebuildPartialsForRequestSnapshots} =
    await import('./reviewServingSummaryProjector.ts')

  return reduceReviewServingSummaryRebuildPartialsForRequestSnapshots(
    {
      onFinalizationPhaseComplete: () => {
        return undefined
      },
      requestId: getRequestId(input.projectId),
      snapshots: [{...input, hasSummaryRebuildChunks: true}],
    },
    getDatabase() as never,
  )
}

const setupPublishedLedger = async (projectId: string) => {
  await insertProject(projectId)
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)
  const snapshot = {projectId, reviewConfigHash, snapshotId: `snapshot-${projectId}`}

  await upsertProjectionManifests({projectId, reviewConfigHash})
  await insertSnapshot({...snapshot, hasSummary: true, status: 'active'})
  await insertUpstreamRows(snapshot)
  await insertSummaryRebuild({
    ...snapshot,
    chunks: [
      {...firstBucket, status: 'completed'},
      {...secondBucket, status: 'completed'},
    ],
  })

  const finalization = await finalizeSummaryRebuild(snapshot)

  expect(
    finalization.snapshots.map((row) => {
      return row.ledgerPublished
    }),
  ).toEqual([true])
  await getDatabase().run(`
    UPDATE app.review_rebuild_request SET status = 'completed' WHERE request_id = '${getRequestId(projectId)}'
  `)

  return snapshot
}

const upsertDirtyWork = async (input: {
  articleId: string
  component: 'posting' | 'summary'
  projectId: string
  sourceHighWaterMark: number
}) => {
  const [{getReviewServingDirtyWorkScopeForChange}, {upsertReviewServingDirtyWork}] = await Promise.all([
    import('./reviewServingProjectorDomain.ts'),
    import('./reviewServingDirtyWorkService.ts'),
  ])
  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind: 'judgment.llm.created',
    sourceHighWaterMark: input.sourceHighWaterMark,
    sourcePartition: jobPartition,
    values: {
      articleId: input.articleId,
      contentFlags: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
      judgmentId: `judgment-${input.articleId}-${input.sourceHighWaterMark}`,
      modelId: 'model-summary',
      projectId: input.projectId,
      promptId: getPromptId(input.projectId),
      sourceHighWaterMark: input.sourceHighWaterMark,
    },
  })

  if (scope === null) {
    throw new Error('expected an article dirty work scope')
  }

  await upsertReviewServingDirtyWork(
    {projectionComponent: input.component, projectionIdentity: getIdentity(input.component, input.projectId), scope},
    getDatabase(),
  )
}

const parkSummaryDirtyWork = async (input: {articleId: string; projectId: string}) => {
  const predicate = `project_id = '${input.projectId}' AND article_id = '${input.articleId}' AND projection_component = 'summary'`

  await getDatabase().run(`
    UPDATE app.review_serving_dirty_work
    SET status = 'blocked_by_rebuild', lifecycle_reason = 'blocked_by_rebuild'
    WHERE ${predicate}
  `)
  await getDatabase().run(`
    UPDATE app.review_serving_dirty_work_claim_state
    SET status = 'blocked_by_rebuild', lifecycle_reason = 'blocked_by_rebuild'
    WHERE dirty_work_id IN (SELECT dirty_work_id FROM app.review_serving_dirty_work WHERE ${predicate})
  `)
}

const wakeSummary = async (dependencies: Partial<ReviewServingProjectorServiceDependencies> = {}) => {
  const [{wakeReviewServingProjectorService}, {getDefaultReviewServingProjectorRunners}] = await Promise.all([
    import('./reviewServingProjectorService.ts'),
    import('../workers/reviewServingProjectorWorker.ts'),
  ])

  return wakeReviewServingProjectorService(
    {batchSize: 64, componentOrder: ['summary'], maxRowsPerWake: 64, maxWakeMs: 600_000, wakeId: 'wake-summary'},
    {
      database: getDatabase(),
      runners: getDefaultReviewServingProjectorRunners(getDatabase() as never),
      ...dependencies,
    },
  )
}

const getDirtyWork = async (projectId: string) => {
  return getDatabase().queryJson<DirtyWorkRow>(`
    SELECT article_id AS articleId, status, lifecycle_reason AS lifecycleReason
    FROM app.review_serving_dirty_work
    WHERE project_id = '${projectId}' AND projection_component = 'summary'
    ORDER BY article_id
  `)
}

const getSummaryRows = async (input: {projectId: string; snapshotId: string}) => {
  const predicate = `project_id = '${input.projectId}' AND snapshot_id = '${input.snapshotId}'`
  const counts = await getDatabase().queryJson(`
    SELECT list_mode_key, count_kind, summary_definition_version, filter_key, summary_identity,
      CAST(count_value AS INTEGER) AS count_value, availability, stale_reason
    FROM mart.review_article_count_serving_v4
    WHERE ${predicate}
    ORDER BY list_mode_key, count_kind, filter_key
  `)
  const facets = await getDatabase().queryJson(`
    SELECT summary_identity, facet_kind, facet_key, facet_value, summary_definition_version, prompt_id, answer_value,
      CAST(count_value AS INTEGER) AS count_value, availability
    FROM mart.review_filter_facet_serving_v4
    WHERE ${predicate}
    ORDER BY summary_identity, facet_kind, facet_key, facet_value
  `)

  return {counts, facets}
}

const getLedgerRows = async (input: SnapshotInput) => {
  return getDatabase().queryJson(`
    SELECT bucket_id, summary_kind, summary_identity, list_mode_key, count_kind, filter_key, facet_kind, facet_key,
      facet_value, availability, CAST(count_value AS INTEGER) AS count_value
    FROM mart.review_article_summary_bucket_partial_v4
    WHERE project_id = '${input.projectId}' AND snapshot_id = '${input.snapshotId}'
    ORDER BY ALL
  `)
}

const upstreamTables = [
  'mart.review_article_serving_base_v4',
  'mart.review_article_serving_list_mode_state_v4',
  'mart.review_article_judgment_detail_serving_v4',
  'mart.review_unassessed_queue_serving_v4',
  'mart.review_unassessed_queue_article_rank_serving_v4',
] as const

const getFullRecomputeRows = async (input: SnapshotInput) => {
  const {projectReviewServingSummaries} = await import('./reviewServingSummaryProjector.ts')
  const referenceSnapshotId = `${input.snapshotId}-full`

  await upstreamTables.reduce<Promise<void>>(async (previous, table) => {
    await previous
    await getDatabase().run(`
      DELETE FROM ${table} WHERE project_id = '${input.projectId}' AND snapshot_id = '${referenceSnapshotId}';
      INSERT INTO ${table} BY NAME
      SELECT * REPLACE ('${referenceSnapshotId}' AS snapshot_id)
      FROM ${table}
      WHERE project_id = '${input.projectId}' AND snapshot_id = '${input.snapshotId}'
    `)
  }, Promise.resolve())
  await projectReviewServingSummaries(
    getSummaryProjectorInput({...input, snapshotId: referenceSnapshotId}),
    getDatabase() as never,
  )

  return getSummaryRows({projectId: input.projectId, snapshotId: referenceSnapshotId})
}

const getOptionCount = async (input: SnapshotInput & {optionValueKey: string}) => {
  const [row] = await getDatabase().queryJson<{countValue: number}>(`
    SELECT CAST(count_value AS INTEGER) AS countValue
    FROM mart.review_filter_option_serving_v4
    WHERE project_id = '${input.projectId}' AND snapshot_id = '${input.snapshotId}' AND filter_kind = 'review'
      AND option_value_key = '${input.optionValueKey}'
  `)

  return row?.countValue ?? null
}

const getRebuildRequestIds = async (projectId: string) => {
  const rows = await getDatabase().queryJson<{requestId: string}>(`
    SELECT request_id AS requestId FROM app.review_rebuild_request WHERE project_id = '${projectId}' ORDER BY request_id
  `)

  return rows.map((row) => {
    return row.requestId
  })
}

const assessArticleX = async (snapshot: SnapshotInput) => {
  await insertJudgment({answer: 'yes', articleId: 'article-x', projectId: snapshot.projectId})
  await writeArticleServingState({...snapshot, articleId: 'article-x', assessed: true})
  await projectPayloadRows(snapshot)
  await getDatabase().run(`
    UPDATE app.review_import_article_hot_field SET publication_year = 2020
    WHERE import_route_id = 'route-${snapshot.projectId}' AND article_id = 'article-x'
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

  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('connection-summary', 'sglang', 'SGLang', TRUE, 'none', 'https://worker.example.test')
  `)
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant, metadata_json)
    VALUES ('model-summary', 'connection-summary', 'Qwen', 'Qwen', 'Qwen', 'manual', TRUE, 'thinking', '{}'::JSON)
  `)
  await getDatabase().run(`
    INSERT INTO app.article (id, article_title)
    VALUES ('article-a', 'article-a'), ('article-b', 'article-b'), ('article-n', 'article-n'), ('article-x', 'article-x')
  `)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('an article moving between summary keys and an article added between buckets patch to a full recompute', async () => {
  const projectId = 'project-move'
  const snapshot = await setupPublishedLedger(projectId)

  expect(await getSummaryRows(snapshot)).toEqual(await getFullRecomputeRows(snapshot))

  await assessArticleX(snapshot)
  await insertScopeArticle({articleId: 'article-n', projectId})
  await insertServingArticle({...snapshot, articleId: 'article-n', assessed: false})
  await upsertDirtyWork({articleId: 'article-x', component: 'summary', projectId, sourceHighWaterMark: 20})
  await upsertDirtyWork({articleId: 'article-n', component: 'summary', projectId, sourceHighWaterMark: 21})

  const result = await wakeSummary()
  const after = await getSummaryRows(snapshot)

  expect(result.failures).toEqual([])
  expect(result.releasedClaimIds).toEqual([])
  expect(await getRebuildRequestIds(projectId)).toEqual([getRequestId(projectId)])
  expect(await getDirtyWork(projectId)).toEqual([
    {articleId: 'article-n', lifecycleReason: 'projected', status: 'completed'},
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])
  expect(after).toEqual(await getFullRecomputeRows(snapshot))
  expect(after.facets).toContainEqual(
    expect.objectContaining({count_value: 2, facet_key: 'publicationYear', facet_value: '2020'}),
  )
  expect(after.facets).not.toContainEqual(expect.objectContaining({facet_key: 'publicationYear', facet_value: '2022'}))
  expect(await getOptionCount({...snapshot, optionValueKey: 'review:publicationYear:2020'})).toBe(2)
  expect(await getOptionCount({...snapshot, optionValueKey: 'review:publicationYear:2021'})).toBe(2)
  expect(await getOptionCount({...snapshot, optionValueKey: 'review:publicationYear:2022'})).toBeNull()
})

test('running the same summary bucket patch twice leaves the ledger and the serving counts unchanged', async () => {
  const projectId = 'project-twice'
  const snapshot = await setupPublishedLedger(projectId)
  const {patchReviewServingSummaryLedgerBuckets} = await import('./reviewServingSummaryProjector.ts')
  const patchInput = {
    ...snapshot,
    buckets: [
      {
        bucketId: getChunkId(projectId, 1),
        effectiveEndKey: null,
        effectiveStartKey: 'article-x',
        ledgerStatus: 'published',
      },
    ] as const,
    listModeKeys: reviewServingListModes,
    projectScopeIdentity: getIdentity('projectScope', projectId),
    selectedImportSnapshotId: `selected-import-${projectId}`,
  }

  await assessArticleX(snapshot)

  const firstPatch = await patchReviewServingSummaryLedgerBuckets(patchInput, getDatabase() as never)
  const afterFirst = {ledger: await getLedgerRows(snapshot), serving: await getSummaryRows(snapshot)}
  const secondPatch = await patchReviewServingSummaryLedgerBuckets(patchInput, getDatabase() as never)
  const afterSecond = {ledger: await getLedgerRows(snapshot), serving: await getSummaryRows(snapshot)}

  expect(firstPatch).toMatchObject({bucketCount: 1, publishedBucketCount: 1})
  expect(secondPatch).toMatchObject({
    bucketCount: 1,
    partialRowCount: firstPatch.partialRowCount,
    publishedBucketCount: 1,
  })
  expect(afterSecond).toEqual(afterFirst)
  expect(afterSecond.serving).toEqual(await getFullRecomputeRows(snapshot))
})

test('a seeded candidate acknowledges summary claims above its seed and activates equal to a full rebuild', async () => {
  const projectId = 'project-seeded'
  await insertProject(projectId)
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)
  const live = {projectId, reviewConfigHash, snapshotId: 'snapshot-live'}
  const candidate = {projectId, reviewConfigHash, snapshotId: 'snapshot-seeded'}

  await upsertProjectionManifests({projectId, reviewConfigHash})
  await insertSnapshot({...live, hasSummary: false, status: 'active'})
  await insertSnapshot({...candidate, hasSummary: true, status: 'candidate'})
  await insertUpstreamRows(candidate)
  await insertSummaryRebuild({
    ...candidate,
    chunks: [
      {...firstBucket, status: 'completed'},
      {...secondBucket, status: 'pending'},
    ],
  })
  await upsertDirtyWork({articleId: 'article-b', component: 'summary', projectId, sourceHighWaterMark: 5})
  await parkSummaryDirtyWork({articleId: 'article-b', projectId})
  await insertJudgment({answer: 'no', articleId: 'article-a', projectId})
  await projectPayloadRows(candidate)
  await upsertDirtyWork({articleId: 'article-a', component: 'summary', projectId, sourceHighWaterMark: 20})
  await assessArticleX(candidate)
  await upsertDirtyWork({articleId: 'article-x', component: 'summary', projectId, sourceHighWaterMark: 30})

  const result = await wakeSummary()

  expect(result.failures).toEqual([])
  expect(result.releasedClaimIds).toEqual([])
  expect(await getRebuildRequestIds(projectId)).toEqual([getRequestId(projectId)])
  expect(await getDirtyWork(projectId)).toEqual([
    {articleId: 'article-a', lifecycleReason: 'projected', status: 'completed'},
    {articleId: 'article-b', lifecycleReason: 'blocked_by_rebuild', status: 'blocked_by_rebuild'},
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])

  await runSummaryChunk({...candidate, index: 1})
  expect(
    (await finalizeSummaryRebuild(candidate)).snapshots.map((row) => {
      return row.ledgerPublished
    }),
  ).toEqual([true])

  const {promoteReviewServingProjectorSnapshot} = await import('./reviewServingProjectorWriter.ts')

  expect(await promoteReviewServingProjectorSnapshot(candidate, getDatabase() as never)).toEqual({
    promoted: true,
    snapshotId: candidate.snapshotId,
  })
  expect(await getSummaryRows(candidate)).toEqual(await getFullRecomputeRows(candidate))
  expect(
    (await getDirtyWork(projectId)).filter((row) => {
      return row.status !== 'completed'
    }),
  ).toEqual([])
})

test('summary claims take a requested-only bootstrap when no snapshot has a bucket ledger', async () => {
  const projectId = 'project-pre-ledger'
  const rebuildRequests: Array<{components: readonly string[] | undefined; reason: string}> = []
  const requestRebuild: ReviewServingProjectorServiceDependencies['requestRebuild'] = (input) => {
    rebuildRequests.push({components: input.components, reason: input.reason})

    return Effect.succeed({
      projectId: input.projectId,
      requestId: `bootstrap-${input.projectId}`,
      sourceWatermarksJson: {dirtySourceWatermarks: seedSourceWatermarks},
      status: 'admitted',
    } as never)
  }

  await insertProject(projectId)
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)
  const live = {projectId, reviewConfigHash, snapshotId: 'snapshot-pre-ledger'}
  const candidate = {projectId, reviewConfigHash, snapshotId: 'snapshot-legacy-rebuild'}
  const {projectReviewServingSummaries} = await import('./reviewServingSummaryProjector.ts')

  await upsertProjectionManifests({projectId, reviewConfigHash})
  await insertSnapshot({...live, hasSummary: true, status: 'active'})
  await insertUpstreamRows(live)
  await projectReviewServingSummaries(getSummaryProjectorInput(live), getDatabase() as never)
  await insertSnapshot({...candidate, hasSummary: true, status: 'candidate'})
  await insertUpstreamRows(candidate)
  await insertSummaryRebuild({
    ...candidate,
    chunks: [
      {...firstBucket, status: 'completed'},
      {...secondBucket, status: 'pending'},
    ],
  })
  await getDatabase().run(`
    DELETE FROM mart.review_article_summary_bucket_v4 WHERE project_id = '${projectId}';
    DELETE FROM mart.review_article_summary_bucket_partial_v4 WHERE project_id = '${projectId}'
  `)

  const before = await getSummaryRows(live)

  await upsertDirtyWork({articleId: 'article-a', component: 'summary', projectId, sourceHighWaterMark: 5})
  await upsertDirtyWork({articleId: 'article-x', component: 'summary', projectId, sourceHighWaterMark: 20})

  const result = await wakeSummary({requestRebuild})

  expect(result.failures).toEqual([])
  expect(rebuildRequests).toEqual([{components: ['summary'], reason: 'summaryDirtyWork'}])
  expect(await getDirtyWork(projectId)).toEqual([
    {articleId: 'article-a', lifecycleReason: 'projected', status: 'completed'},
    {articleId: 'article-x', lifecycleReason: 'blocked_by_rebuild', status: 'blocked_by_rebuild'},
  ])
  expect(await getSummaryRows(live)).toEqual(before)
  expect(await getLedgerRows(candidate)).toEqual([])
})

test('a summary claim in a running bucket is deferred and patched once the bucket chunk completed', async () => {
  const projectId = 'project-running'
  await insertProject(projectId)
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)
  const candidate = {projectId, reviewConfigHash, snapshotId: 'snapshot-running'}

  await upsertProjectionManifests({projectId, reviewConfigHash})
  await insertSnapshot({...candidate, hasSummary: true, status: 'candidate'})
  await insertUpstreamRows(candidate)
  await insertSummaryRebuild({
    ...candidate,
    chunks: [
      {...firstBucket, status: 'running'},
      {...secondBucket, status: 'completed'},
    ],
  })
  await insertJudgment({answer: 'no', articleId: 'article-a', projectId})
  await projectPayloadRows(candidate)
  await upsertDirtyWork({articleId: 'article-a', component: 'summary', projectId, sourceHighWaterMark: 20})
  await assessArticleX(candidate)
  await upsertDirtyWork({articleId: 'article-x', component: 'summary', projectId, sourceHighWaterMark: 30})

  const firstWake = await wakeSummary()

  expect(firstWake.failures).toEqual([])
  expect(firstWake.releasedClaimIds).toHaveLength(1)
  expect(await getDirtyWork(projectId)).toEqual([
    {articleId: 'article-a', lifecycleReason: 'released', status: 'pending'},
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])

  await runSummaryChunk({...candidate, index: 0})

  const secondWake = await wakeSummary()

  expect(secondWake.failures).toEqual([])
  expect(await getDirtyWork(projectId)).toEqual([
    {articleId: 'article-a', lifecycleReason: 'projected', status: 'completed'},
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])
  expect(
    (await finalizeSummaryRebuild(candidate)).snapshots.map((row) => {
      return row.ledgerPublished
    }),
  ).toEqual([true])
  expect(await getSummaryRows(candidate)).toEqual(await getFullRecomputeRows(candidate))
})

test('a summary claim waits for unfinished posting work of its article at or below its watermark', async () => {
  const projectId = 'project-upstream'
  const snapshot = await setupPublishedLedger(projectId)

  await assessArticleX(snapshot)
  await upsertDirtyWork({articleId: 'article-x', component: 'posting', projectId, sourceHighWaterMark: 20})
  await upsertDirtyWork({articleId: 'article-x', component: 'summary', projectId, sourceHighWaterMark: 20})

  const firstWake = await wakeSummary()

  expect(firstWake.failures).toEqual([])
  expect(await getDirtyWork(projectId)).toEqual([
    {articleId: 'article-x', lifecycleReason: 'released', status: 'pending'},
  ])

  await getDatabase().run(`
    UPDATE app.review_serving_dirty_work SET status = 'completed'
    WHERE project_id = '${projectId}' AND projection_component = 'posting'
  `)

  const secondWake = await wakeSummary()

  expect(secondWake.failures).toEqual([])
  expect(await getDirtyWork(projectId)).toEqual([
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])
  expect(await getSummaryRows(snapshot)).toEqual(await getFullRecomputeRows(snapshot))
})
