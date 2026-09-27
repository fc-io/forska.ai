import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-v4-rebuild-train')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const articleIds = ['article-a', 'article-b', 'article-c', 'article-d'] as const

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getDatabase = () => {
  if (database === null) {
    throw new Error('Database not initialized')
  }

  return database
}

const loadService = () => {
  return import('./reviewServingV4RebuildRequestService.ts')
}

const insertProject = async (projectId: string) => {
  await getDatabase().run(`
    INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
    VALUES ('${projectId}', '${projectId}', 'model-train', TRUE, TRUE, FALSE, FALSE)
  `)
  await getDatabase().run(`INSERT INTO app.prompt (id, original_text) VALUES ('prompt-${projectId}', 'Relevant?')`)
  await getDatabase().run(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, archived)
    VALUES ('project-prompt-${projectId}', '${projectId}', 'prompt-${projectId}', 0, TRUE, FALSE)
  `)
  const scopedArticleIds = articleIds.map((articleId) => {
    return `${projectId}-${articleId}`
  })
  const articleValues = scopedArticleIds
    .map((articleId) => {
      return `('${articleId}')`
    })
    .join(', ')

  await getDatabase().run(`
    INSERT INTO app.article (id, article_id, article_title, article_summary, article_created_at, article_updated_at)
    SELECT id, 'external-' || id, 'Title ' || id, 'Abstract ' || id, TIMESTAMPTZ '2026-09-20T10:00:00Z',
      TIMESTAMPTZ '2026-09-20T10:00:00Z'
    FROM (VALUES ${articleValues}) article(id)
  `)
  await getDatabase().run(`
    INSERT INTO app.project_article (id, project_id, article_id)
    SELECT '${projectId}:' || id, '${projectId}', id
    FROM (VALUES ${articleValues}) article(id)
  `)
  await getDatabase().run(`
    INSERT INTO mart.project_scope_article (project_id, article_id, in_curated_scope, in_route_scope, article_created_at)
    SELECT '${projectId}', id, TRUE, FALSE, TIMESTAMPTZ '2026-09-20T10:00:00Z'
    FROM (VALUES ${articleValues}) article(id)
  `)
}

const getRequests = (projectId: string) => {
  return getDatabase().queryJson<{
    lastError: string | null
    priority: number
    reason: string
    requestedComponents: string
    requestId: string
    status: string
  }>(`
    SELECT
      request_id AS requestId,
      reason,
      status,
      priority,
      last_error AS lastError,
      requested_components_json::VARCHAR AS requestedComponents
    FROM app.review_rebuild_request
    WHERE project_id = '${projectId}'
    ORDER BY created_at, request_id
  `)
}

const getRequestChunkComponents = async (requestId: string) => {
  const rows = await getDatabase().queryJson<{component: string; snapshotCount: number; status: string}>(`
    SELECT
      projection_component AS component,
      string_agg(DISTINCT status, ',' ORDER BY status) AS status,
      COUNT(DISTINCT snapshot_id)::INTEGER AS snapshotCount
    FROM app.review_rebuild_chunk_manifest
    WHERE request_id = '${requestId}'
    GROUP BY projection_component
    ORDER BY projection_component
  `)

  return rows
}

const getSnapshots = (projectId: string) => {
  return getDatabase().queryJson<{
    optionalComponents: string
    requiredComponents: string
    snapshotId: string
    status: string
  }>(`
    SELECT
      snapshot_id AS snapshotId,
      snapshot_status AS status,
      required_components_json::VARCHAR AS requiredComponents,
      optional_components_json::VARCHAR AS optionalComponents
    FROM app.review_serving_snapshot_manifest
    WHERE project_id = '${projectId}'
    ORDER BY created_at, snapshot_id
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

test('a later enrichment rebuild joins the running train instead of building another snapshot', async () => {
  const {requestReviewServingV4Rebuild} = await loadService()
  const projectId = 'project-train-join'

  await insertProject(projectId)

  const train = await requestReviewServingV4Rebuild({projectId, reason: 'missingReviewServingSnapshot'})
  const joined = await requestReviewServingV4Rebuild({
    components: ['payload'],
    priority: 100,
    projectId,
    reason: 'payloadDirtyWork',
  })
  const [snapshot, ...otherSnapshots] = await getSnapshots(projectId)
  const chunkComponents = await getRequestChunkComponents(train.requestId)

  expect(joined.requestId).toBe(train.requestId)
  expect(joined.requestedComponents).toContain('payload')
  expect(await getRequests(projectId)).toHaveLength(1)
  expect(otherSnapshots).toEqual([])
  expect(JSON.parse(snapshot?.optionalComponents ?? '[]')).toContain('payload')
  expect(
    chunkComponents.find((row) => {
      return row.component === 'payload'
    }),
  ).toEqual({component: 'payload', snapshotCount: 1, status: 'pending'})
  expect(
    new Set(
      chunkComponents.map((row) => {
        return row.snapshotCount
      }),
    ),
  ).toEqual(new Set([1]))

  const rejoined = await requestReviewServingV4Rebuild({
    components: ['payload'],
    priority: 100,
    projectId,
    reason: 'payloadDirtyWork',
  })
  const payloadChunkCount = await getDatabase().queryJson<{count: number}>(`
    SELECT COUNT(*)::INTEGER AS count
    FROM app.review_rebuild_chunk_manifest
    WHERE request_id = '${train.requestId}' AND projection_component = 'payload'
  `)

  expect(rejoined.requestId).toBe(train.requestId)
  expect(payloadChunkCount).toEqual(
    await getDatabase().queryJson<{count: number}>(`
    SELECT COUNT(DISTINCT chunk_start_key)::INTEGER AS count
    FROM app.review_rebuild_chunk_manifest
    WHERE request_id = '${train.requestId}' AND projection_component = 'display'
  `),
  )
})

test('concurrent trains fold into the one with the least work left and cancel the rest', async () => {
  const {coalesceReviewServingV4BootstrapTrains, requestReviewServingV4Rebuild} = await loadService()
  const projectId = 'project-train-coalesce'

  await insertProject(projectId)

  const searchTrain = await requestReviewServingV4Rebuild({
    components: ['search'],
    priority: 75,
    projectId,
    reason: 'searchDirtyWork',
  })

  await getDatabase().run(`
    UPDATE app.review_rebuild_request SET status = 'running' WHERE request_id = '${searchTrain.requestId}'
  `)

  const postingTrain = await requestReviewServingV4Rebuild({
    components: ['posting'],
    priority: 50,
    projectId,
    reason: 'postingDirtyWork',
  })

  await getDatabase().run(`
    UPDATE app.review_rebuild_request SET status = 'admitted' WHERE request_id = '${searchTrain.requestId}'
  `)
  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'completed', completed_at = current_timestamp
    WHERE request_id = '${postingTrain.requestId}'
      AND projection_component IN ('projectScope', 'selectedImport', 'display', 'llmStatus', 'humanStatus')
  `)
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_request (
      request_id, project_id, reason, requested_components_json, source_watermarks_json, identity_json, priority,
      status, admission_state, last_error
    )
    SELECT
      'rebuild:failed-in-place', '${projectId}', 'humanStatusDirtyWork', '["humanStatus"]',
      '{"dirtySourceWatermarks":{}}',
      json_object('componentSet', ['humanStatus'], 'reviewConfigHash', json_extract_string(identity_json, '$.reviewConfigHash')),
      10000, 'failed', 'admitted', 'FATAL Error: database has been invalidated'
    FROM app.review_rebuild_request
    WHERE request_id = '${postingTrain.requestId}'
  `)
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      chunk_id, project_id, projection_component, projection_identity, chunk_start_key, chunk_end_key, status, request_id
    ) VALUES (
      'chunk:failed-in-place', '${projectId}', 'humanStatus', 'humanStatus:${projectId}',
      '${projectId}-article-a', '${projectId}-article-d',
      'pending', 'rebuild:failed-in-place'
    )
  `)

  const coalesced = await coalesceReviewServingV4BootstrapTrains({nowMs: Date.now(), projectId})
  const requests = await getRequests(projectId)
  const survivor = requests.find((request) => {
    return request.requestId === postingTrain.requestId
  })
  const snapshots = await getSnapshots(projectId)
  const liveSnapshots = snapshots.filter((snapshot) => {
    return snapshot.status === 'candidate'
  })

  expect(coalesced).toEqual([
    {
      addedComponents: ['search'],
      cancelledRequestIds: [searchTrain.requestId, 'rebuild:failed-in-place'],
      projectId,
      survivorRequestId: postingTrain.requestId,
    },
  ])
  expect(survivor).toMatchObject({priority: 75, status: 'admitted'})
  expect(JSON.parse(survivor?.requestedComponents ?? '[]')).toEqual(expect.arrayContaining(['posting', 'search']))
  expect(
    requests
      .filter((request) => {
        return request.requestId !== postingTrain.requestId
      })
      .map((request) => {
        return [request.requestId, request.status, request.lastError]
      }),
  ).toEqual([
    [searchTrain.requestId, 'cancelled', `coalesced into rebuild train ${postingTrain.requestId}`],
    ['rebuild:failed-in-place', 'cancelled', `coalesced into rebuild train ${postingTrain.requestId}`],
  ])
  expect(liveSnapshots).toHaveLength(1)
  expect(JSON.parse(liveSnapshots[0]?.optionalComponents ?? '[]')).toEqual(
    expect.arrayContaining(['posting', 'search']),
  )
  expect(
    (await getRequestChunkComponents(searchTrain.requestId)).find((row) => {
      return row.component === 'search'
    }),
  ).toEqual({component: 'search', snapshotCount: 1, status: 'failed'})
  expect(await getRequestChunkComponents('rebuild:failed-in-place')).toEqual([
    {component: 'humanStatus', snapshotCount: 0, status: 'failed'},
  ])
  expect(
    (await getRequestChunkComponents(postingTrain.requestId)).find((row) => {
      return row.component === 'search'
    }),
  ).toEqual({component: 'search', snapshotCount: 1, status: 'pending'})
  expect(await coalesceReviewServingV4BootstrapTrains({nowMs: Date.now() + 120_000, projectId})).toEqual([])
})
