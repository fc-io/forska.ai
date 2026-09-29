import {afterAll, beforeAll, expect, setDefaultTimeout, test} from 'bun:test'

import type {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {createTempRuntimeRoot} from '../test/createTempRuntimeRoot.ts'
import {
  countReadyReviewServingComponents,
  filterReadyReviewServingComponents,
  type ReviewServingProjectionComponent,
} from './reviewServingContracts.ts'
import {
  getPublishReviewServingSummaryLedgerStatusStatements,
  reviewServingSummaryBucketTable,
} from './reviewServingSummaryLedger.ts'

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

// Completes a request's chunks the way the worker does: summary chunks leave their ranges as 'building' ledger buckets,
// and the request turns completed with its last chunk unless it still has buckets to publish at finalization.
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
  await getDatabase().run(`
    INSERT INTO ${reviewServingSummaryBucketTable} (
      project_id, review_config_hash, snapshot_id, bucket_id, request_id, bucket_start_key, bucket_end_key, ledger_status
    )
    SELECT
      chunk.project_id, snapshot.review_config_hash, chunk.snapshot_id, chunk.chunk_id, chunk.request_id,
      chunk.chunk_start_key, chunk.chunk_end_key, 'building'
    FROM app.review_rebuild_chunk_manifest chunk
    INNER JOIN app.review_serving_snapshot_manifest snapshot
      ON snapshot.snapshot_id = chunk.snapshot_id
    WHERE chunk.request_id = '${requestId}'
      AND chunk.projection_component = 'summary'
      AND chunk.status = 'completed'
      AND NOT EXISTS (
        SELECT 1
        FROM ${reviewServingSummaryBucketTable} bucket
        WHERE bucket.snapshot_id = chunk.snapshot_id
          AND bucket.bucket_id = chunk.chunk_id
      )
  `)
  await getDatabase().run(`
    UPDATE app.review_rebuild_request
    SET status = 'completed', completed_at = current_timestamp
    WHERE request_id = '${requestId}'
      AND status IN ('admitted', 'running')
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest chunk
        WHERE chunk.request_id = '${requestId}'
          AND chunk.status <> 'completed'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${reviewServingSummaryBucketTable} bucket
        WHERE bucket.request_id = '${requestId}'
          AND bucket.ledger_status = 'building'
      )
  `)
}

// Finalizes a request the way the worker does for summary: its ledger buckets are published, replacing other requests'.
const finalizeRequest = async (requestId: string) => {
  const snapshots = await getDatabase().queryJson<{projectId: string; reviewConfigHash: string; snapshotId: string}>(`
    SELECT DISTINCT
      chunk.project_id AS projectId,
      snapshot.review_config_hash AS reviewConfigHash,
      chunk.snapshot_id AS snapshotId
    FROM app.review_rebuild_chunk_manifest chunk
    INNER JOIN app.review_serving_snapshot_manifest snapshot
      ON snapshot.snapshot_id = chunk.snapshot_id
    WHERE chunk.request_id = '${requestId}'
      AND chunk.projection_component = 'summary'
  `)

  await snapshots.reduce<Promise<void>>(async (previous, snapshot) => {
    await previous
    await getPublishReviewServingSummaryLedgerStatusStatements({...snapshot, requestId}).reduce<Promise<void>>(
      async (previousStatement, statement) => {
        await previousStatement
        await getDatabase().run(statement)
      },
      Promise.resolve(),
    )
  }, Promise.resolve())
  await getDatabase().run(`
    UPDATE app.review_rebuild_request
    SET status = 'completed', completed_at = current_timestamp
    WHERE request_id = '${requestId}'
  `)
}

const getLedgerBuckets = (snapshotId: string) => {
  return getDatabase().queryJson<{ledgerStatus: string; requestId: string}>(`
    SELECT DISTINCT request_id AS requestId, ledger_status AS ledgerStatus
    FROM ${reviewServingSummaryBucketTable}
    WHERE snapshot_id = '${snapshotId}'
    ORDER BY request_id
  `)
}

// Makes a component of a snapshot unavailable, the way an unfinished rebuild of it does.
const breakSnapshotComponent = async (snapshotId: string, component: ReviewServingProjectionComponent) => {
  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'pending', completed_at = NULL
    WHERE snapshot_id = '${snapshotId}' AND projection_component = '${component}'
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
  await finalizeRequest(request.requestId)
  await getDatabase().run(`
    UPDATE app.review_serving_snapshot_manifest
    SET snapshot_status = 'active', activated_at = current_timestamp
    WHERE snapshot_id = '${snapshot.snapshotId}'
  `)

  return snapshot.snapshotId
}

const jobPartition = 'judgmentSqliteOutboxImport:job-in-place'

// Queues dirty work for one article the way intake does for an LLM judgment.
const upsertDirtyWork = async (input: {
  articleId: string
  components: readonly ReviewServingProjectionComponent[]
  projectId: string
  sourceHighWaterMark: number
}) => {
  const [
    {getReviewServingDirtyWorkScopeForChange},
    {upsertReviewServingDirtyWork},
    {buildReviewDirtyProjectionIdentity},
  ] = await Promise.all([
    import('./reviewServingProjectorDomain.ts'),
    import('./reviewServingDirtyWorkService.ts'),
    import('./reviewProjectionIdentity.ts'),
  ])
  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind: 'judgment.llm.created',
    sourceHighWaterMark: input.sourceHighWaterMark,
    sourcePartition: jobPartition,
    values: {
      articleId: `${input.projectId}-${input.articleId}`,
      contentFlags: {useAbstract: true, useFulltext: false, useFulltextNoImages: false, useTitle: true},
      judgmentId: `judgment-${input.articleId}-${input.sourceHighWaterMark}`,
      modelId: 'model-in-place',
      projectId: input.projectId,
      promptId: `prompt-${input.projectId}`,
      sourceHighWaterMark: input.sourceHighWaterMark,
    },
  })

  if (scope === null) {
    throw new Error('expected an article dirty work scope')
  }

  await input.components.reduce<Promise<void>>(async (previous, component) => {
    await previous
    await upsertReviewServingDirtyWork(
      {
        projectionComponent: component,
        projectionIdentity: buildReviewDirtyProjectionIdentity({
          projectId: input.projectId,
          projectionComponent: component,
        }),
        scope,
      },
      getDatabase(),
    )
  }, Promise.resolve())
}

// Queues project-wide dirty work the way intake does for a project-level change.
const upsertProjectDirtyWork = async (input: {
  changeKind: string
  components: readonly ReviewServingProjectionComponent[]
  projectId: string
  values: Record<string, string>
}) => {
  const [
    {getReviewServingDirtyWorkScopeForChange},
    {upsertReviewServingDirtyWork},
    {buildReviewDirtyProjectionIdentity},
  ] = await Promise.all([
    import('./reviewServingProjectorDomain.ts'),
    import('./reviewServingDirtyWorkService.ts'),
    import('./reviewProjectionIdentity.ts'),
  ])
  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind: input.changeKind,
    sourceHighWaterMark: 4,
    sourcePartition: jobPartition,
    values: {...input.values, projectId: input.projectId, sourceHighWaterMark: 4},
  })

  if (scope === null) {
    throw new Error(`expected a ${input.changeKind} dirty work scope`)
  }

  await input.components.reduce<Promise<void>>(async (previous, component) => {
    await previous
    await upsertReviewServingDirtyWork(
      {
        projectionComponent: component,
        projectionIdentity: buildReviewDirtyProjectionIdentity({
          projectId: input.projectId,
          projectionComponent: component,
        }),
        scope,
      },
      getDatabase(),
    )
  }, Promise.resolve())
}

const getDirtyWorkStatuses = (projectId: string, component: ReviewServingProjectionComponent) => {
  return getDatabase().queryJson<{articleId: string | null; status: string}>(`
    SELECT replace(article_id, '${projectId}-', '') AS articleId, status
    FROM app.review_serving_dirty_work
    WHERE project_id = '${projectId}' AND projection_component = '${component}'
    ORDER BY article_id NULLS LAST
  `)
}

// Wakes the projector for one component of one project: dirty work other tests left behind is settled first, since a
// wake claims one project's rows at a time.
const wakeProjector = async (component: ReviewServingProjectionComponent, projectId: string) => {
  const [{wakeReviewServingProjectorService}, {getDefaultReviewServingProjectorRunners}] = await Promise.all([
    import('./reviewServingProjectorService.ts'),
    import('../workers/reviewServingProjectorWorker.ts'),
  ])

  await getDatabase().run(`
    UPDATE app.review_serving_dirty_work_claim_state SET status = 'completed'
    WHERE project_id <> '${projectId}' AND status <> 'completed'
  `)
  await getDatabase().run(`
    UPDATE app.review_serving_dirty_work SET status = 'completed'
    WHERE project_id <> '${projectId}' AND status <> 'completed'
  `)

  return wakeReviewServingProjectorService(
    {batchSize: 64, componentOrder: [component], maxRowsPerWake: 64, maxWakeMs: 600_000, wakeId: `wake-${component}`},
    {database: getDatabase(), runners: getDefaultReviewServingProjectorRunners(getDatabase() as never)},
  )
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

  // Summary rows are published when the request is finalized, not when its chunks complete; until then the request
  // stays admitted.
  expect((await getRequestRows(projectId)).at(-1)?.status).toBe('admitted')
  expect(await getAvailableComponents(projectId, activeSnapshotId)).toEqual(
    getSortedComponents(...countReadyReviewServingComponents, 'judgmentInputContent', 'search', 'posting', 'payload'),
  )

  // Asked again before publication, the enrichment waits for the request instead of building summary a second time
  // (that build's publication would drop this one's buckets).
  const whilePublishing = await requestReviewServingV4Rebuild({
    components: warningFilterEnrichmentComponents,
    priority: 500,
    projectId,
    reason: 'filterReadinessEnrichment',
  })

  expect(whilePublishing.requestId).toBe(request.requestId)
  expect(await getRequestRows(projectId)).toHaveLength(2)

  await finalizeRequest(request.requestId)

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
    ['payload', 'inPlaceReviewServingAddition', activeSnapshotId],
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

  // The active snapshot no longer serves a count-ready component, so enrichment builds a new snapshot.
  await breakSnapshotComponent(activeSnapshotId, 'display')

  const request = await requestReviewServingV4Rebuild({
    components: warningFilterEnrichmentComponents,
    priority: 500,
    projectId,
    reason: 'filterReadinessEnrichment',
  })
  const snapshots = await getSnapshots(projectId)
  const active = snapshots.find((snapshot) => {
    return snapshot.snapshotId === activeSnapshotId
  })
  const candidate = snapshots.find((snapshot) => {
    return snapshot.status === 'candidate'
  })
  const rebuiltComponents = (await getRequestChunks(request.requestId)).map((chunk) => {
    return chunk.component
  })

  expect(request.status).toBe('admitted')
  expect(active?.status).toBe('active')
  expect(candidate?.snapshotId).not.toBe(activeSnapshotId)
  expect(getListedComponents(candidate)).toEqual(getListedComponents(active))
  expect(rebuiltComponents).toContain('display')
  expect(rebuiltComponents).toContain('posting')
  expect(rebuiltComponents).toContain('judgmentInputContent')
})

test('a bootstrap that lands on the active snapshot id never reseeds the active snapshot', async () => {
  const {requestReviewServingV4Rebuild} = await loadService()
  const projectId = 'project-in-place-same-id'
  const requestEnrichment = () => {
    return requestReviewServingV4Rebuild({
      components: warningFilterEnrichmentComponents,
      priority: 500,
      projectId,
      reason: 'filterReadinessEnrichment',
    })
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

  const first = await requestEnrichment()
  const [built] = await getSnapshots(projectId)

  await completeRequestChunks(first.requestId)
  await finalizeRequest(first.requestId)
  await getDatabase().run(`
    UPDATE app.review_serving_snapshot_manifest
    SET snapshot_status = 'active', activated_at = current_timestamp
    WHERE snapshot_id = '${built?.snapshotId}'
  `)

  const activeBefore = await getActiveSnapshotRow()
  const repeated = await requestEnrichment()

  expect(repeated.status).toBe('completed')
  expect(repeated.diagnosticsJson).toMatchObject({
    inPlaceSnapshot: {alreadyServed: true, snapshotId: built?.snapshotId},
  })
  expect(await getActiveSnapshotRow()).toEqual(activeBefore)
  expect(await getSnapshots(projectId)).toHaveLength(1)

  await breakSnapshotComponent(built?.snapshotId ?? '', 'display')

  const rebuilt = await requestEnrichment()
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

test('dirty work joining an in-place train gets refresh chunks for components the train does not build', async () => {
  const {requestReviewServingV4Rebuild} = await loadService()
  const projectId = 'project-in-place-train-dirty-work'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [
    ...countReadyReviewServingComponents,
    'judgmentInputContent',
    'payload',
    'posting',
    'summary',
  ])
  const train = await requestReviewServingV4Rebuild({
    components: ['search'],
    priority: 75,
    projectId,
    reason: 'searchDirtyWork',
  })
  const getTrainComponentSet = async () => {
    const [row] = await getDatabase().queryJson<{componentSet: string}>(`
      SELECT json_extract(identity_json, '$.componentSet')::VARCHAR AS componentSet
      FROM app.review_rebuild_request
      WHERE request_id = '${train.requestId}'
    `)

    return (JSON.parse(row?.componentSet ?? '[]') as string[]).sort()
  }

  expect(await getTrainComponentSet()).toEqual(['search'])

  const judgmentInput = await requestReviewServingV4Rebuild({
    components: ['judgmentInputContent'],
    priority: 100,
    projectId,
    reason: 'judgmentInputContentDirtyWork',
  })
  const summary = await requestReviewServingV4Rebuild({
    components: ['summary'],
    priority: 50,
    projectId,
    reason: 'summaryDirtyWork',
  })

  expect(judgmentInput.requestId).toBe(train.requestId)
  expect(summary.requestId).toBe(train.requestId)
  expect(await getSnapshots(projectId)).toHaveLength(1)
  expect(await getRequestChunks(train.requestId)).toEqual([
    {
      component: 'judgmentInputContent',
      inputDigest: 'inPlaceReviewServingRefresh',
      snapshotId: activeSnapshotId,
      status: 'pending',
    },
    {component: 'search', inputDigest: 'inPlaceReviewServingAddition', snapshotId: activeSnapshotId, status: 'pending'},
    {component: 'summary', inputDigest: 'inPlaceReviewServingRefresh', snapshotId: activeSnapshotId, status: 'pending'},
  ])
  // The train's watermarks only cover the components it rebuilds, never the rest of the snapshot it builds into.
  expect(await getTrainComponentSet()).toEqual(['judgmentInputContent', 'search', 'summary'])
  expect(await getAvailableComponents(projectId, activeSnapshotId)).toEqual(
    getSortedComponents(...countReadyReviewServingComponents, 'judgmentInputContent', 'payload', 'posting', 'summary'),
  )

  // Enrichment the snapshot already serves needs nothing from the train and leaves its priority alone.
  const served = await requestReviewServingV4Rebuild({
    components: warningFilterEnrichmentComponents,
    priority: 500,
    projectId,
    reason: 'filterReadinessEnrichment',
  })
  const [trainRow] = await getDatabase().queryJson<{priority: number}>(`
    SELECT priority FROM app.review_rebuild_request WHERE request_id = '${train.requestId}'
  `)

  expect(served.status).toBe('completed')
  expect(served.diagnosticsJson).toMatchObject({inPlaceSnapshot: {alreadyServed: true, snapshotId: activeSnapshotId}})
  expect(Number(trainRow?.priority)).toBe(100)
})

test('a repair bootstrap neither joins nor is folded into an in-place train', async () => {
  const {coalesceReviewServingV4BootstrapTrains, requestReviewServingV4Rebuild} = await loadService()
  const projectId = 'project-in-place-train-repair'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [...countReadyReviewServingComponents])
  const train = await requestReviewServingV4Rebuild({
    components: ['search'],
    priority: 75,
    projectId,
    reason: 'searchDirtyWork',
  })

  await breakSnapshotComponent(activeSnapshotId, 'display')

  const repair = await requestReviewServingV4Rebuild({
    components: warningFilterEnrichmentComponents,
    priority: 500,
    projectId,
    reason: 'filterReadinessEnrichment',
  })
  const candidate = (await getSnapshots(projectId)).find((snapshot) => {
    return snapshot.status === 'candidate'
  })

  expect(repair.requestId).not.toBe(train.requestId)
  expect(candidate).toBeDefined()
  expect(
    (await getRequestChunks(repair.requestId)).some((chunk) => {
      return chunk.component === 'display' && chunk.snapshotId === candidate?.snapshotId
    }),
  ).toBe(true)

  // The active snapshot serves display again, so the in-place train would now answer the repair's components.
  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'completed', completed_at = current_timestamp
    WHERE snapshot_id = '${activeSnapshotId}' AND projection_component = 'display'
  `)

  const coalesced = await coalesceReviewServingV4BootstrapTrains({nowMs: Date.now() + 3_600_000, projectId})
  const requests = await getRequestRows(projectId)

  expect(coalesced).toEqual([])
  expect(
    requests
      .filter((request) => {
        return request.requestId === train.requestId || request.requestId === repair.requestId
      })
      .map((request) => {
        return request.status
      }),
  ).toEqual(['admitted', 'admitted'])
  expect(
    (await getSnapshots(projectId)).map((snapshot) => {
      return snapshot.status
    }),
  ).toEqual(['active', 'candidate'])
})

test('a listed component another request still builds is waited on, not rebuilt', async () => {
  const {requestReviewServingV4Rebuild} = await loadService()
  const projectId = 'project-in-place-building'
  const requestEnrichment = () => {
    return requestReviewServingV4Rebuild({
      components: warningFilterEnrichmentComponents,
      priority: 500,
      projectId,
      reason: 'filterReadinessEnrichment',
    })
  }

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [...countReadyReviewServingComponents])
  const enrichment = await requestEnrichment()

  // The enrichment's summary chunks failed and wait for readmission; the rest of its chunks completed.
  await completeRequestChunks(enrichment.requestId, ['payload', 'posting'])
  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'failed', last_error = 'transient'
    WHERE request_id = '${enrichment.requestId}' AND projection_component = 'summary'
  `)
  await getDatabase().run(`
    UPDATE app.review_rebuild_request
    SET status = 'failed', last_error = 'transient', failed_at = current_timestamp
    WHERE request_id = '${enrichment.requestId}'
  `)

  const waiting = await requestEnrichment()

  // The request it waits on is readmitted right away rather than once the project has no other admitted request.
  expect(waiting.requestId).toBe(enrichment.requestId)
  expect(waiting.status).toBe('admitted')
  expect(await getRequestRows(projectId)).toHaveLength(2)
  expect(await getSnapshots(projectId)).toHaveLength(1)

  // Once the enrichment can no longer finish its summary, the summary is rebuilt in place, and only it.
  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest
    SET status = 'quarantined'
    WHERE request_id = '${enrichment.requestId}' AND projection_component = 'summary'
  `)

  const rebuilt = await requestEnrichment()

  expect(rebuilt.requestId).not.toBe(enrichment.requestId)
  expect(rebuilt.status).toBe('admitted')
  expect(await getSnapshots(projectId)).toHaveLength(1)
  expect(await getRequestChunks(rebuilt.requestId)).toEqual([
    {component: 'summary', inputDigest: 'inPlaceReviewServingRefresh', snapshotId: activeSnapshotId, status: 'pending'},
  ])
})

test('summary dirty work rebuilds the served summary in place and serves the old one until the new one is published', async () => {
  const {requestReviewServingV4Rebuild, resetReviewServingV4DirtyWorkRequestReuseForTests} = await loadService()
  const projectId = 'project-in-place-summary-refresh'
  const requestSummaryDirtyWork = () => {
    return requestReviewServingV4Rebuild({components: ['summary'], priority: 50, projectId, reason: 'summaryDirtyWork'})
  }

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [
    ...countReadyReviewServingComponents,
    'judgmentInputContent',
    'payload',
    'posting',
    'summary',
  ])
  const [builtLedger] = await getLedgerBuckets(activeSnapshotId)
  const servedComponents = getSortedComponents(
    ...countReadyReviewServingComponents,
    'judgmentInputContent',
    'payload',
    'posting',
    'summary',
  )
  const request = await requestSummaryDirtyWork()

  expect(request.status).toBe('admitted')
  expect(await getSnapshots(projectId)).toHaveLength(1)
  expect(await getRequestChunks(request.requestId)).toEqual([
    {component: 'summary', inputDigest: 'inPlaceReviewServingRefresh', snapshotId: activeSnapshotId, status: 'pending'},
  ])
  expect(await getAvailableComponents(projectId, activeSnapshotId)).toEqual(servedComponents)
  expect((await requestSummaryDirtyWork()).requestId).toBe(request.requestId)

  await completeRequestChunks(request.requestId)
  resetReviewServingV4DirtyWorkRequestReuseForTests()

  // Its buckets still wait for publication, so a second summary build of the snapshot would drop them: it waits.
  expect((await requestSummaryDirtyWork()).requestId).toBe(request.requestId)
  expect(await getAvailableComponents(projectId, activeSnapshotId)).toEqual(servedComponents)
  expect(await getLedgerBuckets(activeSnapshotId)).toEqual(
    [
      {ledgerStatus: 'published', requestId: builtLedger?.requestId ?? ''},
      {ledgerStatus: 'building', requestId: request.requestId},
    ].sort((left, right) => {
      return left.requestId.localeCompare(right.requestId)
    }),
  )

  await finalizeRequest(request.requestId)

  expect(await getAvailableComponents(projectId, activeSnapshotId)).toEqual(servedComponents)
  expect(await getLedgerBuckets(activeSnapshotId)).toEqual([{ledgerStatus: 'published', requestId: request.requestId}])
  expect(await getSnapshots(projectId)).toHaveLength(1)
})

test('a rebuild of the active snapshot completes no dirty work when it is created, only once its chunks ran', async () => {
  const {resetReviewServingRebuiltDirtyWorkRetirementForTests, retireReviewServingDirtyWorkRebuiltByChunks} =
    await import('./reviewServingRebuiltDirtyWorkRetirement.ts')
  const projectId = 'project-in-place-dirty-work'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [...countReadyReviewServingComponents, 'payload'])

  // article-a's LLM status change is still pending; article-b's inputs were patched already.
  await upsertDirtyWork({
    articleId: 'article-a',
    components: ['llmStatus', 'posting'],
    projectId,
    sourceHighWaterMark: 5,
  })
  await upsertDirtyWork({articleId: 'article-b', components: ['posting'], projectId, sourceHighWaterMark: 6})
  await upsertDirtyWork({articleId: 'article-c', components: ['search'], projectId, sourceHighWaterMark: 7})
  await wakeProjector('posting', projectId)
  await wakeProjector('search', projectId)

  const [request] = (await getRequestRows(projectId)).filter((row) => {
    return row.reason === 'postingDirtyWork'
  })

  expect(await getSnapshots(projectId)).toHaveLength(1)
  expect(await getRequestChunks(request?.requestId ?? '')).toEqual([
    {
      component: 'posting',
      inputDigest: 'inPlaceReviewServingAddition',
      snapshotId: activeSnapshotId,
      status: 'pending',
    },
    {component: 'search', inputDigest: 'inPlaceReviewServingAddition', snapshotId: activeSnapshotId, status: 'pending'},
  ])
  // Nothing is completed because the rebuild will rewrite it: the snapshot is served meanwhile, and its rows (and
  // the inputs posting reads) only catch up as its chunks run. Posting claims patch incrementally instead.
  expect(await getDirtyWorkStatuses(projectId, 'posting')).toEqual([
    {articleId: 'article-a', status: 'pending'},
    {articleId: 'article-b', status: 'pending'},
  ])
  expect(await getDirtyWorkStatuses(projectId, 'search')).toEqual([{articleId: 'article-c', status: 'pending'}])

  await completeRequestChunks(request?.requestId ?? '')
  await wakeProjector('search', projectId)

  // The search chunk that started after article-c changed rebuilt it, so its claim completes instead of asking for
  // another rebuild; posting, read from the snapshot's own inputs, is left to its patches.
  expect(await getDirtyWorkStatuses(projectId, 'search')).toEqual([{articleId: 'article-c', status: 'completed'}])
  expect(
    (await getRequestRows(projectId)).filter((row) => {
      return row.reason.endsWith('DirtyWork')
    }),
  ).toHaveLength(1)

  resetReviewServingRebuiltDirtyWorkRetirementForTests()
  await retireReviewServingDirtyWorkRebuiltByChunks({nowMs: Date.now(), projectId})

  expect(await getDirtyWorkStatuses(projectId, 'posting')).toEqual([
    {articleId: 'article-a', status: 'pending'},
    {articleId: 'article-b', status: 'pending'},
  ])
})

test('a search claim is not completed by a chunk that ran before its article reached the project scope', async () => {
  const projectId = 'project-in-place-search-scope'

  await insertProject(projectId)
  await buildActiveSnapshot(projectId, [...countReadyReviewServingComponents])

  // article-a's search change arrived with a scope change that is still pending, so its chunk found no scope row.
  await upsertDirtyWork({
    articleId: 'article-a',
    components: ['projectScope', 'search'],
    projectId,
    sourceHighWaterMark: 5,
  })
  await upsertDirtyWork({articleId: 'article-b', components: ['search'], projectId, sourceHighWaterMark: 6})
  await wakeProjector('search', projectId)

  const [request] = (await getRequestRows(projectId)).filter((row) => {
    return row.reason === 'searchDirtyWork'
  })

  await completeRequestChunks(request?.requestId ?? '')
  await wakeProjector('search', projectId)

  expect(await getDirtyWorkStatuses(projectId, 'search')).toEqual([
    {articleId: 'article-a', status: 'pending'},
    {articleId: 'article-b', status: 'completed'},
  ])
  // article-a waits for its scope row instead of starting a rebuild that would read the same missing row again.
  expect(
    (await getRequestRows(projectId)).filter((row) => {
      return row.reason === 'searchDirtyWork'
    }),
  ).toHaveLength(1)
})

test('a candidate whose rebuild stopped for good does not keep chunk-rebuilt claims pending', async () => {
  const projectId = 'project-in-place-stopped-candidate'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [...countReadyReviewServingComponents])

  // A candidate of the same config that also lists search, whose train went terminal.
  await getDatabase().run(`
    INSERT INTO app.review_serving_snapshot_manifest (
      project_id, snapshot_id, snapshot_status, review_config_hash, composed_identity_json, component_state_json,
      required_components_json, optional_components_json, source_watermarks_json
    )
    SELECT project_id, 'snapshot-stopped-candidate', 'candidate', review_config_hash, '{}', '{"optional":[],"required":[]}',
      '[]', '["search"]', '{}'
    FROM app.review_serving_snapshot_manifest
    WHERE snapshot_id = '${activeSnapshotId}'
  `)
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_request (
      request_id, project_id, reason, requested_components_json, priority, status, admission_state
    ) VALUES ('rebuild:stopped-candidate', '${projectId}', 'searchDirtyWork', '["search"]', 75, 'failed', 'admitted')
  `)
  await getDatabase().run(`
    INSERT INTO app.review_rebuild_chunk_manifest (
      chunk_id, project_id, snapshot_id, request_id, projection_component, projection_identity, chunk_start_key,
      chunk_end_key, output_base_generation, status, admission_state
    ) VALUES (
      'chunk:stopped-candidate', '${projectId}', 'snapshot-stopped-candidate', 'rebuild:stopped-candidate', 'search',
      'search:stopped', 'a', 'z', 0, 'blocked_over_budget', 'admitted'
    )
  `)
  await upsertDirtyWork({articleId: 'article-a', components: ['search'], projectId, sourceHighWaterMark: 5})
  await wakeProjector('search', projectId)

  const [request] = (await getRequestRows(projectId)).filter((row) => {
    return row.reason === 'searchDirtyWork' && row.status === 'admitted'
  })

  await completeRequestChunks(request?.requestId ?? '')
  await wakeProjector('search', projectId)

  expect(await getDirtyWorkStatuses(projectId, 'search')).toEqual([{articleId: 'article-a', status: 'completed'}])
})

test('chunks of a snapshot of an older review config do not complete claims of the current one', async () => {
  const projectId = 'project-in-place-old-config'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [...countReadyReviewServingComponents])

  await upsertDirtyWork({articleId: 'article-a', components: ['search'], projectId, sourceHighWaterMark: 5})
  await wakeProjector('search', projectId)

  const [request] = (await getRequestRows(projectId)).filter((row) => {
    return row.reason === 'searchDirtyWork'
  })

  await completeRequestChunks(request?.requestId ?? '')
  // The review config changed meanwhile: the snapshot the chunks rebuilt is not what the project serves anymore.
  await getDatabase().run(`
    UPDATE app.review_serving_snapshot_manifest
    SET review_config_hash = 'review-config-before-edit'
    WHERE snapshot_id = '${activeSnapshotId}'
  `)
  await wakeProjector('search', projectId)

  // The claim is not taken as rebuilt: it asks for a rebuild, a fresh snapshot of the current config, which covers it.
  expect(
    (await getSnapshots(projectId)).map((snapshot) => {
      return snapshot.status
    }),
  ).toEqual(['active', 'candidate'])
  expect(await getDirtyWorkStatuses(projectId, 'search')).toEqual([{articleId: 'article-a', status: 'completed'}])
})

test('an in-place request whose snapshot was replaced does not cover claims either', async () => {
  const projectId = 'project-in-place-replaced'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [...countReadyReviewServingComponents])

  await upsertDirtyWork({articleId: 'article-a', components: ['search'], projectId, sourceHighWaterMark: 5})
  await wakeProjector('search', projectId)
  // Another snapshot replaced the one the in-place request builds; the still-admitted request is handed back.
  await getDatabase().run(`
    UPDATE app.review_serving_snapshot_manifest SET snapshot_status = 'retired' WHERE snapshot_id = '${activeSnapshotId}'
  `)
  await wakeProjector('search', projectId)

  expect(await getDirtyWorkStatuses(projectId, 'search')).toEqual([{articleId: 'article-a', status: 'pending'}])
})

test('components an in-place request added stay unavailable when that request is cancelled', async () => {
  const {requestReviewServingV4Rebuild} = await loadService()
  const projectId = 'project-in-place-cancelled'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [...countReadyReviewServingComponents])
  const request = await requestReviewServingV4Rebuild({
    components: ['search'],
    priority: 75,
    projectId,
    reason: 'searchDirtyWork',
  })

  // Cancelled the way coalescing cancels requests: the request and its unfinished chunks.
  await getDatabase().run(
    `UPDATE app.review_rebuild_request SET status = 'cancelled' WHERE request_id = '${request.requestId}'`,
  )
  await getDatabase().run(`
    UPDATE app.review_rebuild_chunk_manifest SET status = 'failed' WHERE request_id = '${request.requestId}'
  `)

  expect(getListedComponents((await getSnapshots(projectId))[0])).toContain('search')
  expect(await getAvailableComponents(projectId, activeSnapshotId)).toEqual(
    getSortedComponents(...countReadyReviewServingComponents),
  )
})

test('project-wide dirty work takes a fresh snapshot, whose request covers it', async () => {
  const projectId = 'project-fresh-for-project-wide'

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [...countReadyReviewServingComponents, 'search'])

  await upsertProjectDirtyWork({
    changeKind: 'project.searchTokenizer.updated',
    components: ['search'],
    projectId,
    values: {tokenizerVersion: 'tokenizer-v2'},
  })
  await wakeProjector('search', projectId)

  const snapshots = await getSnapshots(projectId)
  const candidate = snapshots.find((snapshot) => {
    return snapshot.status === 'candidate'
  })
  const [request] = (await getRequestRows(projectId)).filter((row) => {
    return row.reason === 'searchDirtyWork'
  })

  expect(
    snapshots.find((snapshot) => {
      return snapshot.snapshotId === activeSnapshotId
    })?.status,
  ).toBe('active')
  expect(candidate).toBeDefined()
  expect(
    (await getRequestChunks(request?.requestId ?? '')).every((chunk) => {
      return chunk.snapshotId === candidate?.snapshotId && chunk.inputDigest === 'freshReviewServingSnapshot'
    }),
  ).toBe(true)
  expect(await getDirtyWorkStatuses(projectId, 'search')).toEqual([{articleId: null, status: 'completed'}])
})

test('a train that already rebuilt a component neither takes new dirty work of it nor keeps it from being rebuilt', async () => {
  const {requestReviewServingV4Rebuild, resetReviewServingV4DirtyWorkRequestReuseForTests} = await loadService()
  const projectId = 'project-in-place-finished-component'
  const requestPostingDirtyWork = () => {
    return requestReviewServingV4Rebuild({components: ['posting'], priority: 60, projectId, reason: 'postingDirtyWork'})
  }

  await insertProject(projectId)

  const activeSnapshotId = await buildActiveSnapshot(projectId, [
    ...countReadyReviewServingComponents,
    'payload',
    'posting',
  ])
  const train = await requestReviewServingV4Rebuild({
    components: ['search'],
    priority: 75,
    projectId,
    reason: 'searchDirtyWork',
  })
  const joined = await requestPostingDirtyWork()

  expect(joined.requestId).toBe(train.requestId)

  await completeRequestChunks(train.requestId, ['posting'])
  // The next dirty-work request comes after the short window in which the same open request is handed back.
  resetReviewServingV4DirtyWorkRequestReuseForTests()

  const rebuilt = await requestPostingDirtyWork()

  expect(rebuilt.requestId).not.toBe(train.requestId)
  expect(await getSnapshots(projectId)).toHaveLength(1)
  expect(await getRequestChunks(rebuilt.requestId)).toEqual([
    {component: 'posting', inputDigest: 'inPlaceReviewServingRefresh', snapshotId: activeSnapshotId, status: 'pending'},
  ])
})

test('repeated dirty-work requests hand back the open request without planning again for a short while', async () => {
  const {requestReviewServingV4RebuildEffect} = await loadService()
  const {Effect} = await import('effect')
  const projectId = 'project-in-place-reuse'
  let queryCount = 0
  const countingDatabase = {
    queryJson: <T>(statement: string, workloadContext?: never) => {
      queryCount += 1

      return getDatabase().queryJson<T>(statement, workloadContext)
    },
    run: (statement: string, workloadContext?: never) => {
      return getDatabase().run(statement, workloadContext)
    },
    transaction: <T>(operation: (tx: never) => Promise<T>, workloadContext?: never) => {
      return getDatabase().transaction(operation as never, workloadContext)
    },
  }
  const requestSearchDirtyWork = async () => {
    queryCount = 0
    const request = await Effect.runPromise(
      requestReviewServingV4RebuildEffect(
        {components: ['search'], priority: 75, projectId, reason: 'searchDirtyWork'},
        countingDatabase as never,
      ),
    )

    return {queryCount, requestId: request.requestId}
  }

  await insertProject(projectId)
  await buildActiveSnapshot(projectId, [...countReadyReviewServingComponents])

  const first = await requestSearchDirtyWork()
  const repeated = await requestSearchDirtyWork()

  expect(repeated).toEqual({queryCount: 1, requestId: first.requestId})

  // A request that is no longer open is never handed back: it is re-read, and the planner runs again.
  await getDatabase().run(
    `UPDATE app.review_rebuild_request SET status = 'failed' WHERE request_id = '${first.requestId}'`,
  )

  expect((await requestSearchDirtyWork()).queryCount).toBeGreaterThan(1)

  await completeRequestChunks(first.requestId)

  const afterCompletion = await requestSearchDirtyWork()

  expect(afterCompletion.queryCount).toBeGreaterThan(1)
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
