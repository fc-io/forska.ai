import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'
import {Effect} from 'effect'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {reviewServingListModes} from './reviewServingContracts.ts'
import type {ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import type {ReviewServingFilterPostingProjectorDatabase} from './reviewServingFilterPostingProjector.ts'
import type {ReviewServingProjectorServiceDependencies} from './reviewServingProjectorService.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-incremental-posting')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const jobPartition = 'judgmentSqliteOutboxImport:job-posting'
const seedSourceWatermarks = {judgmentSqliteOutboxImport: 10}
const articleIds = ['article-a', 'article-b', 'article-x'] as const
const cachedListModes = ['llm', 'both'] as const

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

type PostingRow = {articleIds: string[]; filterKind: string; filterValue: string; listModeKey: string}
type DirtyWorkRow = {articleId: string; lifecycleReason: string | null; status: string}
type SnapshotInput = {projectId: string; reviewConfigHash: string; snapshotId: string}

const getIdentity = (component: string, projectId: string) => {
  return `${component}:${projectId}`
}

const getPromptId = (projectId: string) => {
  return `prompt-${projectId}`
}

const getAnswerFilterValue = (projectId: string, answer: string) => {
  return `review:promptAnswer:${getPromptId(projectId)}:${answer}`
}

const getArticleValuesSql = (projectId: string, row: (articleId: string, index: number) => string) => {
  return articleIds
    .map((articleId, index) => {
      return `(${row(articleId, index)})`
    })
    .join(', ')
    .replaceAll('<project>', projectId)
}

const insertProject = async (projectId: string) => {
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', '${projectId}', 'model-posting', TRUE, TRUE, FALSE, FALSE)
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
    VALUES ${getArticleValuesSql(projectId, (articleId) => {
      return `'<project>', '${articleId}', TRUE, FALSE, TIMESTAMPTZ '2026-09-20T10:00:00Z'`
    })}
  `)
  await getDatabase().run(`
    INSERT INTO app.review_selected_import_snapshot (selected_import_snapshot_id, project_id, project_scope_identity, status)
    VALUES ('selected-import-${projectId}', '${projectId}', '${getIdentity('projectScope', projectId)}', 'completed')
  `)
  await getDatabase().run(`
    INSERT INTO mart.review_selected_article_import_current_v4 (
      project_id, project_scope_identity, selected_import_snapshot_id, article_id, import_route_id, source_record_key
    ) VALUES ${getArticleValuesSql(projectId, (articleId) => {
      return `'<project>', 'projectScope:<project>', 'selected-import-<project>', '${articleId}', 'route-<project>', 'record-${articleId}'`
    })}
  `)
  await getDatabase().run(`
    INSERT INTO app.review_import_article_hot_field (
      import_route_id, article_id, source_record_key, publication_year, duplicate_flag, conflict_flag
    ) VALUES ${getArticleValuesSql(projectId, (articleId, index) => {
      return `'route-<project>', '${articleId}', 'record-${articleId}', ${2020 + index}, ${index === 1 ? 'TRUE' : 'FALSE'}, FALSE`
    })}
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
      'model-posting', TRUE, TRUE, FALSE, FALSE, 0, TRUE, '${input.answer}', current_timestamp, current_timestamp
    )
  `)
}

const upsertProjectionManifests = async (input: {
  postingBaseGeneration: number
  projectId: string
  reviewConfigHash: string
}) => {
  const {upsertReviewServingProjectionIdentityManifest} = await import('./reviewServingManifestRepository.ts')

  await [
    {baseGeneration: 0, component: 'projectScope', status: 'active'},
    {baseGeneration: 0, component: 'payload', status: 'candidate'},
    {baseGeneration: input.postingBaseGeneration, component: 'posting', status: 'candidate'},
  ].reduce<Promise<void>>(async (previous, manifest) => {
    await previous
    await upsertReviewServingProjectionIdentityManifest(
      {
        baseGeneration: manifest.baseGeneration,
        definitionVersion: `${manifest.component}:test`,
        inputWatermark: 10,
        inputWatermarks: seedSourceWatermarks,
        patchWatermark: 0,
        projectId: input.projectId,
        projectionComponent: manifest.component as 'payload' | 'posting' | 'projectScope',
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

const insertSnapshot = async (input: SnapshotInput & {status: 'active' | 'candidate'}) => {
  const componentState = {
    optional: [
      getComponentState('payload', input.projectId, 'optional'),
      getComponentState('posting', input.projectId, 'optional'),
    ],
    required: [getComponentState('projectScope', input.projectId, 'required')],
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
      '["payload", "posting"]'::JSON,
      '${JSON.stringify(seedSourceWatermarks)}'::JSON,
      'selected-import-${input.projectId}'
    )
  `)
}

const insertServingBaseRows = async (input: SnapshotInput) => {
  await getDatabase().run(`
    INSERT INTO mart.review_article_serving_base_v4 (
      project_id, review_config_hash, snapshot_id, base_generation, patch_watermark, article_id, article_created_at,
      sort_key, activity_sort_at
    ) VALUES ${getArticleValuesSql(input.projectId, (articleId) => {
      return `'<project>', '${input.reviewConfigHash}', '${input.snapshotId}', 0, 0, '${articleId}', TIMESTAMPTZ '2026-09-20T10:00:00Z', TIMESTAMPTZ '2026-09-20T10:00:00Z', TIMESTAMPTZ '2026-09-20T10:00:00Z'`
    })}
  `)
  await getDatabase().run(`
    INSERT INTO mart.review_article_serving_list_mode_state_v4 (
      project_id, review_config_hash, snapshot_id, article_id, has_llm_list_mode, has_human_list_mode,
      has_both_list_mode, has_unassessed_list_mode, llm_status, llm_has_judgment
    ) VALUES ${getArticleValuesSql(input.projectId, (articleId) => {
      return `'<project>', '${input.reviewConfigHash}', '${input.snapshotId}', '${articleId}', TRUE, TRUE, TRUE, TRUE, 'answered', TRUE`
    })}
  `)
}

const projectPayloadRows = async (input: SnapshotInput) => {
  const {projectReviewServingJudgmentPayloadRows} = await import('./reviewServingJudgmentPayloadProjector.ts')

  await projectReviewServingJudgmentPayloadRows(
    {
      listModeKeys: reviewServingListModes,
      modelId: 'model-posting',
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

const getPostingProjectorInput = (
  input: SnapshotInput & {chunkEndArticleId?: string; chunkStartArticleId?: string},
) => {
  return {
    acknowledgeClaims: false,
    baseGeneration: 0,
    chunkEndArticleId: input.chunkEndArticleId,
    chunkStartArticleId: input.chunkStartArticleId,
    claims: [],
    definitionVersion: 'posting:test',
    listModeKeys: reviewServingListModes,
    projectId: input.projectId,
    projectScopeIdentity: getIdentity('projectScope', input.projectId),
    projectionIdentity: getIdentity('posting', input.projectId),
    reviewConfigHash: input.reviewConfigHash,
    selectedImportSnapshotId: `selected-import-${input.projectId}`,
    snapshotId: input.snapshotId,
  }
}

const projectFullPostings = async (input: SnapshotInput) => {
  const {projectReviewServingFilterPostings} = await import('./reviewServingFilterPostingProjector.ts')

  await projectReviewServingFilterPostings(getPostingProjectorInput(input), getDatabase() as never)
}

const cachePromptAnswerPostings = async (input: SnapshotInput) => {
  const {ensureReviewServingLazyPromptAnswerPostingBuckets} =
    await import('./reviewServingLazyPromptAnswerPostingSql.ts')

  await cachedListModes.reduce<Promise<void>>(async (previous, listModeKey) => {
    await previous
    await ensureReviewServingLazyPromptAnswerPostingBuckets({
      database: getDatabase(),
      filterValues: [getAnswerFilterValue(input.projectId, 'yes'), getAnswerFilterValue(input.projectId, 'no')],
      listModeKey,
      projectId: input.projectId,
      reviewConfigHash: input.reviewConfigHash,
      snapshotId: input.snapshotId,
    })
  }, Promise.resolve())
}

const upsertDirtyWork = async (input: {
  articleId: string
  component: 'payload' | 'posting'
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
      modelId: 'model-posting',
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

const wake = async (
  component: 'payload' | 'posting',
  dependencies: Partial<ReviewServingProjectorServiceDependencies> = {},
) => {
  const [{wakeReviewServingProjectorService}, {getDefaultReviewServingProjectorRunners}] = await Promise.all([
    import('./reviewServingProjectorService.ts'),
    import('../workers/reviewServingProjectorWorker.ts'),
  ])

  return wakeReviewServingProjectorService(
    {batchSize: 64, componentOrder: [component], maxRowsPerWake: 64, maxWakeMs: 600_000, wakeId: `wake-${component}`},
    {
      database: getDatabase(),
      runners: getDefaultReviewServingProjectorRunners(getDatabase() as never),
      ...dependencies,
    },
  )
}

const getPostingRows = async (input: {projectId: string; snapshotId: string}) => {
  return getDatabase().queryJson<PostingRow>(`
    SELECT
      filter_kind AS filterKind,
      filter_value AS filterValue,
      list_mode_key AS listModeKey,
      article_ids AS articleIds
    FROM mart.review_article_filter_posting_serving_v4
    WHERE project_id = '${input.projectId}' AND snapshot_id = '${input.snapshotId}'
    ORDER BY filter_kind, filter_value, list_mode_key
  `)
}

const getPostingRowKey = (row: PostingRow) => {
  return `${row.filterKind}|${row.filterValue}|${row.listModeKey}`
}

const getPostingRowsExcept = (rows: readonly PostingRow[], excludedKeys: readonly string[]) => {
  return rows.filter((row) => {
    return !excludedKeys.includes(getPostingRowKey(row))
  })
}

const getPostingArticleIds = (rows: readonly PostingRow[], key: string) => {
  return rows.find((row) => {
    return getPostingRowKey(row) === key
  })?.articleIds
}

const getLazyPromptAnswerRows = async (input: SnapshotInput) => {
  const {getReviewServingLazyPromptAnswerPostingRowsSql} = await import('./reviewServingLazyPromptAnswerPostingSql.ts')
  const filterValuesSql = `['${getAnswerFilterValue(input.projectId, 'no')}', '${getAnswerFilterValue(input.projectId, 'yes')}']`

  return getDatabase().queryJson<PostingRow>(`
    ${cachedListModes
      .map((listModeKey) => {
        return `SELECT filter_kind AS filterKind, filter_value AS filterValue, list_mode_key AS listModeKey, article_ids AS articleIds
          FROM (${getReviewServingLazyPromptAnswerPostingRowsSql({
            filterValuesSql,
            listModeSql: `'${listModeKey}'`,
            projectIdSql: `'${input.projectId}'`,
            reviewConfigHashSql: `'${input.reviewConfigHash}'`,
            snapshotIdSql: `'${input.snapshotId}'`,
          })})`
      })
      .join(' UNION ALL ')}
    ORDER BY filterKind, filterValue, listModeKey
  `)
}

const getDirtyWork = async (projectId: string, component: 'payload' | 'posting') => {
  return getDatabase().queryJson<DirtyWorkRow>(`
    SELECT article_id AS articleId, status, lifecycle_reason AS lifecycleReason
    FROM app.review_serving_dirty_work
    WHERE project_id = '${projectId}' AND projection_component = '${component}'
    ORDER BY article_id
  `)
}

const getRebuildRequestCount = async (projectId: string) => {
  const [row] = await getDatabase().queryJson<{requestCount: number}>(`
    SELECT CAST(COUNT(*) AS INTEGER) AS requestCount FROM app.review_rebuild_request WHERE project_id = '${projectId}'
  `)

  return row?.requestCount ?? 0
}

const getListModeState = async (input: SnapshotInput & {articleId: string}) => {
  const [row] = await getDatabase().queryJson<{duplicateFlag: boolean; llmHasJudgment: boolean; llmStatus: string}>(`
    SELECT duplicate_flag AS duplicateFlag, llm_status AS llmStatus, llm_has_judgment AS llmHasJudgment
    FROM mart.review_article_serving_list_mode_state_v4
    WHERE project_id = '${input.projectId}' AND snapshot_id = '${input.snapshotId}' AND article_id = '${input.articleId}'
  `)

  return row
}

const setupBuiltSnapshot = async (projectId: string) => {
  await insertProject(projectId)
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)
  const snapshot = {projectId, reviewConfigHash, snapshotId: `snapshot-${projectId}`}

  await upsertProjectionManifests({postingBaseGeneration: 0, projectId, reviewConfigHash})
  await insertSnapshot({...snapshot, status: 'active'})
  await insertServingBaseRows(snapshot)
  await insertJudgment({answer: 'yes', articleId: 'article-a', judgmentId: `${projectId}-a-old`, projectId})
  await insertJudgment({answer: 'no', articleId: 'article-b', judgmentId: `${projectId}-b`, projectId})
  await insertJudgment({answer: 'yes', articleId: 'article-x', judgmentId: `${projectId}-x`, projectId})
  await projectPayloadRows(snapshot)
  await projectFullPostings(snapshot)
  await cachePromptAnswerPostings(snapshot)

  return snapshot
}

const yesKeys = cachedListModes.map((listModeKey) => {
  return `promptAnswer|${getAnswerFilterValue('<project>', 'yes')}|${listModeKey}`
})
const noKeys = cachedListModes.map((listModeKey) => {
  return `promptAnswer|${getAnswerFilterValue('<project>', 'no')}|${listModeKey}`
})
const getProjectKeys = (keys: readonly string[], projectId: string) => {
  return keys.map((key) => {
    return key.replaceAll('<project>', projectId)
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

  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()

  await migrateDuckdb()

  database = getAppDatabaseService()

  await getDatabase().run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
    VALUES ('connection-posting', 'sglang', 'SGLang', TRUE, 'none', 'https://worker.example.test')
  `)
  await getDatabase().run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled, variant, metadata_json)
    VALUES ('model-posting', 'connection-posting', 'Qwen', 'Qwen', 'Qwen', 'manual', TRUE, 'thinking', '{}'::JSON)
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

test('an answer change from yes to no moves the article between cached lists and leaves every other list unchanged', async () => {
  const projectId = 'project-answer'
  const snapshot = await setupBuiltSnapshot(projectId)
  const before = await getPostingRows(snapshot)
  const movedKeys = [...getProjectKeys(yesKeys, projectId), ...getProjectKeys(noKeys, projectId)]

  expect(
    movedKeys.map((key) => {
      return getPostingArticleIds(before, key)
    }),
  ).toEqual([['article-a', 'article-x'], ['article-a', 'article-x'], ['article-b'], ['article-b']])

  await insertJudgment({answer: 'no', articleId: 'article-a', judgmentId: `${projectId}-a-new`, projectId})
  await upsertDirtyWork({articleId: 'article-a', component: 'payload', projectId, sourceHighWaterMark: 20})
  await upsertDirtyWork({articleId: 'article-a', component: 'posting', projectId, sourceHighWaterMark: 20})

  expect((await wake('payload')).failures).toEqual([])

  const postingWake = await wake('posting')
  const after = await getPostingRows(snapshot)

  expect(postingWake.failures).toEqual([])
  expect(postingWake.releasedClaimIds).toEqual([])
  expect(await getRebuildRequestCount(projectId)).toBe(0)
  expect(await getDirtyWork(projectId, 'posting')).toEqual([
    {articleId: 'article-a', lifecycleReason: 'projected', status: 'completed'},
  ])
  expect(
    movedKeys.map((key) => {
      return getPostingArticleIds(after, key)
    }),
  ).toEqual([['article-x'], ['article-x'], ['article-a', 'article-b'], ['article-a', 'article-b']])
  expect(getPostingRowsExcept(after, movedKeys)).toEqual(getPostingRowsExcept(before, movedKeys))
  expect(getPostingRowsExcept(after, movedKeys).map(getPostingRowKey)).toEqual([
    `importRoute|route-${projectId}|both`,
    `importRoute|route-${projectId}|human`,
    `importRoute|route-${projectId}|llm`,
    `importRoute|route-${projectId}|unassessed`,
    ...['2020', '2021', '2022'].flatMap((year) => {
      return ['both', 'human', 'llm', 'unassessed'].map((listModeKey) => {
        return `publicationYear|${year}|${listModeKey}`
      })
    }),
  ])
  expect(
    after.filter((row) => {
      return row.filterKind === 'promptAnswer'
    }),
  ).toEqual(await getLazyPromptAnswerRows(snapshot))
})

test('a posting claim waits for unfinished payload work of its article at or below its watermark', async () => {
  const projectId = 'project-upstream'
  const snapshot = await setupBuiltSnapshot(projectId)
  const yesKey = getProjectKeys(yesKeys, projectId)[0] ?? ''
  const noKey = getProjectKeys(noKeys, projectId)[0] ?? ''

  await insertJudgment({answer: 'no', articleId: 'article-a', judgmentId: `${projectId}-a-new`, projectId})
  await upsertDirtyWork({articleId: 'article-a', component: 'payload', projectId, sourceHighWaterMark: 20})
  await upsertDirtyWork({articleId: 'article-a', component: 'posting', projectId, sourceHighWaterMark: 20})
  await upsertDirtyWork({articleId: 'article-x', component: 'payload', projectId, sourceHighWaterMark: 26})
  await upsertDirtyWork({articleId: 'article-x', component: 'posting', projectId, sourceHighWaterMark: 25})

  const firstWake = await wake('posting')
  const afterFirstWake = await getPostingRows(snapshot)

  expect(firstWake.failures).toEqual([])
  expect(await getDirtyWork(projectId, 'posting')).toEqual([
    {articleId: 'article-a', lifecycleReason: 'released', status: 'pending'},
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])
  expect(getPostingArticleIds(afterFirstWake, yesKey)).toEqual(['article-a', 'article-x'])
  expect(getPostingArticleIds(afterFirstWake, noKey)).toEqual(['article-b'])

  expect((await wake('payload')).failures).toEqual([])

  const secondWake = await wake('posting')
  const afterSecondWake = await getPostingRows(snapshot)

  expect(secondWake.failures).toEqual([])
  expect(await getDirtyWork(projectId, 'posting')).toEqual([
    {articleId: 'article-a', lifecycleReason: 'projected', status: 'completed'},
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])
  expect(getPostingArticleIds(afterSecondWake, yesKey)).toEqual(['article-x'])
  expect(getPostingArticleIds(afterSecondWake, noKey)).toEqual(['article-a', 'article-b'])
  expect(await getRebuildRequestCount(projectId)).toBe(0)
})

const insertPostingRebuild = async (
  input: SnapshotInput & {chunks: readonly {end: string; start: string; status: string}[]},
) => {
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_request (
      request_id, project_id, reason, requested_components_json, source_watermarks_json, identity_json, priority, status,
      admission_state
    ) VALUES (
      'rebuild-${input.projectId}', '${input.projectId}', 'postingDirtyWork', '["posting"]'::JSON,
      '${JSON.stringify({dirtySourceWatermarks: seedSourceWatermarks})}'::JSON,
      '${JSON.stringify({componentSet: ['projectScope', 'payload', 'posting'], reviewConfigHash: input.reviewConfigHash})}'::JSON,
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
        'chunk-${input.projectId}-${index}', 'rebuild-${input.projectId}', '${input.projectId}', '${input.snapshotId}',
        'posting', '${getIdentity('posting', input.projectId)}', '${chunk.start}', '${chunk.end}', 0, '${chunk.status}',
        'admitted', ${chunk.status === 'running' ? "'worker-test'" : 'NULL'},
        ${chunk.status === 'running' ? "current_timestamp + INTERVAL '10 minutes'" : 'NULL'}
      )
    `)
  }, Promise.resolve())
}

const runPostingChunk = async (input: SnapshotInput & {end: string; start: string}) => {
  const {projectReviewServingFilterPostingRanges} = await import('./reviewServingFilterPostingProjector.ts')

  await projectReviewServingFilterPostingRanges(
    {ranges: [getPostingProjectorInput({...input, chunkEndArticleId: input.end, chunkStartArticleId: input.start})]},
    getDatabase() as never,
  )
  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL, completed_at = current_timestamp
    WHERE project_id = '${input.projectId}' AND chunk_start_key = '${input.start}' AND chunk_end_key = '${input.end}'
  `)
}

const getDuplicatePostingCounts = async (projectId: string) => {
  const [row] = await getDatabase().queryJson<{duplicateArticleLists: number; duplicateKeys: number}>(`
    SELECT
      CAST((
        SELECT COUNT(*) FROM (
          SELECT snapshot_id, filter_kind, filter_value, list_mode_key
          FROM mart.review_article_filter_posting_serving_v4
          WHERE project_id = '${projectId}'
          GROUP BY ALL
          HAVING COUNT(*) > 1
        )
      ) AS INTEGER) AS duplicateKeys,
      CAST((
        SELECT COUNT(*)
        FROM mart.review_article_filter_posting_serving_v4
        WHERE project_id = '${projectId}' AND len(article_ids) <> len(list_distinct(article_ids))
      ) AS INTEGER) AS duplicateArticleLists
  `)

  return row
}

test('posting patches interleaved with posting chunks keep one list per key and equal a full projection', async () => {
  const projectId = 'project-chunks'
  await insertProject(projectId)
  const reviewConfigHash = await getCurrentReviewConfigHash(projectId)
  const candidate = {projectId, reviewConfigHash, snapshotId: `snapshot-${projectId}-candidate`}
  const reference = {projectId, reviewConfigHash, snapshotId: `snapshot-${projectId}-reference`}

  await upsertProjectionManifests({postingBaseGeneration: 0, projectId, reviewConfigHash})
  await insertSnapshot({...candidate, status: 'candidate'})
  await insertServingBaseRows(candidate)
  await insertServingBaseRows(reference)
  await insertJudgment({answer: 'yes', articleId: 'article-a', judgmentId: `${projectId}-a`, projectId})
  await insertJudgment({answer: 'no', articleId: 'article-x', judgmentId: `${projectId}-x`, projectId})
  await projectPayloadRows(candidate)
  await projectPayloadRows(reference)
  await insertPostingRebuild({
    ...candidate,
    chunks: [
      {end: 'article-m', start: 'article-a', status: 'running'},
      {end: 'article-z', start: 'article-n', status: 'pending'},
    ],
  })
  await upsertDirtyWork({articleId: 'article-a', component: 'posting', projectId, sourceHighWaterMark: 20})
  await upsertDirtyWork({articleId: 'article-x', component: 'posting', projectId, sourceHighWaterMark: 30})

  const firstWake = await wake('posting')

  expect(firstWake.failures).toEqual([])
  expect(await getDirtyWork(projectId, 'posting')).toEqual([
    {articleId: 'article-a', lifecycleReason: 'released', status: 'pending'},
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])
  expect(
    (await getPostingRows(candidate)).flatMap((row) => {
      return row.articleIds
    }),
  ).not.toContain('article-a')

  await runPostingChunk({...candidate, end: 'article-m', start: 'article-a'})
  await runPostingChunk({...candidate, end: 'article-z', start: 'article-n'})

  const secondWake = await wake('posting')

  expect(secondWake.failures).toEqual([])
  expect(await getDirtyWork(projectId, 'posting')).toEqual([
    {articleId: 'article-a', lifecycleReason: 'projected', status: 'completed'},
    {articleId: 'article-x', lifecycleReason: 'projected', status: 'completed'},
  ])
  expect(await getDuplicatePostingCounts(projectId)).toEqual({duplicateArticleLists: 0, duplicateKeys: 0})

  await projectFullPostings(reference)

  expect(await getPostingRows(candidate)).toEqual(await getPostingRows(reference))
})

test('posting claims take a requested-only bootstrap when no snapshot carries posting at the base generation', async () => {
  const projectId = 'project-other-generation'
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
  const snapshot = {projectId, reviewConfigHash, snapshotId: `snapshot-${projectId}`}

  await upsertProjectionManifests({postingBaseGeneration: 1, projectId, reviewConfigHash})
  await insertSnapshot({...snapshot, status: 'active'})
  await insertServingBaseRows(snapshot)
  await upsertDirtyWork({articleId: 'article-a', component: 'posting', projectId, sourceHighWaterMark: 5})
  await upsertDirtyWork({articleId: 'article-x', component: 'posting', projectId, sourceHighWaterMark: 20})

  const result = await wake('posting', {requestRebuild})

  expect(result.failures).toEqual([])
  expect(rebuildRequests).toEqual([{components: ['posting'], reason: 'postingDirtyWork'}])
  expect(await getDirtyWork(projectId, 'posting')).toEqual([
    {articleId: 'article-a', lifecycleReason: 'projected', status: 'completed'},
    {articleId: 'article-x', lifecycleReason: 'blocked_by_rebuild', status: 'blocked_by_rebuild'},
  ])
  expect(await getPostingRows(snapshot)).toEqual([])
})

const getInterleavingDatabase = (onContributionRead: () => Promise<void>) => {
  const realDatabase = getDatabase()

  return {
    queryJson: async <T>(statement: string) => {
      const rows = await realDatabase.queryJson<T>(statement)

      if (statement.includes('FROM posting_union')) {
        await onContributionRead()
      }

      return rows
    },
    run: (statement: string) => {
      return realDatabase.run(statement)
    },
    transaction: realDatabase.transaction.bind(realDatabase),
  } as unknown as ReviewServingFilterPostingProjectorDatabase
}

const getPostingClaim = (projectId: string): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-a',
    dirtyKind: 'judgment.llm.created',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: `${projectId}-posting-a`,
    firstSourceHighWaterMark: 20,
    latestDeltaId: null,
    latestSourceHighWaterMark: 20,
    projectId,
    projectionComponent: 'posting',
    projectionIdentity: getIdentity('posting', projectId),
    scopeId: `${projectId}:article-a`,
    scopeKind: 'article',
    sourcePartition: jobPartition,
    status: 'running',
  }
}

test('a posting patch keeps an llm status written between its source read and its write', async () => {
  const projectId = 'project-lost-update'
  const snapshot = await setupBuiltSnapshot(projectId)
  const {projectReviewServingFilterPostings} = await import('./reviewServingFilterPostingProjector.ts')
  const interleavingDatabase = getInterleavingDatabase(async () => {
    await getDatabase().run(`
      UPDATE mart.review_article_serving_list_mode_state_v4
      SET llm_status = 'partial', llm_has_judgment = FALSE
      WHERE project_id = '${projectId}' AND snapshot_id = '${snapshot.snapshotId}' AND article_id = 'article-a'
    `)
  })

  await projectReviewServingFilterPostings(
    {...getPostingProjectorInput(snapshot), claims: [getPostingClaim(projectId)]},
    interleavingDatabase,
  )

  expect(await getListModeState({...snapshot, articleId: 'article-a'})).toEqual({
    duplicateFlag: false,
    llmHasJudgment: false,
    llmStatus: 'partial',
  })
  expect(await getListModeState({...snapshot, articleId: 'article-b'})).toEqual({
    duplicateFlag: true,
    llmHasJudgment: true,
    llmStatus: 'answered',
  })
})
