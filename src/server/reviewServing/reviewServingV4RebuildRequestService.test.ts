import {expect, test} from 'bun:test'
import {Effect} from 'effect'

import type {ReviewServingChunkManifestRepositoryDatabase} from './reviewServingChunkManifestRepository.ts'
import {requestReviewServingV4RebuildEffect} from './reviewServingV4RebuildRequestService.ts'

type FakeStats = {
  enabledPromptCount: number
  humanJudgmentCount: number
  humanJudgmentUpdatedAt: string | null
  judgmentCount: number
  judgmentUpdatedAt: string | null
  modelExecutionIdentityDigest: string | null
  modelUpdatedAt: string | null
  patchPromptUpdatedAt: string | null
  promptCount: number
  promptIdentityDigest: string | null
  promptUpdatedAt: string | null
  providerConnectionUpdatedAt: string | null
  projectArticleUpdatedAt: string | null
  projectPromptUpdatedAt: string | null
  projectUpdatedAt: string
  scopedArticleCount: number
  snapshotCount: number
  snapshotUpdatedAt: string | null
  summaryHumanJudgmentCount: number
  summaryHumanJudgmentUpdatedAt: string | null
}

type FakeRequestRow = {
  admissionState: 'admitted' | 'blocked_over_budget' | 'pending'
  admittedAt: string | null
  completedAt: string | null
  createdAt: string
  diagnosticsJson: unknown
  failedAt: string | null
  identityJson: unknown
  lastError: string | null
  leaseExpiresAt: string | null
  leaseOwner: string | null
  oomCategory: string | null
  overBudgetReason: string | null
  priority: number
  projectId: string
  reason: string
  requestedComponentsJson: unknown
  requestId: string
  retryAfter: string | null
  retryCount: number
  retryPolicyJson: unknown
  sourceWatermarksJson: unknown
  status: 'admitted' | 'blocked_over_budget' | 'running'
  updatedAt: string
}

type FakeProjectionManifestRow = {
  baseGeneration: number
  definitionVersion: string
  inputDigest: string | null
  inputWatermark: number
  inputWatermarksJson: unknown
  invalidationReason: string | null
  manifestId: string
  patchRangeEnd: number | null
  patchRangeStart: number | null
  patchWatermark: number
  projectId: string
  projectionComponent: string
  projectionIdentity: string
  promptConfigHash: string | null
  reviewConfigHash: string | null
  status: 'candidate'
}

type FakeDirtyWatermark = {latestSourceHighWaterMark: number; sourcePartition: string}

type FakeRequestDatabaseOptions = {dirtyWatermarks?: readonly FakeDirtyWatermark[]}

const getSqlStrings = (statement: string) => {
  return [...statement.matchAll(/'((?:''|[^'])*)'/g)].map((match) => {
    return match[1]?.replaceAll("''", "'") ?? ''
  })
}

const baseStats = {
  enabledPromptCount: 2,
  humanJudgmentCount: 8,
  humanJudgmentUpdatedAt: '2026-06-20T10:03:00.000Z',
  judgmentCount: 12,
  judgmentUpdatedAt: '2026-06-20T10:02:00.000Z',
  modelExecutionIdentityDigest: 'model-execution-digest-v1',
  modelUpdatedAt: '2026-06-20T10:01:45.000Z',
  patchPromptUpdatedAt: '2026-06-20T10:01:50.000Z',
  promptCount: 2,
  promptIdentityDigest: 'prompt-digest-v1',
  promptUpdatedAt: '2026-06-20T10:01:30.000Z',
  providerConnectionUpdatedAt: '2026-06-20T10:01:40.000Z',
  projectArticleUpdatedAt: '2026-06-20T10:00:00.000Z',
  projectPromptUpdatedAt: '2026-06-20T10:01:00.000Z',
  projectUpdatedAt: '2026-06-20T09:59:00.000Z',
  scopedArticleCount: 10,
  snapshotCount: 1,
  snapshotUpdatedAt: '2026-06-20T10:03:45.000Z',
  summaryHumanJudgmentCount: 3,
  summaryHumanJudgmentUpdatedAt: '2026-06-20T10:03:30.000Z',
} satisfies FakeStats

const fakeRebuildComponents = [
  'projectScope',
  'selectedImport',
  'display',
  'judgmentInputContent',
  'llmStatus',
  'humanStatus',
  'queue',
  'posting',
  'summary',
  'payload',
  'search',
] as const

const createFakeRequestDatabase = (stats: FakeStats, options: FakeRequestDatabaseOptions = {}) => {
  const requests = new Map<string, FakeRequestRow>()
  const projectionManifests = new Map<string, FakeProjectionManifestRow>()
  const statements: string[] = []
  const componentStateJson = {
    optional: [],
    required: fakeRebuildComponents.map((component) => {
      return {baseGeneration: 2, component, patchWatermark: 10, projectionIdentity: `${component}:identity-1`}
    }),
  }

  const run = async (statement: string) => {
    statements.push(statement)

    if (statement.includes('INSERT INTO app.review_projection_identity_manifest')) {
      const strings = getSqlStrings(statement)
      const manifestId = strings[0] ?? ''
      const component = strings[2] ?? 'projectScope'

      projectionManifests.set(manifestId, {
        baseGeneration: 0,
        definitionVersion: strings[6] ?? `${component}:dirty-claim-seed-v1`,
        inputDigest: strings[5] ?? null,
        inputWatermark: 0,
        inputWatermarksJson: strings[4] ?? '{}',
        invalidationReason: strings[9] ?? null,
        manifestId,
        patchRangeEnd: 0,
        patchRangeStart: 0,
        patchWatermark: 0,
        projectId: strings[1] ?? 'project-v4',
        projectionComponent: component,
        projectionIdentity: strings[3] ?? `${component}:identity-1`,
        promptConfigHash: null,
        reviewConfigHash: null,
        status: 'candidate',
      })
    }

    if (!statement.includes('INSERT INTO app.review_rebuild_request')) {
      return
    }

    const strings = getSqlStrings(statement)
    const requestId = strings[0] ?? ''
    const status = (strings[6] ?? 'admitted') as FakeRequestRow['status']
    const admissionState = (strings[7] ?? 'admitted') as FakeRequestRow['admissionState']
    const overBudgetReason = status === 'blocked_over_budget' ? (strings[10] ?? 'over budget') : null

    requests.set(requestId, {
      admissionState,
      admittedAt: status === 'admitted' ? '2026-06-20T10:04:00.000Z' : null,
      completedAt: null,
      createdAt: '2026-06-20T10:04:00.000Z',
      diagnosticsJson: strings[11] ?? '{}',
      failedAt: null,
      identityJson: strings[5] ?? '{}',
      lastError: null,
      leaseExpiresAt: null,
      leaseOwner: null,
      oomCategory: status === 'blocked_over_budget' ? 'request_over_budget' : null,
      overBudgetReason,
      priority: 100,
      projectId: strings[1] ?? '',
      reason: strings[2] ?? '',
      requestedComponentsJson: strings[3] ?? '[]',
      requestId,
      retryAfter: null,
      retryCount: 0,
      retryPolicyJson: strings[8] ?? '{}',
      sourceWatermarksJson: strings[4] ?? '{}',
      status,
      updatedAt: '2026-06-20T10:04:00.000Z',
    })
  }

  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('WITH project_settings')) {
      return [stats] as T[]
    }

    if (statement.includes('FROM app.project_article')) {
      return [
        {chunkEndKey: 'article-z', chunkStartKey: 'article-a', scopedArticleCount: stats.scopedArticleCount},
      ] as T[]
    }

    if (statement.includes('FROM app.review_serving_dirty_work')) {
      return (options.dirtyWatermarks ?? []) as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      return [{componentStateJson}] as T[]
    }

    if (statement.includes('FROM app.review_projection_identity_manifest')) {
      if (statement.includes('WHERE manifest_id =')) {
        const manifestId = getSqlStrings(statement)[0] ?? ''
        const manifest = projectionManifests.get(manifestId)

        return (manifest === undefined ? [] : [manifest]) as T[]
      }

      return fakeRebuildComponents.map((component) => {
        return {
          baseGeneration: 2,
          inputDigest: `${component}-digest-v1`,
          inputWatermark: 10,
          projectionComponent: component,
          projectionIdentity: `${component}:identity-1`,
        }
      }) as T[]
    }

    if (statement.includes('FROM app.review_rebuild_request')) {
      if (statement.includes("status = 'admitted'") || statement.includes("status IN ('admitted', 'running')")) {
        const strings = getSqlStrings(statement)
        const projectId = strings[0] ?? ''
        const reasonFilter = statement.includes('AND reason =') ? strings[1] : undefined
        const allowedStatuses = statement.includes("status IN ('admitted', 'running')")
          ? ['admitted', 'running']
          : ['admitted']
        const activeRequest = Array.from(requests.values()).find((request) => {
          return (
            request.projectId === projectId
            && allowedStatuses.includes(request.status)
            && request.admissionState === 'admitted'
            && (reasonFilter === undefined || request.reason === reasonFilter)
          )
        })

        return (activeRequest === undefined ? [] : [activeRequest]) as T[]
      }

      const requestId = getSqlStrings(statement)[0] ?? ''
      const request = requests.get(requestId)

      return (request === undefined ? [] : [request]) as T[]
    }

    return [] as T[]
  }
  const database = {
    queryJson,
    run,
    transaction: async <T>(operation: (tx: {queryJson: typeof queryJson; run: typeof run}) => Promise<T>) => {
      return operation({queryJson, run})
    },
  } satisfies ReviewServingChunkManifestRepositoryDatabase

  const setRequestStatus = (requestId: string, status: FakeRequestRow['status']) => {
    const request = requests.get(requestId)

    if (!request) {
      throw new Error(`Expected fake rebuild request ${requestId} to exist`)
    }

    requests.set(requestId, {...request, status})
  }

  return {database, setRequestStatus, statements}
}

test('V4 rebuild request service estimates admission budget from project data', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 4,
    humanJudgmentCount: 2_000,
    judgmentCount: 5_000,
    promptCount: 4,
    scopedArticleCount: 100_000,
    summaryHumanJudgmentCount: 1_000,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary', 'payload'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )
  const joined = statements.join('\n')

  expect(request.status).toBe('blocked_over_budget')
  expect(request.overBudgetReason).toContain('input rows')
  expect(request.sourceWatermarksJson).toMatchObject({
    modelExecution: {
      identityDigest: 'model-execution-digest-v1',
      modelUpdatedAt: '2026-06-20T10:01:45.000Z',
      providerConnectionUpdatedAt: '2026-06-20T10:01:40.000Z',
    },
    projectArticles: {count: 100_000, updatedAt: '2026-06-20T10:00:00.000Z'},
    projectPrompts: {
      count: 4,
      enabledCount: 4,
      patchUpdatedAt: '2026-06-20T10:01:50.000Z',
      updatedAt: '2026-06-20T10:01:00.000Z',
    },
    prompts: {count: 4, identityDigest: 'prompt-digest-v1', updatedAt: '2026-06-20T10:01:30.000Z'},
    snapshots: {count: 1, updatedAt: '2026-06-20T10:03:45.000Z'},
    summaryHumanJudgments: {count: 1_000, updatedAt: '2026-06-20T10:03:30.000Z'},
  })
  expect(joined).toContain('FROM app.project_import_route')
  expect(joined).toContain('INNER JOIN app.article_import_route')
  expect(joined).toContain('scoped_article_id AS')
  expect(joined).toContain('SELECT DISTINCT article_id')
  expect(joined).toContain('LEFT JOIN app.model model ON model.id = project.model_id')
  expect(joined).toContain('LEFT JOIN app.provider_connection provider_connection')
  expect(joined).toContain('model_execution_identity_digest')
  expect(joined).toContain('rebuild_prompt_source AS')
  expect(joined).toContain('FROM mart.review_llm_status_patch_v4 llm')
  expect(joined).toContain('FROM mart.review_human_status_patch_v4 human')
  expect(joined).toContain('FROM rebuild_prompt')
  expect(joined).toContain('INNER JOIN scoped_article_id ON scoped_article_id.article_id = judgment.article_id')
  expect(joined).not.toContain('INNER JOIN scoped_article ON scoped_article.article_id = judgment.article_id')
  expect(joined).toContain('INNER JOIN rebuild_prompt ON rebuild_prompt.prompt_id = judgment.prompt_id')
  expect(joined).toContain('INNER JOIN rebuild_prompt ON rebuild_prompt.prompt_id = human.prompt_id')
  expect(joined).toContain('INNER JOIN scoped_article_id ON scoped_article_id.article_id = human.article_id')
  expect(joined).toContain('INNER JOIN app.prompt prompt ON prompt.id = project_prompt.prompt_id')
  expect(joined).toContain('AND COALESCE(prompt.archived, FALSE) = FALSE')
  expect(joined).toContain('COALESCE(prompt.content_hash, sha256(prompt.original_text))')
  expect(joined).toContain("snapshot.snapshot_status IN ('candidate', 'active')")
  expect(joined).toContain('judgment.model_id = project.model_id')
  expect(joined).not.toContain('judgment.project_id = project.id')
  expect(joined).toContain('judgment.use_fulltext_no_images = project.use_fulltext_no_images')
  expect(joined).toContain('FROM app.judgment_human_summary')
})

test('V4 rebuild request service bootstraps explicit chunks when a project has no snapshot yet', async () => {
  const {database, statements} = createFakeRequestDatabase({...baseStats, snapshotCount: 0, snapshotUpdatedAt: null})

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const joined = statements.join('\n')

  expect(request.status).toBe('admitted')
  expect(request.requestedComponents).toEqual([...fakeRebuildComponents])
  expect(joined).toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).toContain('INSERT INTO app.review_serving_snapshot_manifest')
  expect(joined).toContain('INSERT INTO app.review_rebuild_chunk_manifest')
  expect(joined).toContain("'projectScope'")
  expect(joined).toContain("'selectedImport'")
  expect(joined).toContain("'search'")
  expect(joined).toContain('snapshot:')
  expect(joined).toContain('freshReviewServingSnapshot')
})

test('V4 rebuild request service keeps selected-import bootstrap chunks on import watermarks', async () => {
  const {database, statements} = createFakeRequestDatabase(
    {...baseStats, snapshotCount: 0, snapshotUpdatedAt: null},
    {
      dirtyWatermarks: [
        {latestSourceHighWaterMark: 4, sourcePartition: 'importRunArticle:project-v4'},
        {latestSourceHighWaterMark: 10, sourcePartition: 'reviewChange:project-v4'},
      ],
    },
  )

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const selectedImportChunk = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'selectedImport'")
  })
  const projectScopeChunk = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'projectScope'")
  })

  expect(request.status).toBe('admitted')
  expect(selectedImportChunk).toMatch(
    /'selectedImport',\s*'[^']+',\s*'freshReviewServingSnapshot',\s*4,\s*'article-a'/u,
  )
  expect(projectScopeChunk).toMatch(/'projectScope',\s*'[^']+',\s*'freshReviewServingSnapshot',\s*10,\s*'article-a'/u)
})

test('V4 missing snapshot rebuild requests reuse active admitted work', async () => {
  const {database, statements} = createFakeRequestDatabase({...baseStats, snapshotCount: 0, snapshotUpdatedAt: null})

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const secondRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const rebuildRequestInsertCount = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_request')
  }).length

  expect(secondRequest.requestId).toBe(firstRequest.requestId)
  expect(rebuildRequestInsertCount).toBe(1)
})

test('V4 missing snapshot rebuild requests do not reuse running active work', async () => {
  const {database, setRequestStatus, statements} = createFakeRequestDatabase({
    ...baseStats,
    snapshotCount: 0,
    snapshotUpdatedAt: null,
  })

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  setRequestStatus(firstRequest.requestId, 'running')
  const secondRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const rebuildRequestInsertCount = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_request')
  }).length

  expect(secondRequest.status).toBe('admitted')
  expect(rebuildRequestInsertCount).toBe(2)
})

test('V4 missing snapshot rebuild requests do not reuse unrelated active work', async () => {
  const {database, statements} = createFakeRequestDatabase({...baseStats, snapshotCount: 0, snapshotUpdatedAt: null})

  const unrelatedRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )
  const missingSnapshotRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const rebuildRequestInsertCount = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_request')
  }).length

  expect(missingSnapshotRequest.requestId).not.toBe(unrelatedRequest.requestId)
  expect(missingSnapshotRequest.reason).toBe('missingReviewServingSnapshot')
  expect(rebuildRequestInsertCount).toBe(2)
})

test('V4 rebuild request service does not seed candidate state for over-budget bootstraps', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 0,
    scopedArticleCount: 100_000,
    snapshotCount: 0,
    snapshotUpdatedAt: null,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect({projectId: 'project-v4', reason: 'missingReviewServingSnapshot'}, database),
  )
  const joined = statements.join('\n')

  expect(request.status).toBe('blocked_over_budget')
  expect(joined).toContain('INSERT INTO app.review_rebuild_chunk_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_snapshot_manifest')
})

test('V4 rebuild request service accounts for list-mode fan-out in admission budgets', async () => {
  const {database} = createFakeRequestDatabase({
    ...baseStats,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 0,
    scopedArticleCount: 100_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['display'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  expect(request.status).toBe('blocked_over_budget')
  expect(request.overBudgetReason).toBe('input rows: estimated 400000 > max 250000')
})

test('V4 rebuild request service estimates status rebuild rows from written list modes', async () => {
  const {database} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 2,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 2,
    scopedArticleCount: 30_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['llmStatus'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  expect(request.status).toBe('admitted')
  expect(request.overBudgetReason).toBeNull()
})

test('V4 rebuild request service includes synthetic summary prompt rows in human status estimates', async () => {
  const {database} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 1,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 1,
    scopedArticleCount: 100_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['humanStatus'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  expect(request.status).toBe('blocked_over_budget')
  expect(request.overBudgetReason).toBe('input rows: estimated 400000 > max 250000')
})

test('V4 rebuild request service includes selected-import posting facets in admission budgets', async () => {
  const {database} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 0,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 0,
    scopedArticleCount: 40_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['posting'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  expect(request.status).toBe('blocked_over_budget')
  expect(request.overBudgetReason).toBe('input rows: estimated 640000 > max 250000')
})

test('V4 rebuild request service includes placeholder detail rows in payload bytes', async () => {
  const {database} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 7,
    humanJudgmentCount: 0,
    judgmentCount: 0,
    promptCount: 7,
    scopedArticleCount: 10_000,
    summaryHumanJudgmentCount: 0,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {
        components: ['judgmentInputContent', 'payload'],
        projectId: 'project-v4',
        reason: 'requestReviewServingLargeRebuild',
      },
      database,
    ),
  )

  expect(request.status).toBe('blocked_over_budget')
  expect(request.overBudgetReason).toBe('payload bytes: estimated 76800000 > max 67108864')
})

test('V4 rebuild request service scales admission estimates by queued snapshots', async () => {
  const {database} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 1,
    humanJudgmentCount: 2,
    judgmentCount: 4,
    scopedArticleCount: 10,
    snapshotCount: 2,
    summaryHumanJudgmentCount: 1,
  })

  const request = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary', 'payload'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      database,
    ),
  )

  expect(request.status).toBe('blocked_over_budget')
  expect(request.overBudgetReason).toBe('snapshot count: estimated 2 > max 1')
})

test('V4 rebuild request service watermarks make changed data produce a new request id', async () => {
  const first = createFakeRequestDatabase(baseStats)
  const second = createFakeRequestDatabase({...baseStats, summaryHumanJudgmentUpdatedAt: '2026-06-20T11:00:00.000Z'})

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      first.database,
    ),
  )
  const secondRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      second.database,
    ),
  )

  expect(firstRequest.requestId).not.toBe(secondRequest.requestId)
})

test('V4 rebuild request service prompt watermarks make changed prompt identity produce a new request id', async () => {
  const first = createFakeRequestDatabase(baseStats)
  const second = createFakeRequestDatabase({...baseStats, promptIdentityDigest: 'prompt-digest-v2'})

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      first.database,
    ),
  )
  const secondRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      second.database,
    ),
  )

  expect(firstRequest.requestId).not.toBe(secondRequest.requestId)
})

test('V4 rebuild request service model watermarks make changed execution identity produce a new request id', async () => {
  const first = createFakeRequestDatabase(baseStats)
  const second = createFakeRequestDatabase({...baseStats, modelExecutionIdentityDigest: 'model-execution-digest-v2'})

  const firstRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      first.database,
    ),
  )
  const secondRequest = await Effect.runPromise(
    requestReviewServingV4RebuildEffect(
      {components: ['summary'], projectId: 'project-v4', reason: 'requestReviewServingLargeRebuild'},
      second.database,
    ),
  )

  expect(firstRequest.requestId).not.toBe(secondRequest.requestId)
})
