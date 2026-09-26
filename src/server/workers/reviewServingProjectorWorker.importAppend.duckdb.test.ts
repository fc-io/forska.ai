import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {ReviewServingProjectionComponent} from '../reviewServing/reviewServingContracts.ts'
import type {WakeReviewServingProjectorServiceResult} from '../reviewServing/reviewServingProjectorService.ts'
import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-import-append')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const projectId = 'project-import-append'
const importRouteId = 'import-route-append'
const sourcePartition = `import-route:${importRouteId}`
const selectedImportSnapshotId = 'selected-import-append'
const snapshotId = 'snapshot-import-append-active'
const snapshotComponents = [
  'projectScope',
  'selectedImport',
  'display',
  'llmStatus',
  'humanStatus',
  'queue',
] as const satisfies readonly ReviewServingProjectionComponent[]
const adversarialComponentOrder = [
  'queue',
  'llmStatus',
  'humanStatus',
  'selectedImport',
  'projectScope',
] as const satisfies readonly ReviewServingProjectionComponent[]

let database: ReturnType<typeof getAppDatabaseService> | null = null
let reviewConfigHash = ''

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

type ServingRow = {
  articleId: string
  hasBaseRow: boolean
  humanStatus: string | null
  inScope: boolean
  llmHasJudgment: boolean | null
  llmStatus: string | null
  queueKind: string | null
}

type DirtyWorkRow = {count: number; projectionComponent: string; status: string}

const getIdentity = async (projectionComponent: ReviewServingProjectionComponent) => {
  const {buildReviewDirtyProjectionIdentity} = await import('../reviewServing/reviewProjectionIdentity.ts')

  return buildReviewDirtyProjectionIdentity({projectId, projectionComponent})
}

const insertArticle = async (input: {articleId: string; rank: number}) => {
  await getDatabase().run(`
    INSERT INTO app.article (id, article_title, article_created_at, article_updated_at)
    VALUES (
      '${input.articleId}', 'Title ${input.articleId}', TIMESTAMPTZ '2026-09-10T00:00:00Z',
      TIMESTAMPTZ '2026-09-10T00:00:00Z'
    )
  `)
  await getDatabase().run(`
    INSERT INTO app.article_import_route (id, article_id, import_route_id)
    VALUES ('article-route:${input.articleId}', '${input.articleId}', '${importRouteId}')
  `)
  await getDatabase().run(`
    INSERT INTO app.review_import_article_hot_field (
      import_route_id, article_id, source_record_key, selected_rank_key, selected_rank_numeric, tombstone
    ) VALUES (
      '${importRouteId}', '${input.articleId}', 'record:${input.articleId}', 'rank:${input.articleId}', ${input.rank}, FALSE
    )
  `)
}

const insertExistingServingRows = async (articleId: string) => {
  await getDatabase().run(`
    INSERT INTO mart.project_scope_article (
      project_id, article_id, in_curated_scope, in_route_scope, article_title, article_created_at, article_updated_at
    ) VALUES (
      '${projectId}', '${articleId}', FALSE, TRUE, 'Title ${articleId}', TIMESTAMPTZ '2026-09-10T00:00:00Z',
      TIMESTAMPTZ '2026-09-10T00:00:00Z'
    )
  `)
  await getDatabase().run(`
    INSERT INTO mart.review_article_serving_base_v4 (
      project_id, review_config_hash, snapshot_id, base_generation, patch_watermark, article_id, article_created_at,
      sort_key, activity_sort_at
    ) VALUES (
      '${projectId}', '${reviewConfigHash}', '${snapshotId}', 0, 0, '${articleId}', TIMESTAMPTZ '2026-09-10T00:00:00Z',
      TIMESTAMPTZ '2026-09-10T00:00:00Z', TIMESTAMPTZ '2026-09-10T00:00:00Z'
    )
  `)
  await getDatabase().run(`
    INSERT INTO mart.review_article_serving_list_mode_state_v4 (
      project_id, review_config_hash, snapshot_id, article_id, has_llm_list_mode, has_human_list_mode,
      has_both_list_mode, has_unassessed_list_mode, llm_patch_watermark, human_patch_watermark, both_patch_watermark,
      unassessed_patch_watermark, duplicate_flag, conflict_flag, llm_status, human_status, llm_has_judgment
    ) VALUES (
      '${projectId}', '${reviewConfigHash}', '${snapshotId}', '${articleId}', TRUE, TRUE, TRUE, TRUE, 0, 0, 0, 0, FALSE,
      FALSE, 'unanswered', 'unanswered', FALSE
    )
  `)
  await getDatabase().run(`
    INSERT INTO mart.review_unassessed_queue_article_rank_serving_v4 (
      project_id, review_config_hash, snapshot_id, queue_kind, priority_bucket, article_id, activity_sort_at
    ) VALUES (
      '${projectId}', '${reviewConfigHash}', '${snapshotId}', 'unassessed', 0, '${articleId}',
      TIMESTAMPTZ '2026-09-10T00:00:00Z'
    )
  `)
}

const insertSnapshot = async () => {
  const required = await Promise.all(
    snapshotComponents.map(async (component) => {
      return {
        baseGeneration: '0',
        component,
        patchWatermark: '0',
        projectionIdentity: await getIdentity(component),
        requirement: 'required',
      }
    }),
  )

  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id, snapshot_id, snapshot_status, review_config_hash, composed_identity_json, component_state_json,
      required_components_json, optional_components_json, source_watermarks_json, selected_import_snapshot_id
    ) VALUES (
      '${projectId}',
      '${snapshotId}',
      'active',
      '${reviewConfigHash}',
      '{}'::JSON,
      '${JSON.stringify({optional: [], required})}'::JSON,
      '${JSON.stringify(snapshotComponents)}'::JSON,
      '[]'::JSON,
      '{}'::JSON,
      '${selectedImportSnapshotId}'
    )
  `)
}

const upsertManifests = async () => {
  const {upsertReviewServingProjectionIdentityManifest} =
    await import('../reviewServing/reviewServingManifestRepository.ts')

  await snapshotComponents.reduce<Promise<void>>(async (previous, component) => {
    await previous
    await upsertReviewServingProjectionIdentityManifest(
      {
        baseGeneration: 0,
        definitionVersion: `${component}:test`,
        inputWatermark: 0,
        patchWatermark: 0,
        projectId,
        projectionComponent: component,
        projectionIdentity: await getIdentity(component),
        reviewConfigHash,
        status: 'active',
      },
      getDatabase(),
    )
  }, Promise.resolve())
}

const insertAddedDelta = async (input: {articleId: string; sourceHighWaterMark: number}) => {
  await getDatabase().run(`
    INSERT INTO app.import_run_article_delta (
      delta_id, change_kind, source_table, source_row_id, source_operation, source_partition, source_high_water_mark,
      idempotency_key, payload_version, import_route_id, article_id, source_record_key
    ) VALUES (
      'delta:${input.articleId}', 'importRoute.article.added', 'app.article_import_route',
      'article-route:${input.articleId}', 'insert', '${sourcePartition}', ${input.sourceHighWaterMark},
      'key:${input.articleId}', 1, '${importRouteId}', '${input.articleId}', 'record:${input.articleId}'
    )
  `)
}

const intakeDeltas = async (input: {end: number; start: number}) => {
  const {intakeReviewImportDeltasToDirtyWork} = await import('../reviewServing/reviewImportDeltaDirtyIntakeService.ts')

  return intakeReviewImportDeltasToDirtyWork(
    {endSourceHighWaterMark: input.end, limit: 512, sourcePartition, startSourceHighWaterMark: input.start},
    getDatabase() as never,
  )
}

const wake = async (wakeId: string) => {
  const [{wakeReviewServingProjectorService}, {getDefaultReviewServingProjectorRunners}] = await Promise.all([
    import('../reviewServing/reviewServingProjectorService.ts'),
    import('./reviewServingProjectorWorker.ts'),
  ])

  return wakeReviewServingProjectorService(
    {batchSize: 64, componentOrder: adversarialComponentOrder, maxRowsPerWake: 512, maxWakeMs: 600_000, wakeId},
    {database: getDatabase(), runners: getDefaultReviewServingProjectorRunners(getDatabase() as never)},
  )
}

const wakeUntilSettled = async (
  wakes: readonly WakeReviewServingProjectorServiceResult[] = [],
): Promise<readonly WakeReviewServingProjectorServiceResult[]> => {
  const result = await wake(`wake-import-append-${wakes.length}`)
  const settled = [...wakes, result]
  const pending = await getUnfinishedDirtyWorkCount()

  return pending === 0 || settled.length >= 8 ? settled : wakeUntilSettled(settled)
}

const getUnfinishedDirtyWorkCount = async () => {
  const [row] = await getDatabase().queryJson<{count: number}>(`
    SELECT CAST(count(*) AS INTEGER) AS count
    FROM app.review_serving_dirty_work
    WHERE project_id = '${projectId}'
      AND projection_component IN (${adversarialComponentOrder
        .map((component) => {
          return `'${component}'`
        })
        .join(', ')})
      AND status <> 'completed'
  `)

  return row?.count ?? 0
}

const getDirtyWorkRows = async () => {
  return getDatabase().queryJson<DirtyWorkRow>(`
    SELECT projection_component AS projectionComponent, status, CAST(count(*) AS INTEGER) AS count
    FROM app.review_serving_dirty_work
    WHERE project_id = '${projectId}'
      AND projection_component IN (${adversarialComponentOrder
        .map((component) => {
          return `'${component}'`
        })
        .join(', ')})
    GROUP BY ALL
    ORDER BY projectionComponent, status
  `)
}

const getServingRows = async () => {
  return getDatabase().queryJson<ServingRow>(`
    SELECT
      article.id AS articleId,
      scope.article_id IS NOT NULL AS inScope,
      base.article_id IS NOT NULL AS hasBaseRow,
      state.llm_status AS llmStatus,
      state.llm_has_judgment AS llmHasJudgment,
      state.human_status AS humanStatus,
      queue.queue_kind AS queueKind
    FROM app.article article
    LEFT JOIN mart.project_scope_article scope
      ON scope.project_id = '${projectId}'
      AND scope.article_id = article.id
    LEFT JOIN mart.review_article_serving_base_v4 base
      ON base.project_id = '${projectId}'
      AND base.snapshot_id = '${snapshotId}'
      AND base.article_id = article.id
    LEFT JOIN mart.review_article_serving_list_mode_state_v4 state
      ON state.project_id = '${projectId}'
      AND state.snapshot_id = '${snapshotId}'
      AND state.article_id = article.id
    LEFT JOIN mart.review_unassessed_queue_article_rank_serving_v4 queue
      ON queue.project_id = '${projectId}'
      AND queue.snapshot_id = '${snapshotId}'
      AND queue.queue_kind = 'unassessed'
      AND queue.article_id = article.id
    ORDER BY article.id
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
    VALUES ('connection-append', 'sglang', 'SGLang', TRUE, 'none', 'https://worker.example.test')
  `)
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant, metadata_json)
    VALUES ('model-append', 'connection-append', 'model', 'model', 'Model', 'manual', TRUE, 'thinking', '{}'::JSON)
  `)
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', '${projectId}', 'model-append', TRUE, TRUE, FALSE, FALSE)
  `)
  await getDatabase().run(`INSERT INTO app.prompt (id, original_text) VALUES ('prompt-append', 'Relevant?')`)
  await getDatabase().run(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, archived)
    VALUES ('project-prompt-append', '${projectId}', 'prompt-append', 0, TRUE, FALSE)
  `)
  await getDatabase().run(
    `INSERT INTO app.import_route (id, route) VALUES ('${importRouteId}', '/api/datasources/import/pubmed')`,
  )
  await getDatabase().run(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('project-route-append', '${projectId}', '${importRouteId}')
  `)
  await getDatabase().run(`
    INSERT INTO app.review_selected_import_snapshot (
      selected_import_snapshot_id, project_id, project_scope_identity, source_delta_high_water, status
    ) VALUES ('${selectedImportSnapshotId}', '${projectId}', '${await getIdentity('projectScope')}', 0, 'completed')
  `)

  const {getCurrentReviewServingReviewConfigHash} = await import('../reviewServing/reviewServingReviewConfig.ts')
  const currentReviewConfigHash = await getCurrentReviewServingReviewConfigHash(projectId, getDatabase())

  if (currentReviewConfigHash === null) {
    throw new Error('missing review config hash')
  }

  reviewConfigHash = currentReviewConfigHash

  await upsertManifests()
  await insertSnapshot()
  await insertArticle({articleId: 'article-existing', rank: 1})
  await insertExistingServingRows('article-existing')
})

afterAll(async () => {
  await database?.close()
  tempRuntimeRoot.cleanup()
})

test('import-route added articles reach scope, serving rows and the unassessed queue even when status components are claimed first', async () => {
  await insertArticle({articleId: 'article-new-1', rank: 2})
  await insertArticle({articleId: 'article-new-2', rank: 3})
  await insertAddedDelta({articleId: 'article-new-1', sourceHighWaterMark: 1})
  await insertAddedDelta({articleId: 'article-new-2', sourceHighWaterMark: 2})

  expect(await intakeDeltas({end: 2, start: 1})).toMatchObject({status: 'converted'})

  const [firstWake, ...laterWakes] = await wakeUntilSettled()

  expect(firstWake?.failures ?? []).toEqual([])
  expect(firstWake?.releasedClaimIds.length).toBeGreaterThan(0)
  expect(
    laterWakes.flatMap((result) => {
      return result.failures
    }),
  ).toEqual([])
  expect(await getDirtyWorkRows()).toEqual(
    adversarialComponentOrder.toSorted().map((projectionComponent) => {
      return {count: 2, projectionComponent, status: 'completed'}
    }),
  )
  expect(await getServingRows()).toEqual([
    {
      articleId: 'article-existing',
      hasBaseRow: true,
      humanStatus: 'unanswered',
      inScope: true,
      llmHasJudgment: false,
      llmStatus: 'unanswered',
      queueKind: 'unassessed',
    },
    ...['article-new-1', 'article-new-2'].map((articleId) => {
      return {
        articleId,
        hasBaseRow: true,
        humanStatus: 'unanswered',
        inScope: true,
        llmHasJudgment: false,
        llmStatus: 'unanswered',
        queueKind: 'unassessed',
      }
    }),
  ])
})

test('an import-route removal drops the article from scope and the serving snapshot', async () => {
  await getDatabase().run("DELETE FROM app.article_import_route WHERE article_id = 'article-new-2'")
  await getDatabase().run(`
    UPDATE app.review_import_article_hot_field SET tombstone = TRUE WHERE article_id = 'article-new-2'
  `)
  await getDatabase().run(`
    INSERT INTO app.import_run_article_delta (
      delta_id, change_kind, source_table, source_row_id, source_operation, source_partition, source_high_water_mark,
      idempotency_key, payload_version, import_route_id, article_id, source_record_key, tombstone
    ) VALUES (
      'delta:article-new-2:removed', 'importRoute.article.removed', 'app.article_import_route',
      'article-route:article-new-2', 'delete', '${sourcePartition}', 3, 'key:article-new-2:removed', 1,
      '${importRouteId}', 'article-new-2', 'record:article-new-2', TRUE
    )
  `)

  expect(await intakeDeltas({end: 3, start: 3})).toMatchObject({status: 'converted'})

  await wakeUntilSettled()

  const rows = await getServingRows()

  expect(
    rows.find((row) => {
      return row.articleId === 'article-new-2'
    }),
  ).toEqual({
    articleId: 'article-new-2',
    hasBaseRow: false,
    humanStatus: null,
    inScope: false,
    llmHasJudgment: null,
    llmStatus: null,
    queueKind: null,
  })
})

test('candidate validation waits out serving rows whose status work is still queued, not rows left without it', async () => {
  const [
    {getReviewServingSnapshotManifest},
    {validateReviewServingCandidateSnapshotManifest},
    {upsertReviewServingDirtyWork},
    {getReviewServingDirtyWorkScopeForChange},
  ] = await Promise.all([
    import('../reviewServing/reviewServingManifestRepository.ts'),
    import('../reviewServing/reviewServingSnapshotPromotionService.ts'),
    import('../reviewServing/reviewServingDirtyWorkService.ts'),
    import('../reviewServing/reviewServingProjectorDomain.ts'),
  ])
  const candidateSnapshotId = 'snapshot-import-append-candidate'
  const manifestStates = await getDatabase().queryJson<{
    baseGeneration: string
    component: string
    patchWatermark: string
    projectionIdentity: string
  }>(`
    SELECT
      CAST(base_generation AS VARCHAR) AS baseGeneration,
      projection_component AS component,
      CAST(patch_watermark AS VARCHAR) AS patchWatermark,
      projection_identity AS projectionIdentity
    FROM app.review_projection_identity_manifest
    WHERE project_id = '${projectId}'
    ORDER BY projection_component
  `)
  const required = manifestStates.map((state) => {
    return {...state, requirement: 'required'}
  })

  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest
    SELECT * REPLACE (
      '${candidateSnapshotId}' AS snapshot_id,
      'candidate' AS snapshot_status,
      '${JSON.stringify({optional: [], required})}'::JSON AS component_state_json
    )
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = '${projectId}' AND snapshot_id = '${snapshotId}'
  `)
  await getDatabase().run(`
    INSERT INTO mart.review_article_serving_base_v4
    SELECT * REPLACE ('${candidateSnapshotId}' AS snapshot_id)
    FROM mart.review_article_serving_base_v4
    WHERE project_id = '${projectId}' AND snapshot_id = '${snapshotId}'
  `)
  await getDatabase().run(`
    INSERT INTO mart.review_article_serving_list_mode_state_v4
    SELECT * REPLACE (
      '${candidateSnapshotId}' AS snapshot_id,
      CASE WHEN article_id = 'article-new-1' THEN NULL ELSE llm_status END AS llm_status
    )
    FROM mart.review_article_serving_list_mode_state_v4
    WHERE project_id = '${projectId}' AND snapshot_id = '${snapshotId}'
  `)
  await getDatabase().run(`
    INSERT INTO mart.review_unassessed_queue_article_rank_serving_v4
    SELECT * REPLACE ('${candidateSnapshotId}' AS snapshot_id)
    FROM mart.review_unassessed_queue_article_rank_serving_v4
    WHERE project_id = '${projectId}' AND snapshot_id = '${snapshotId}'
  `)

  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind: 'importRoute.article.added',
    sourceHighWaterMark: 4,
    sourcePartition,
    values: {
      articleId: 'article-new-1',
      importRouteId,
      importSourceRecordKey: 'record:article-new-1',
      projectId,
      sourceHighWaterMark: 4,
    },
  })

  if (scope === null) {
    throw new Error('expected an article dirty work scope')
  }

  await upsertReviewServingDirtyWork(
    {projectionComponent: 'llmStatus', projectionIdentity: await getIdentity('llmStatus'), scope},
    getDatabase(),
  )

  const validate = async () => {
    const candidate = await getReviewServingSnapshotManifest(
      {componentStateMode: 'raw', projectId, snapshotId: candidateSnapshotId},
      getDatabase(),
    )

    if (candidate === null) {
      throw new Error('candidate snapshot manifest is missing')
    }

    const result = await validateReviewServingCandidateSnapshotManifest(candidate, getDatabase())

    return result.ok ? null : result.error
  }

  expect(await validate()).toBeNull()

  await getDatabase().run(`
    UPDATE app.review_serving_dirty_work
    SET status = 'completed'
    WHERE project_id = '${projectId}' AND article_id = 'article-new-1' AND projection_component = 'llmStatus'
  `)

  expect(await validate()).toBe(
    'required component llmStatus has 1 list-mode rows with NULL status despite enabled prompts',
  )
})
