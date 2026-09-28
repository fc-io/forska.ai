import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {
  countReadyReviewServingComponents,
  filterReadyReviewServingComponents,
  type ReviewServingProjectionComponent,
} from './reviewServingContracts.ts'

setDefaultTimeout(120_000)

const tempRuntimeRoot = createTempRuntimeRoot('review-serving-v4-in-place-rebuild')

process.env.SERVER_ROLE = 'dev-single'
process.env.DUCKDB_PATH = tempRuntimeRoot.duckdbPath

const articleIds = ['article-a', 'article-b', 'article-c', 'article-d'] as const
const warningFilterEnrichmentComponents = [
  ...filterReadyReviewServingComponents,
  'queue',
] as const satisfies readonly ReviewServingProjectionComponent[]

let database: ReturnType<typeof getAppDatabaseService> | null = null

const getSortedComponents = (...components: readonly ReviewServingProjectionComponent[]) => {
  return [...components].sort()
}

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
    VALUES ('${projectId}', '${projectId}', 'model-in-place', TRUE, TRUE, FALSE, FALSE)
  `)
  await getDatabase().run(`INSERT INTO app.prompt (id, original_text) VALUES ('prompt-${projectId}', 'Relevant?')`)
  await getDatabase().run(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled, archived)
    VALUES ('project-prompt-${projectId}', '${projectId}', 'prompt-${projectId}', 0, TRUE, FALSE)
  `)
  const articleValues = articleIds
    .map((articleId) => {
      return `('${projectId}-${articleId}')`
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
    INSERT INTO mart.project_scope_article (
      project_id, article_id, in_curated_scope, in_route_scope, article_title, article_created_at
    )
    SELECT '${projectId}', id, TRUE, FALSE, 'Fresh title ' || id, TIMESTAMPTZ '2026-09-20T10:00:00Z'
    FROM (VALUES ${articleValues}) article(id)
  `)
}

const completeRequestChunks = async (requestId: string, components?: readonly ReviewServingProjectionComponent[]) => {
  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'completed', started_at = current_timestamp, completed_at = current_timestamp
    WHERE request_id = '${requestId}'
      ${
        components === undefined
          ? ''
          : `AND projection_component IN (${components
              .map((component) => {
                return `'${component}'`
              })
              .join(', ')})`
      }
  `)
}

type SnapshotRow = {optionalComponents: string; requiredComponents: string; snapshotId: string; status: string}

const getSnapshots = (projectId: string) => {
  return getDatabase().queryJson<SnapshotRow>(`
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

const getListedComponents = (snapshot: SnapshotRow | undefined) => {
  return [
    ...(JSON.parse(snapshot?.requiredComponents ?? '[]') as string[]),
    ...(JSON.parse(snapshot?.optionalComponents ?? '[]') as string[]),
  ].sort()
}

const getRequestRows = (projectId: string) => {
  return getDatabase().queryJson<{reason: string; requestId: string; status: string}>(`
    SELECT request_id AS requestId, reason, status
    FROM app.review_rebuild_request
    WHERE project_id = '${projectId}'
    ORDER BY created_at, request_id
  `)
}

const getRequestChunks = (requestId: string) => {
  return getDatabase().queryJson<{component: string; inputDigest: string; snapshotId: string; status: string}>(`
    SELECT DISTINCT
      projection_component AS component,
      input_digest AS inputDigest,
      snapshot_id AS snapshotId,
      status
    FROM app.review_rebuild_chunk_manifest
    WHERE request_id = '${requestId}'
    ORDER BY projection_component
  `)
}

const getAvailableComponents = async (projectId: string, snapshotId: string) => {
  const {getReviewServingSnapshotManifest} = await import('./reviewServingManifestRepository.ts')
  const manifest = await getReviewServingSnapshotManifest(
    {componentStateMode: 'available', projectId, snapshotId},
    getDatabase(),
  )

  return [...(manifest?.componentState.required ?? []), ...(manifest?.componentState.optional ?? [])]
    .map((state) => {
      return state.component
    })
    .sort()
}

// Builds and activates a snapshot the way a finished bootstrap leaves one: its chunks completed, its manifest active.
const buildActiveSnapshot = async (projectId: string, components: readonly ReviewServingProjectionComponent[]) => {
  const {requestReviewServingV4Rebuild} = await loadService()
  const request = await requestReviewServingV4Rebuild({
    components,
    pageFirstOnly: true,
    projectId,
    reason: 'missingReviewServingSnapshot',
  })
  const [snapshot] = await getSnapshots(projectId)

  if (snapshot === undefined) {
    throw new Error(`expected a candidate snapshot for ${projectId}`)
  }

  await completeRequestChunks(request.requestId)
  await getDatabase().run(`
    UPDATE app.review_serving_snapshot_manifest
    SET snapshot_status = 'active', activated_at = current_timestamp
    WHERE snapshot_id = '${snapshot.snapshotId}'
  `)
  await getDatabase().run(`
    UPDATE app.review_rebuild_request
    SET status = 'completed', completed_at = current_timestamp
    WHERE request_id = '${request.requestId}'
  `)

  return snapshot.snapshotId
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

test('filter enrichment extends the active snapshot in place and leaves its search served', async () => {
  const {requestReviewServingV4Rebuild} = await loadService()
  const projectId = 'project-in-place-filter'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [
    ...countReadyReviewServingComponents,
    'judgmentInputContent',
    'search',
  ])
  const request = await requestReviewServingV4Rebuild({
    components: warningFilterEnrichmentComponents,
    priority: 500,
    projectId,
    reason: 'filterReadinessEnrichment',
  })
  const snapshots = await getSnapshots(projectId)
  const chunks = await getRequestChunks(request.requestId)

  expect(request.status).toBe('admitted')
  expect(
    snapshots.map((snapshot) => {
      return [snapshot.snapshotId, snapshot.status]
    }),
  ).toEqual([[activeSnapshotId, 'active']])
  expect(getListedComponents(snapshots[0])).toEqual(
    getSortedComponents(
      ...countReadyReviewServingComponents,
      'judgmentInputContent',
      'search',
      'posting',
      'summary',
      'payload',
    ),
  )
  expect(JSON.parse(snapshots[0]?.requiredComponents ?? '[]')).toEqual([...countReadyReviewServingComponents])
  expect(chunks).toEqual([
    {
      component: 'payload',
      inputDigest: 'inPlaceReviewServingAddition',
      snapshotId: activeSnapshotId,
      status: 'pending',
    },
    {
      component: 'posting',
      inputDigest: 'inPlaceReviewServingAddition',
      snapshotId: activeSnapshotId,
      status: 'pending',
    },
    {
      component: 'summary',
      inputDigest: 'inPlaceReviewServingAddition',
      snapshotId: activeSnapshotId,
      status: 'pending',
    },
  ])
  expect(await getAvailableComponents(projectId, activeSnapshotId)).toEqual(
    getSortedComponents(...countReadyReviewServingComponents, 'judgmentInputContent', 'search'),
  )

  await completeRequestChunks(request.requestId)

  expect(await getAvailableComponents(projectId, activeSnapshotId)).toEqual(
    getSortedComponents(
      ...countReadyReviewServingComponents,
      'judgmentInputContent',
      'search',
      'posting',
      'summary',
      'payload',
    ),
  )

  const repeated = await requestReviewServingV4Rebuild({
    components: warningFilterEnrichmentComponents,
    priority: 500,
    projectId,
    reason: 'filterReadinessEnrichment',
  })

  expect(repeated.status).toBe('completed')
  expect(repeated.diagnosticsJson).toMatchObject({inPlaceSnapshot: {alreadyServed: true, snapshotId: activeSnapshotId}})
  expect(await getRequestRows(projectId)).toHaveLength(2)
  expect(await getSnapshots(projectId)).toHaveLength(1)
})

test('search and judgment input dirty work add their component to the active snapshot in place', async () => {
  const {requestReviewServingV4Rebuild} = await loadService()
  const projectId = 'project-in-place-search'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [
    ...countReadyReviewServingComponents,
    'payload',
    'posting',
    'summary',
  ])
  const searchRequest = await requestReviewServingV4Rebuild({
    components: ['search'],
    priority: 75,
    projectId,
    reason: 'searchDirtyWork',
  })
  const judgmentInputRequest = await requestReviewServingV4Rebuild({
    components: ['judgmentInputContent'],
    priority: 100,
    projectId,
    reason: 'judgmentInputContentDirtyWork',
  })
  const snapshots = await getSnapshots(projectId)

  expect(judgmentInputRequest.requestId).toBe(searchRequest.requestId)
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]).toMatchObject({snapshotId: activeSnapshotId, status: 'active'})
  expect(getListedComponents(snapshots[0])).toEqual(
    getSortedComponents(
      ...countReadyReviewServingComponents,
      'payload',
      'posting',
      'summary',
      'search',
      'judgmentInputContent',
    ),
  )
  expect(await getRequestChunks(searchRequest.requestId)).toEqual([
    {
      component: 'judgmentInputContent',
      inputDigest: 'inPlaceReviewServingAddition',
      snapshotId: activeSnapshotId,
      status: 'pending',
    },
    {component: 'search', inputDigest: 'inPlaceReviewServingAddition', snapshotId: activeSnapshotId, status: 'pending'},
  ])
  expect(await getAvailableComponents(projectId, activeSnapshotId)).toEqual(
    getSortedComponents(...countReadyReviewServingComponents, 'payload', 'posting', 'summary'),
  )
})

test('dirty work of a component the active snapshot serves refreshes it in place while it stays served', async () => {
  const {requestReviewServingV4Rebuild} = await loadService()
  const {getActiveOrLastKnownGoodReviewServingSnapshotManifest} = await import('./reviewServingManifestRepository.ts')
  const projectId = 'project-in-place-refresh'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [...countReadyReviewServingComponents, 'search'])
  const request = await requestReviewServingV4Rebuild({
    components: ['search'],
    priority: 75,
    projectId,
    reason: 'searchDirtyWork',
  })
  const [snapshotRow] = await getDatabase().queryJson<{reviewConfigHash: string}>(`
    SELECT review_config_hash AS reviewConfigHash
    FROM app.review_serving_snapshot_manifest
    WHERE snapshot_id = '${activeSnapshotId}'
  `)
  const reviewConfigHash = snapshotRow?.reviewConfigHash ?? null
  const searchReadable = async () => {
    const manifest = await getActiveOrLastKnownGoodReviewServingSnapshotManifest(
      {componentStateMode: 'available', projectId, requiredComponents: ['projectScope', 'search'], reviewConfigHash},
      getDatabase(),
    )

    return {
      hasSearch: manifest?.componentState.optional.some((state) => {
        return state.component === 'search'
      }),
      snapshotId: manifest?.snapshotId,
    }
  }

  expect(request.status).toBe('admitted')
  expect(await getSnapshots(projectId)).toHaveLength(1)
  expect(await getRequestChunks(request.requestId)).toEqual([
    {component: 'search', inputDigest: 'inPlaceReviewServingRefresh', snapshotId: activeSnapshotId, status: 'pending'},
  ])
  expect(await searchReadable()).toEqual({hasSearch: true, snapshotId: activeSnapshotId})

  await completeRequestChunks(request.requestId)

  expect(await searchReadable()).toEqual({hasSearch: true, snapshotId: activeSnapshotId})
})

test('a later enrichment request joins an in-place rebuild of the active snapshot', async () => {
  const {requestReviewServingV4Rebuild} = await loadService()
  const projectId = 'project-in-place-join'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [...countReadyReviewServingComponents])
  const searchRequest = await requestReviewServingV4Rebuild({
    components: ['search'],
    priority: 75,
    projectId,
    reason: 'searchDirtyWork',
  })
  const joined = await requestReviewServingV4Rebuild({
    components: warningFilterEnrichmentComponents,
    priority: 500,
    projectId,
    reason: 'filterReadinessEnrichment',
  })

  expect(joined.requestId).toBe(searchRequest.requestId)
  expect(await getRequestRows(projectId)).toHaveLength(2)
  expect(await getSnapshots(projectId)).toHaveLength(1)
  expect(
    (await getRequestChunks(searchRequest.requestId)).map((chunk) => {
      return [chunk.component, chunk.inputDigest, chunk.snapshotId]
    }),
  ).toEqual([
    ['posting', 'inPlaceReviewServingAddition', activeSnapshotId],
    ['search', 'inPlaceReviewServingAddition', activeSnapshotId],
    ['summary', 'inPlaceReviewServingAddition', activeSnapshotId],
  ])
})

test('a new bootstrap carries every component of the active snapshot it replaces', async () => {
  const {requestReviewServingV4Rebuild} = await loadService()
  const projectId = 'project-in-place-carry-forward'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [
    ...countReadyReviewServingComponents,
    'judgmentInputContent',
    'payload',
    'posting',
    'search',
    'summary',
  ])
  const request = await requestReviewServingV4Rebuild({
    components: ['summary'],
    priority: 50,
    projectId,
    reason: 'summaryDirtyWork',
  })
  const snapshots = await getSnapshots(projectId)
  const candidate = snapshots.find((snapshot) => {
    return snapshot.status === 'candidate'
  })
  const rebuiltComponents = (await getRequestChunks(request.requestId)).map((chunk) => {
    return chunk.component
  })

  expect(request.status).toBe('admitted')
  expect(
    snapshots.find((snapshot) => {
      return snapshot.snapshotId === activeSnapshotId
    })?.status,
  ).toBe('active')
  expect(getListedComponents(candidate)).toEqual(
    getListedComponents(
      snapshots.find((s) => {
        return s.status === 'active'
      }),
    ),
  )
  expect(JSON.parse(candidate?.optionalComponents ?? '[]')).toEqual(
    expect.arrayContaining(['judgmentInputContent', 'payload', 'posting', 'search', 'summary']),
  )
  expect(rebuiltComponents).toContain('summary')
  expect(rebuiltComponents).toContain('posting')
  expect(rebuiltComponents).toContain('judgmentInputContent')
})

test('a bootstrap that lands on the active snapshot id never reseeds the active snapshot', async () => {
  const {requestReviewServingV4Rebuild} = await loadService()
  const projectId = 'project-in-place-same-id'
  const requestSummaryDirtyWork = () => {
    return requestReviewServingV4Rebuild({components: ['summary'], priority: 50, projectId, reason: 'summaryDirtyWork'})
  }
  const getActiveSnapshotRow = async () => {
    const [row] = await getDatabase().queryJson<{activatedAt: string; snapshotId: string; status: string}>(`
      SELECT snapshot_id AS snapshotId, snapshot_status AS status, activated_at::VARCHAR AS activatedAt
      FROM app.review_serving_snapshot_manifest
      WHERE project_id = '${projectId}' AND snapshot_status = 'active'
    `)

    return row
  }

  await insertProject(projectId)

  const first = await requestSummaryDirtyWork()
  const [built] = await getSnapshots(projectId)

  await completeRequestChunks(first.requestId)
  await getDatabase().run(`
    UPDATE app.review_serving_snapshot_manifest
    SET snapshot_status = 'active', activated_at = current_timestamp
    WHERE snapshot_id = '${built?.snapshotId}'
  `)
  await getDatabase().run(`
    UPDATE app.review_rebuild_request
    SET status = 'completed', completed_at = current_timestamp
    WHERE request_id = '${first.requestId}'
  `)

  const activeBefore = await getActiveSnapshotRow()
  const repeated = await requestSummaryDirtyWork()

  expect(repeated.status).toBe('completed')
  expect(repeated.diagnosticsJson).toMatchObject({
    inPlaceSnapshot: {alreadyServed: true, snapshotId: built?.snapshotId},
  })
  expect(await getActiveSnapshotRow()).toEqual(activeBefore)
  expect(await getSnapshots(projectId)).toHaveLength(1)

  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'pending', completed_at = NULL
    WHERE request_id = '${first.requestId}' AND projection_component = 'display'
  `)

  const rebuilt = await requestSummaryDirtyWork()
  const snapshots = await getSnapshots(projectId)

  expect(rebuilt.status).toBe('admitted')
  expect(await getActiveSnapshotRow()).toEqual(activeBefore)
  expect(
    snapshots.map((snapshot) => {
      return snapshot.status
    }),
  ).toEqual(['active', 'candidate'])
  expect(
    (await getRequestChunks(rebuilt.requestId)).every((chunk) => {
      return chunk.snapshotId !== built?.snapshotId
    }),
  ).toBe(true)
})

test('title search rebuild ranges replace the rows a snapshot already holds for them', async () => {
  const {projectReviewServingTitleSearchRebuildRanges} = await import('./reviewServingTitleSearchProjector.ts')
  const projectId = 'project-in-place-search-rows'
  const snapshotId = 'snapshot:search-rows'
  const [articleA = '', articleB = '', articleC = '', articleD = ''] = articleIds.map((articleId) => {
    return `${projectId}-${articleId}`
  })

  await insertProject(projectId)
  await getDatabase().run(`
    INSERT INTO mart.review_title_search_serving_v4 (
      project_id, search_identity, project_scope_identity, snapshot_id, token, article_ids
    ) VALUES
      ('${projectId}', 'search:rows', 'scope:rows', '${snapshotId}', 'stale', ['${articleA}', '${articleB}']),
      ('${projectId}', 'search:rows', 'scope:rows', '${snapshotId}', 'straddle', ['${articleB}', '${articleD}']),
      ('${projectId}', 'search:rows', 'scope:rows', '${snapshotId}', 'outside', ['${articleD}']),
      ('${projectId}', 'search:rows', 'scope:rows', 'snapshot:other', 'stale', ['${articleA}'])
  `)

  await projectReviewServingTitleSearchRebuildRanges(
    {
      ranges: [
        {
          baseGeneration: 0,
          chunkEndArticleId: articleC,
          chunkStartArticleId: articleA,
          projectId,
          projectScopeIdentity: 'scope:rows',
          replaceExistingRows: true,
          searchIdentity: 'search:rows',
          snapshotId,
        },
      ],
    },
    getDatabase() as Parameters<typeof projectReviewServingTitleSearchRebuildRanges>[1],
  )

  const rows = await getDatabase().queryJson<{articleIds: string; snapshotId: string; token: string}>(`
    SELECT snapshot_id AS snapshotId, token, article_ids::VARCHAR AS articleIds
    FROM mart.review_title_search_serving_v4
    WHERE project_id = '${projectId}'
      AND token IN ('stale', 'straddle', 'outside', 'fresh')
    ORDER BY snapshot_id, token, article_ids::VARCHAR
  `)
  const freshArticleIds = await getDatabase().queryJson<{articleId: string}>(`
    SELECT DISTINCT UNNEST(article_ids) AS articleId
    FROM mart.review_title_search_serving_v4
    WHERE project_id = '${projectId}' AND snapshot_id = '${snapshotId}' AND token = 'fresh'
    ORDER BY articleId
  `)

  expect(
    rows.filter((row) => {
      return row.token !== 'fresh'
    }),
  ).toEqual([
    {articleIds: `[${articleA}]`, snapshotId: 'snapshot:other', token: 'stale'},
    {articleIds: `[${articleD}]`, snapshotId, token: 'outside'},
    {articleIds: `[${articleD}]`, snapshotId, token: 'straddle'},
  ])
  expect(
    freshArticleIds.map((row) => {
      return row.articleId
    }),
  ).toEqual([articleA, articleB, articleC])
})

test('judgment payload rebuild ranges replace a snapshot range only when asked to', async () => {
  const {projectReviewServingJudgmentPayloadArticleRanges} = await import('./reviewServingJudgmentPayloadProjector.ts')
  const projectId = 'project-in-place-payload-rows'
  const snapshotId = 'snapshot:payload-rows'
  const [articleA = '', articleB = '', , articleD = ''] = articleIds.map((articleId) => {
    return `${projectId}-${articleId}`
  })
  const insertStaleRow = async (articleId: string) => {
    await getDatabase().run(`
      INSERT INTO mart.review_article_judgment_detail_serving_v4 (
        project_id, review_config_hash, snapshot_id, payload_kind, article_id, prompt_id, prompt_order, judgment_id,
        is_answered, detail_updated_at
      ) VALUES (
        '${projectId}', 'review:payload-rows', '${snapshotId}', 'llm', '${articleId}', 'prompt-${projectId}', 0,
        'judgment:stale-${articleId}', TRUE, current_timestamp
      )
    `)
  }
  const writeRange = async (replaceExistingRows: boolean) => {
    await projectReviewServingJudgmentPayloadArticleRanges(
      {
        ranges: [
          {
            acknowledgeClaims: false,
            chunkEndArticleId: articleB,
            chunkStartArticleId: articleA,
            claims: [],
            listModeKeys: ['llm', 'human', 'both', 'unassessed'],
            modelId: 'model-in-place',
            projectId,
            replaceExistingRows,
            reviewConfigHash: 'review:payload-rows',
            snapshotId,
            useAbstract: true,
            useFulltext: false,
            useFulltextNoImages: false,
            useTitle: true,
          },
        ],
      },
      getDatabase() as Parameters<typeof projectReviewServingJudgmentPayloadArticleRanges>[1],
    )
  }
  const getJudgmentIds = async () => {
    const rows = await getDatabase().queryJson<{judgmentId: string}>(`
      SELECT judgment_id AS judgmentId
      FROM mart.review_article_judgment_detail_serving_v4
      WHERE project_id = '${projectId}' AND snapshot_id = '${snapshotId}'
      ORDER BY judgment_id
    `)

    return rows.map((row) => {
      return row.judgmentId
    })
  }

  await insertProject(projectId)
  await insertStaleRow(articleA)
  await insertStaleRow(articleD)
  await writeRange(false)

  expect(await getJudgmentIds()).toEqual([`judgment:stale-${articleA}`, `judgment:stale-${articleD}`])

  await writeRange(true)

  expect(await getJudgmentIds()).toEqual([`judgment:stale-${articleD}`])
})
