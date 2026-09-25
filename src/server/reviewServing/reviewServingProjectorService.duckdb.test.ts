import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Effect} from 'effect'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {reviewServingListModes} from './reviewServingContracts.ts'
import type {ReviewServingProjectorServiceDependencies} from './reviewServingProjectorService.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-incremental-payload')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const jobPartition = 'judgmentSqliteOutboxImport:job-payload'
const seedSourceWatermarks = {judgmentSqliteOutboxImport: 10}
const articleIds = ['article-a', 'article-b', 'article-x'] as const

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

type DetailRow = {
  answeredOriginal: string | null
  articleId: string
  judgmentId: string | null
  payloadKind: string
  promptId: string
}

type DirtyWorkRow = {articleId: string; lifecycleReason: string | null; status: string}

const getPayloadIdentity = (projectId: string) => {
  return `payload:${projectId}`
}

const getProjectScopeIdentity = (projectId: string) => {
  return `projectScope:${projectId}`
}

const getPromptId = (projectId: string) => {
  return `prompt-${projectId}`
}

const insertProject = async (projectId: string) => {
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', '${projectId}', 'model-payload', TRUE, TRUE, FALSE, FALSE)
  `)
  await getDatabase().run(
    `INSERT INTO app.prompt (id, original_text) VALUES ('${getPromptId(projectId)}', 'Relevant?')`,
  )
  await getDatabase().run(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, archived)
    VALUES ('project-prompt-${projectId}', '${projectId}', '${getPromptId(projectId)}', 0, TRUE, FALSE)
  `)
  await getDatabase().run(`
    INSERT INTO mart.project_scope_article (project_id, article_id, in_curated_scope, in_route_scope, article_created_at)
    SELECT '${projectId}', article_id, TRUE, FALSE, TIMESTAMPTZ '2026-09-20T10:00:00Z'
    FROM (VALUES ${articleIds
      .map((articleId) => {
        return `('${articleId}')`
      })
      .join(', ')}) article(article_id)
  `)
  await getDatabase().run(`
    INSERT INTO app.review_selected_import_snapshot (selected_import_snapshot_id, project_id, project_scope_identity, status)
    VALUES ('selected-import-${projectId}', '${projectId}', '${getProjectScopeIdentity(projectId)}', 'completed')
  `)
}

const getCurrentReviewConfigHash = async (projectId: string) => {
  const {getCurrentReviewServingReviewConfigHash} = await import('./reviewServingReviewConfig.ts')
  const reviewConfigHash = await getCurrentReviewServingReviewConfigHash(projectId, getDatabase())

  if (reviewConfigHash === null) {
    throw new Error(`missing review config hash for ${projectId}`)
  }

  return reviewConfigHash
}

const insertJudgment = async (input: {answer: string; articleId: string; judgmentId: string; projectId: string}) => {
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
      '${input.judgmentId}', '${input.articleId}', '${getPromptId(input.projectId)}', '${input.projectId}',
      'model-payload', TRUE, TRUE, FALSE, FALSE, 0, TRUE, '${input.answer}', current_timestamp, current_timestamp
    )
  `)
}

const upsertProjectionManifests = async (input: {
  payloadInputWatermarks: Record<string, number>
  projectId: string
  reviewConfigHash: string
}) => {
  const {upsertReviewServingProjectionIdentityManifest} = await import('./reviewServingManifestRepository.ts')

  await upsertReviewServingProjectionIdentityManifest(
    {
      baseGeneration: 0,
      definitionVersion: 'projectScope:test',
      inputWatermark: 1_000,
      inputWatermarks: {judgmentSqliteOutboxImport: 1_000},
      patchWatermark: 0,
      projectId: input.projectId,
      projectionComponent: 'projectScope',
      projectionIdentity: getProjectScopeIdentity(input.projectId),
      reviewConfigHash: input.reviewConfigHash,
      status: 'active',
    },
    getDatabase(),
  )
  await upsertReviewServingProjectionIdentityManifest(
    {
      baseGeneration: 0,
      definitionVersion: 'payload:test',
      inputWatermark: Math.max(0, ...Object.values(input.payloadInputWatermarks)),
      inputWatermarks: input.payloadInputWatermarks,
      patchWatermark: 0,
      projectId: input.projectId,
      projectionComponent: 'payload',
      projectionIdentity: getPayloadIdentity(input.projectId),
      reviewConfigHash: input.reviewConfigHash,
      status: 'candidate',
    },
    getDatabase(),
  )
}

const insertSnapshot = async (input: {
  payloadBaseGeneration: number | null
  projectId: string
  reviewConfigHash: string
  snapshotId: string
  status: 'active' | 'candidate'
}) => {
  const payloadStates =
    input.payloadBaseGeneration === null
      ? []
      : [
          {
            baseGeneration: String(input.payloadBaseGeneration),
            component: 'payload',
            patchWatermark: '0',
            projectionIdentity: getPayloadIdentity(input.projectId),
            requirement: 'optional',
          },
        ]
  const componentState = {
    optional: payloadStates,
    required: [
      {
        baseGeneration: '0',
        component: 'projectScope',
        patchWatermark: '0',
        projectionIdentity: getProjectScopeIdentity(input.projectId),
        requirement: 'required',
      },
    ],
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
      '["projectScope"]'::JSON,
      '${JSON.stringify(input.payloadBaseGeneration === null ? [] : ['payload'])}'::JSON,
      '${JSON.stringify(seedSourceWatermarks)}'::JSON,
      'selected-import-${input.projectId}'
    )
  `)
}

const insertSeededPayloadRebuild = async (input: {
  chunks: readonly {chunkEndKey: string; chunkStartKey: string; status: 'completed' | 'pending' | 'running'}[]
  projectId: string
  reviewConfigHash: string
  snapshotId: string
}) => {
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_request (
      request_id, project_id, reason, requested_components_json, source_watermarks_json, identity_json, priority, status,
      admission_state
    ) VALUES (
      'rebuild-${input.projectId}',
      '${input.projectId}',
      'payloadDirtyWork',
      '["payload"]'::JSON,
      '${JSON.stringify({dirtySourceWatermarks: seedSourceWatermarks})}'::JSON,
      '${JSON.stringify({componentSet: ['projectScope', 'payload'], reviewConfigHash: input.reviewConfigHash})}'::JSON,
      100,
      'admitted',
      'admitted'
    )
  `)
  await input.chunks.reduce<Promise<void>>(async (previous, chunk, index) => {
    await previous
    await getDatabase().run(`
      INSERT INTO app.review_rebuild_chunk_manifest (
        chunk_id, request_id, project_id, snapshot_id, projection_component, projection_identity, chunk_start_key,
        chunk_end_key, output_base_generation, status, admission_state, lease_owner, lease_expires_at
      ) VALUES (
        'chunk-${input.projectId}-${index}',
        'rebuild-${input.projectId}',
        '${input.projectId}',
        '${input.snapshotId}',
        'payload',
        '${getPayloadIdentity(input.projectId)}',
        '${chunk.chunkStartKey}',
        '${chunk.chunkEndKey}',
        0,
        '${chunk.status}',
        'admitted',
        ${chunk.status === 'running' ? "'worker-test'" : 'NULL'},
        ${chunk.status === 'running' ? "current_timestamp + INTERVAL '10 minutes'" : 'NULL'}
      )
    `)
  }, Promise.resolve())
}

const upsertPayloadDirtyWork = async (input: {articleId: string; projectId: string; sourceHighWaterMark: number}) => {
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
      modelId: 'model-payload',
      projectId: input.projectId,
      promptId: getPromptId(input.projectId),
      sourceHighWaterMark: input.sourceHighWaterMark,
    },
  })

  if (scope === null) {
    throw new Error('expected an article dirty work scope')
  }

  await upsertReviewServingDirtyWork(
    {projectionComponent: 'payload', projectionIdentity: getPayloadIdentity(input.projectId), scope},
    getDatabase(),
  )
}

const parkPayloadDirtyWork = async (input: {articleId: string; projectId: string}) => {
  await getDatabase().run(`
    UPDATE app.review_serving_dirty_work
    SET status = 'blocked_by_rebuild', lifecycle_reason = 'blocked_by_rebuild'
    WHERE project_id = '${input.projectId}' AND article_id = '${input.articleId}' AND projection_component = 'payload'
  `)
  await getDatabase().run(`
    UPDATE app.review_serving_dirty_work_claim_state
    SET status = 'blocked_by_rebuild', lifecycle_reason = 'blocked_by_rebuild'
    WHERE dirty_work_id IN (
      SELECT dirty_work_id
      FROM app.review_serving_dirty_work
      WHERE project_id = '${input.projectId}' AND article_id = '${input.articleId}' AND projection_component = 'payload'
    )
  `)
}

const wakePayload = async (dependencies: Partial<ReviewServingProjectorServiceDependencies> = {}) => {
  const [{wakeReviewServingProjectorService}, {getDefaultReviewServingProjectorRunners}] = await Promise.all([
    import('./reviewServingProjectorService.ts'),
    import('../workers/reviewServingProjectorWorker.ts'),
  ])

  return wakeReviewServingProjectorService(
    {batchSize: 64, componentOrder: ['payload'], maxRowsPerWake: 64, maxWakeMs: 600_000, wakeId: 'wake-payload'},
    {
      database: getDatabase(),
      runners: getDefaultReviewServingProjectorRunners(getDatabase() as never),
      ...dependencies,
    },
  )
}

const getDetailRows = async (input: {projectId: string; snapshotId: string}) => {
  return getDatabase().queryJson<DetailRow>(`
    SELECT
      article_id AS articleId,
      prompt_id AS promptId,
      payload_kind AS payloadKind,
      judgment_id AS judgmentId,
      answered_original AS answeredOriginal
    FROM mart.review_article_judgment_detail_serving_v4
    WHERE project_id = '${input.projectId}' AND snapshot_id = '${input.snapshotId}'
    ORDER BY article_id, payload_kind, prompt_id, judgment_id
  `)
}

const getFullRecomputeRows = async (input: {projectId: string; reviewConfigHash: string}) => {
  const {projectReviewServingJudgmentPayloadRows} = await import('./reviewServingJudgmentPayloadProjector.ts')
  const snapshotId = `snapshot-full-${input.projectId}`

  await projectReviewServingJudgmentPayloadRows(
    {
      listModeKeys: reviewServingListModes,
      modelId: 'model-payload',
      projectId: input.projectId,
      reviewConfigHash: input.reviewConfigHash,
      snapshotId,
      useAbstract: true,
      useFulltext: false,
      useFulltextNoImages: false,
      useTitle: true,
    },
    getDatabase() as never,
  )

  return getDetailRows({projectId: input.projectId, snapshotId})
}

const runPayloadChunk = async (input: {
  chunkEndKey: string
  chunkStartKey: string
  projectId: string
  reviewConfigHash: string
  snapshotId: string
}) => {
  const {projectReviewServingJudgmentPayloadArticleRanges} = await import('./reviewServingJudgmentPayloadProjector.ts')

  await projectReviewServingJudgmentPayloadArticleRanges(
    {
      ranges: [
        {
          chunkEndArticleId: input.chunkEndKey,
          chunkStartArticleId: input.chunkStartKey,
          claims: [],
          listModeKeys: reviewServingListModes,
          modelId: 'model-payload',
          projectId: input.projectId,
          reviewConfigHash: input.reviewConfigHash,
          snapshotId: input.snapshotId,
          useAbstract: true,
          useFulltext: false,
          useFulltextNoImages: false,
          useTitle: true,
        },
      ],
    },
    getDatabase() as never,
  )
  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, completed_at = current_timestamp
    WHERE project_id = '${input.projectId}'
      AND chunk_start_key = '${input.chunkStartKey}'
      AND chunk_end_key = '${input.chunkEndKey}'
  `)
}

const promoteSnapshot = async (input: {projectId: string; snapshotId: string}) => {
  const {promoteReviewServingProjectorSnapshot} = await import('./reviewServingProjectorWriter.ts')

  return promoteReviewServingProjectorSnapshot(input, getDatabase() as never)
}

const getPayloadDirtyWork = async (projectId: string) => {
  return getDatabase().queryJson<DirtyWorkRow>(`
    SELECT article_id AS articleId, status, lifecycle_reason AS lifecycleReason
    FROM app.review_serving_dirty_work
    WHERE project_id = '${projectId}' AND projection_component = 'payload'
    ORDER BY article_id
  `)
}

const getRebuildRequestIds = async (projectId: string) => {
  const rows = await getDatabase().queryJson<{requestId: string}>(`
    SELECT request_id AS requestId
    FROM app.review_rebuild_request
    WHERE project_id = '${projectId}'
    ORDER BY request_id
  `)

  return rows.map((row) => {
    return row.requestId
  })
}

const getDuplicateDetailKeyCount = async (projectId: string) => {
  const [row] = await getDatabase().queryJson<{duplicateCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS duplicateCount
    FROM (
      SELECT snapshot_id, payload_kind, article_id, prompt_id
      FROM mart.review_article_judgment_detail_serving_v4
      WHERE project_id = '${projectId}'
      GROUP BY ALL
      HAVING COUNT(*) > 1
    )
  `)

  return row?.duplicateCount ?? 0
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
    VALUES ('connection-payload', 'sglang', 'SGLang', TRUE, 'none', 'https://worker.example.test')
  `)
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant, metadata_json)
    VALUES ('model-payload', 'connection-payload', 'Qwen', 'Qwen', 'Qwen', 'manual', TRUE, 'thinking', '{}'::JSON)
  `)
  await getDatabase().run(`
    INSERT INTO app.article (id, article_title)
    VALUES ${articleIds
      .map((articleId) => {
        return `('${articleId}', '${articleId}')`
      })
      .join(', ')}
  `)
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('a payload article claim with a built snapshot is patched and completed without a rebuild request', async () => {
  const projectId = 'project-built'
  await insertProject(projectId)
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)

  await upsertProjectionManifests({payloadInputWatermarks: seedSourceWatermarks, projectId, reviewConfigHash})
  await insertSnapshot({
    payloadBaseGeneration: 0,
    projectId,
    reviewConfigHash,
    snapshotId: 'snapshot-built',
    status: 'active',
  })
  await insertJudgment({answer: 'no', articleId: 'article-a', judgmentId: 'judgment-a-old', projectId})
  await runPayloadChunk({
    chunkEndKey: 'article-z',
    chunkStartKey: 'article-a',
    projectId,
    reviewConfigHash,
    snapshotId: 'snapshot-built',
  })
  await insertJudgment({answer: 'yes', articleId: 'article-a', judgmentId: 'judgment-a-new', projectId})
  await upsertPayloadDirtyWork({articleId: 'article-a', projectId, sourceHighWaterMark: 20})

  const result = await wakePayload()

  expect(result.failures).toEqual([])
  expect(result.releasedClaimIds).toEqual([])
  expect(await getRebuildRequestIds(projectId)).toEqual([])
  expect(await getPayloadDirtyWork(projectId)).toEqual([
    {articleId: 'article-a', lifecycleReason: 'projected', status: 'completed'},
  ])
  expect(await getDetailRows({projectId, snapshotId: 'snapshot-built'})).toEqual([
    {
      answeredOriginal: 'yes',
      articleId: 'article-a',
      judgmentId: 'judgment-a-new',
      payloadKind: 'llm',
      promptId: getPromptId(projectId),
    },
  ])
})

test('a seeded candidate acknowledges payload claims above its seed and activates equal to a full rebuild', async () => {
  const projectId = 'project-seeded'
  await insertProject(projectId)
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)

  await upsertProjectionManifests({payloadInputWatermarks: seedSourceWatermarks, projectId, reviewConfigHash})
  await insertSnapshot({
    payloadBaseGeneration: null,
    projectId,
    reviewConfigHash,
    snapshotId: 'snapshot-live',
    status: 'active',
  })
  await insertSnapshot({
    payloadBaseGeneration: 0,
    projectId,
    reviewConfigHash,
    snapshotId: 'snapshot-seeded',
    status: 'candidate',
  })
  await insertSeededPayloadRebuild({
    chunks: [{chunkEndKey: 'article-z', chunkStartKey: 'article-a', status: 'pending'}],
    projectId,
    reviewConfigHash,
    snapshotId: 'snapshot-seeded',
  })
  await insertJudgment({answer: 'yes', articleId: 'article-a', judgmentId: 'judgment-seeded-a', projectId})
  await upsertPayloadDirtyWork({articleId: 'article-a', projectId, sourceHighWaterMark: 5})
  await parkPayloadDirtyWork({articleId: 'article-a', projectId})
  await insertJudgment({answer: 'no', articleId: 'article-b', judgmentId: 'judgment-seeded-b', projectId})
  await upsertPayloadDirtyWork({articleId: 'article-b', projectId, sourceHighWaterMark: 20})
  await insertJudgment({answer: 'yes', articleId: 'article-x', judgmentId: 'judgment-seeded-x', projectId})
  await upsertPayloadDirtyWork({articleId: 'article-x', projectId, sourceHighWaterMark: 30})

  const result = await wakePayload()

  expect(result.failures).toEqual([])
  expect(result.releasedClaimIds).toEqual([])
  expect(await getRebuildRequestIds(projectId)).toEqual([`rebuild-${projectId}`])
  expect(await getPayloadDirtyWork(projectId)).toEqual([
    {articleId: 'article-a', lifecycleReason: 'blocked_by_rebuild', status: 'blocked_by_rebuild'},
    {articleId: 'article-b', lifecycleReason: 'projected', status: 'completed'},
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])

  await runPayloadChunk({
    chunkEndKey: 'article-z',
    chunkStartKey: 'article-a',
    projectId,
    reviewConfigHash,
    snapshotId: 'snapshot-seeded',
  })

  expect(await promoteSnapshot({projectId, snapshotId: 'snapshot-seeded'})).toEqual({
    promoted: true,
    snapshotId: 'snapshot-seeded',
  })
  expect(await getDetailRows({projectId, snapshotId: 'snapshot-seeded'})).toEqual(
    await getFullRecomputeRows({projectId, reviewConfigHash}),
  )
  expect(
    (await getPayloadDirtyWork(projectId)).filter((row) => {
      return row.status !== 'completed'
    }),
  ).toEqual([])
  expect(await getDuplicateDetailKeyCount(projectId)).toBe(0)
})

test('activation leaves a claim above the seed pending when it was deferred while another claim was patched', async () => {
  const projectId = 'project-deferred'
  await insertProject(projectId)
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)

  await upsertProjectionManifests({payloadInputWatermarks: seedSourceWatermarks, projectId, reviewConfigHash})
  await insertSnapshot({
    payloadBaseGeneration: null,
    projectId,
    reviewConfigHash,
    snapshotId: 'snapshot-live',
    status: 'active',
  })
  await insertSnapshot({
    payloadBaseGeneration: 0,
    projectId,
    reviewConfigHash,
    snapshotId: 'snapshot-seeded',
    status: 'candidate',
  })
  await insertSeededPayloadRebuild({
    chunks: [
      {chunkEndKey: 'article-m', chunkStartKey: 'article-a', status: 'running'},
      {chunkEndKey: 'article-z', chunkStartKey: 'article-n', status: 'pending'},
    ],
    projectId,
    reviewConfigHash,
    snapshotId: 'snapshot-seeded',
  })
  await insertJudgment({answer: 'yes', articleId: 'article-a', judgmentId: 'judgment-deferred-a', projectId})
  await upsertPayloadDirtyWork({articleId: 'article-a', projectId, sourceHighWaterMark: 100})
  await insertJudgment({answer: 'no', articleId: 'article-x', judgmentId: 'judgment-deferred-x', projectId})
  await upsertPayloadDirtyWork({articleId: 'article-x', projectId, sourceHighWaterMark: 200})

  const firstWake = await wakePayload()

  expect(firstWake.failures).toEqual([])
  expect(await getPayloadDirtyWork(projectId)).toEqual([
    {articleId: 'article-a', lifecycleReason: 'released', status: 'pending'},
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])

  await runPayloadChunk({
    chunkEndKey: 'article-m',
    chunkStartKey: 'article-a',
    projectId,
    reviewConfigHash,
    snapshotId: 'snapshot-seeded',
  })
  await runPayloadChunk({
    chunkEndKey: 'article-z',
    chunkStartKey: 'article-n',
    projectId,
    reviewConfigHash,
    snapshotId: 'snapshot-seeded',
  })

  expect(await promoteSnapshot({projectId, snapshotId: 'snapshot-seeded'})).toEqual({
    promoted: true,
    snapshotId: 'snapshot-seeded',
  })
  expect(await getPayloadDirtyWork(projectId)).toEqual([
    {articleId: 'article-a', lifecycleReason: 'released', status: 'pending'},
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])

  const secondWake = await wakePayload()

  expect(secondWake.failures).toEqual([])
  expect(await getPayloadDirtyWork(projectId)).toEqual([
    {articleId: 'article-a', lifecycleReason: 'projected', status: 'completed'},
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])
  expect(await getDetailRows({projectId, snapshotId: 'snapshot-seeded'})).toEqual(
    await getFullRecomputeRows({projectId, reviewConfigHash}),
  )
  expect(await getDuplicateDetailKeyCount(projectId)).toBe(0)
})

test('payload claims fall back to a requested-only bootstrap when no snapshot matches the review config or generation', async () => {
  const staleConfigProjectId = 'project-stale-config'
  const otherGenerationProjectId = 'project-other-generation'
  const rebuildRequests: Array<{components: readonly string[] | undefined; projectId: string; reason: string}> = []
  const requestRebuild: ReviewServingProjectorServiceDependencies['requestRebuild'] = (input) => {
    rebuildRequests.push({components: input.components, projectId: input.projectId, reason: input.reason})

    return Effect.succeed({
      projectId: input.projectId,
      requestId: `bootstrap-${input.projectId}`,
      sourceWatermarksJson: {dirtySourceWatermarks: seedSourceWatermarks},
      status: 'admitted',
    } as never)
  }

  await insertProject(staleConfigProjectId)
  await upsertProjectionManifests({
    payloadInputWatermarks: seedSourceWatermarks,
    projectId: staleConfigProjectId,
    reviewConfigHash: 'review:stale',
  })
  await insertSnapshot({
    payloadBaseGeneration: 0,
    projectId: staleConfigProjectId,
    reviewConfigHash: 'review:stale',
    snapshotId: 'snapshot-stale-config',
    status: 'active',
  })
  await insertJudgment({
    answer: 'yes',
    articleId: 'article-a',
    judgmentId: 'judgment-stale-a',
    projectId: staleConfigProjectId,
  })
  await upsertPayloadDirtyWork({articleId: 'article-a', projectId: staleConfigProjectId, sourceHighWaterMark: 20})

  await insertProject(otherGenerationProjectId)
  const otherGenerationReviewConfigHash = await getCurrentReviewConfigHash(otherGenerationProjectId)
  await upsertProjectionManifests({
    payloadInputWatermarks: seedSourceWatermarks,
    projectId: otherGenerationProjectId,
    reviewConfigHash: otherGenerationReviewConfigHash,
  })
  await insertSnapshot({
    payloadBaseGeneration: 1,
    projectId: otherGenerationProjectId,
    reviewConfigHash: otherGenerationReviewConfigHash,
    snapshotId: 'snapshot-other-generation',
    status: 'active',
  })
  await insertJudgment({
    answer: 'yes',
    articleId: 'article-a',
    judgmentId: 'judgment-other-generation-a',
    projectId: otherGenerationProjectId,
  })
  await upsertPayloadDirtyWork({articleId: 'article-a', projectId: otherGenerationProjectId, sourceHighWaterMark: 5})

  const staleConfigWake = await wakePayload({requestRebuild})
  const otherGenerationWake = await wakePayload({requestRebuild})

  expect(staleConfigWake.failures).toEqual([])
  expect(otherGenerationWake.failures).toEqual([])
  expect(
    rebuildRequests.toSorted((left, right) => {
      return left.projectId.localeCompare(right.projectId)
    }),
  ).toEqual([
    {components: ['payload'], projectId: otherGenerationProjectId, reason: 'payloadDirtyWork'},
    {components: ['payload'], projectId: staleConfigProjectId, reason: 'payloadDirtyWork'},
  ])
  expect(await getPayloadDirtyWork(staleConfigProjectId)).toEqual([
    {articleId: 'article-a', lifecycleReason: 'blocked_by_rebuild', status: 'blocked_by_rebuild'},
  ])
  expect(await getPayloadDirtyWork(otherGenerationProjectId)).toEqual([
    {articleId: 'article-a', lifecycleReason: 'projected', status: 'completed'},
  ])
  expect(await getDetailRows({projectId: staleConfigProjectId, snapshotId: 'snapshot-stale-config'})).toEqual([])
  expect(await getDetailRows({projectId: otherGenerationProjectId, snapshotId: 'snapshot-other-generation'})).toEqual(
    [],
  )
})
