import {expect, test} from 'bun:test'

import type {
  ReviewServingChunkManifestRepositoryDatabase,
  ReviewServingChunkManifestRepositoryTransaction,
} from './reviewServingChunkManifestRepository.ts'
import {
  boostActiveReviewServingRebuildRequestForProject,
  boostReviewServingRebuildRequestPriority,
  createReviewServingRebuildRequest,
  type ReviewServingRebuildRequestStatus,
} from './reviewServingRebuildRequestRepository.ts'

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
  status: ReviewServingRebuildRequestStatus
  updatedAt: string
}

type FakeProjectionManifestRow = {
  baseGeneration: number
  inputDigest: string | null
  inputWatermark: number
  projectionComponent: string
  projectionIdentity: string
}

type FakeRequestDatabaseOptions = {
  activeComponentStateJson?: unknown
  articleRangeRows?: Array<{chunkEndKey: string; chunkStartKey: string; scopedArticleCount: number}>
  componentStateJson?: unknown
  projectionManifestRows?: readonly FakeProjectionManifestRow[]
}

const getSqlStrings = (statement: string) => {
  return [...statement.matchAll(/'((?:''|[^'])*)'/g)].map((match) => {
    return match[1]?.replaceAll("''", "'") ?? ''
  })
}

const getClock = (statements: readonly string[]) => {
  return new Date(2026, 5, 23, 16, statements.length).toISOString()
}

const getThrownError = async (run: () => Promise<unknown>): Promise<Error> => {
  return run().then(
    () => {
      return new Error('Expected operation to throw')
    },
    (error: unknown) => {
      return error instanceof Error ? error : new Error(String(error))
    },
  )
}

const createFakeRequestDatabase = (options: FakeRequestDatabaseOptions = {}) => {
  const requests = new Map<string, FakeRequestRow>()
  const statements: string[] = []
  const componentStateJson = options.componentStateJson ?? {
    optional: [{baseGeneration: 3, component: 'search', patchWatermark: 11, projectionIdentity: 'search:identity-1'}],
    required: [
      {baseGeneration: 2, component: 'display', patchWatermark: 10, projectionIdentity: 'display:identity-1'},
      {baseGeneration: 2, component: 'payload', patchWatermark: 10, projectionIdentity: 'payload:identity-1'},
      {baseGeneration: 2, component: 'summary', patchWatermark: 10, projectionIdentity: 'summary:identity-1'},
    ],
  }
  const activeComponentStateJson = options.activeComponentStateJson ?? {
    optional: [],
    required: [
      {baseGeneration: 4, component: 'payload', patchWatermark: 12, projectionIdentity: 'payload:active-identity-1'},
      {baseGeneration: 4, component: 'summary', patchWatermark: 12, projectionIdentity: 'summary:active-identity-1'},
    ],
  }
  const projectionManifestRows = options.projectionManifestRows ?? [
    {
      baseGeneration: 2,
      inputDigest: 'display-digest-v1',
      inputWatermark: 10,
      projectionComponent: 'display',
      projectionIdentity: 'display:identity-1',
    },
    {
      baseGeneration: 2,
      inputDigest: 'payload-digest-v1',
      inputWatermark: 10,
      projectionComponent: 'payload',
      projectionIdentity: 'payload:identity-1',
    },
    {
      baseGeneration: 2,
      inputDigest: 'summary-digest-v1',
      inputWatermark: 10,
      projectionComponent: 'summary',
      projectionIdentity: 'summary:identity-1',
    },
    {
      baseGeneration: 4,
      inputDigest: 'payload-active-digest-v1',
      inputWatermark: 12,
      projectionComponent: 'payload',
      projectionIdentity: 'payload:active-identity-1',
    },
    {
      baseGeneration: 4,
      inputDigest: 'summary-active-digest-v1',
      inputWatermark: 12,
      projectionComponent: 'summary',
      projectionIdentity: 'summary:active-identity-1',
    },
    {
      baseGeneration: 3,
      inputDigest: 'search-digest-v1',
      inputWatermark: 11,
      projectionComponent: 'search',
      projectionIdentity: 'search:identity-1',
    },
  ]

  const run = async (statement: string) => {
    statements.push(statement)

    if (!statement.includes('INSERT INTO app.review_rebuild_request')) {
      return
    }

    const strings = getSqlStrings(statement)
    const requestId = strings[0] ?? ''
    const status = (strings[6] ?? 'admitted') as ReviewServingRebuildRequestStatus
    const admissionState = (strings[7] ?? 'admitted') as FakeRequestRow['admissionState']
    const overBudgetReason = status === 'blocked_over_budget' ? (strings[10] ?? 'over budget') : null

    requests.set(requestId, {
      admissionState,
      admittedAt: status === 'admitted' ? getClock(statements) : null,
      completedAt: null,
      createdAt: getClock(statements),
      diagnosticsJson: strings[11] ?? '{}',
      failedAt: null,
      identityJson: strings[5] ?? '{}',
      lastError: null,
      leaseExpiresAt: null,
      leaseOwner: null,
      oomCategory: status === 'blocked_over_budget' ? 'request_over_budget' : null,
      overBudgetReason,
      priority: Number(statement.match(/,\s*(\d+),\s*'admitted'/u)?.[1] ?? 100),
      projectId: strings[1] ?? '',
      reason: strings[2] ?? '',
      requestedComponentsJson: strings[3] ?? '[]',
      requestId,
      retryAfter: null,
      retryCount: 0,
      retryPolicyJson: strings[8] ?? '{}',
      sourceWatermarksJson: strings[4] ?? '{}',
      status,
      updatedAt: getClock(statements),
    })
  }

  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('NTILE')) {
      return (options.articleRangeRows ?? [
        {chunkEndKey: 'article-m', chunkStartKey: 'article-a', scopedArticleCount: 2},
        {chunkEndKey: 'article-z', chunkStartKey: 'article-m', scopedArticleCount: 1},
      ]) as T[]
    }

    if (statement.includes('FROM app.project_article')) {
      return [{chunkEndKey: 'article-z', chunkStartKey: 'article-a', scopedArticleCount: 3}] as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      return [{componentStateJson}, {componentStateJson: activeComponentStateJson}] as T[]
    }

    if (statement.includes('FROM app.review_projection_identity_manifest')) {
      return projectionManifestRows as T[]
    }

    if (statement.includes('FROM app.review_rebuild_request')) {
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

  return {database, statements}
}

test('V4 rebuild requests admit budgeted component chunks above the chunk manifest table', async () => {
  const {database, statements} = createFakeRequestDatabase()

  const request = await createReviewServingRebuildRequest(
    {
      budget: {maxInputRows: 1_000, maxOutputBytes: 100_000, maxTempBytes: 0},
      chunks: [
        {
          chunkEndKey: 'article:010',
          chunkStartKey: 'article:001',
          inputDigest: 'digest-v1',
          inputWatermark: 5,
          outputBaseGeneration: 1,
          projectId: 'project-v4',
          projectionComponent: 'summary',
          projectionIdentity: 'summary:v1',
        },
      ],
      estimate: {estimatedInputRows: 100, estimatedOutputBytes: 20_000, estimatedTempBytes: 0},
      identity: {reviewConfigHash: 'config-v1'},
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['summary'],
      requestId: 'rebuild:admitted',
      sourceWatermarks: {reviewChange: 5},
    },
    database,
  )

  expect(request).toMatchObject({
    admissionState: 'admitted',
    projectId: 'project-v4',
    reason: 'requestReviewServingLargeRebuild',
    requestId: 'rebuild:admitted',
    requestedComponents: ['summary'],
    status: 'admitted',
  })
  expect(statements.join('\n')).toContain('INSERT INTO app.review_rebuild_request')
  expect(statements.join('\n')).toContain('INSERT INTO app.review_rebuild_chunk_manifest')
  expect(statements.join('\n')).toContain("'rebuild:admitted'")
  expect(statements.join('\n')).toContain("'admitted'")
})

test('V4 rebuild request re-admission does not delete obsolete running chunks', async () => {
  const {database, statements} = createFakeRequestDatabase()

  await createReviewServingRebuildRequest(
    {
      chunks: [
        {
          chunkEndKey: 'article:010',
          chunkStartKey: 'article:001',
          inputDigest: 'digest-v1',
          inputWatermark: 5,
          outputBaseGeneration: 1,
          projectId: 'project-v4',
          projectionComponent: 'summary',
          projectionIdentity: 'summary:v1',
        },
      ],
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['summary'],
      requestId: 'rebuild:readmitted-running',
    },
    database,
  )

  expect(statements.join('\n')).toContain('DELETE FROM app.review_rebuild_chunk_manifest')
  expect(statements.join('\n')).toContain("AND status <> 'running'")
})

test('V4 rebuild request re-admission clears terminal request metadata', async () => {
  const {database, statements} = createFakeRequestDatabase()

  await createReviewServingRebuildRequest(
    {
      chunks: [
        {
          chunkEndKey: 'article:010',
          chunkStartKey: 'article:001',
          inputDigest: 'digest-v1',
          inputWatermark: 5,
          outputBaseGeneration: 1,
          projectId: 'project-v4',
          projectionComponent: 'selectedImport',
          projectionIdentity: 'selectedImport:v1',
        },
      ],
      projectId: 'project-v4',
      reason: 'missingReviewServingSnapshot',
      requestedComponents: ['selectedImport'],
      requestId: 'rebuild:readmitted-failed',
    },
    database,
  )

  const joined = statements.join('\n')

  expect(joined).toContain('ON CONFLICT(request_id) DO UPDATE SET')
  expect(joined).toContain('retry_count = 0')
  expect(joined).toContain('lease_owner = NULL')
  expect(joined).toContain('lease_expires_at = NULL')
  expect(joined).toContain('completed_at = NULL')
  expect(joined).toContain('failed_at = NULL')
  expect(joined).toContain('last_error = NULL')
})

test('boosting rebuild request priority refreshes update time for diagnostics ordering', async () => {
  const {database, statements} = createFakeRequestDatabase()

  await boostReviewServingRebuildRequestPriority({priority: 500, requestId: 'rebuild:boosted'}, database)

  const joined = statements.join('\n')

  expect(joined).toContain('UPDATE app.review_rebuild_request')
  expect(joined).toContain('WHEN priority < 500 THEN 500')
  expect(joined).toContain('updated_at = current_timestamp')
  expect(joined).toContain('AND priority <= 500')
})

test('boosting an active project rebuild request uses a lightweight foreground update', async () => {
  const statements: string[] = []
  const database: ReviewServingChunkManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_request')) {
        return [{requestId: 'rebuild:active-project'}] as T[]
      }

      return statement.includes('FROM app.review_rebuild_chunk_manifest')
        ? ([{blockedCount: 0, progressableCount: 1}] as T[])
        : ([] as T[])
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(
      operation: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<T>,
    ): Promise<T> => {
      return operation(database)
    },
  }

  const boosted = await boostActiveReviewServingRebuildRequestForProject(
    {priority: 10_000, projectId: 'project-v4', reason: 'missingReviewServingSnapshot'},
    database,
  )
  const joined = statements.join('\n')

  expect(boosted).toBe(true)
  expect(statements).toHaveLength(3)
  expect(statements[0]).toContain('SELECT request_id AS requestId')
  expect(statements[0]).toContain('FROM app.review_rebuild_request')
  expect(statements[0]).toContain("project_id = 'project-v4'")
  expect(statements[0]).toContain("AND reason = 'missingReviewServingSnapshot'")
  expect(statements[0]).not.toContain('review_rebuild_chunk_manifest')
  expect(statements[0]).not.toContain('UPDATE app.review_rebuild_request')
  expect(statements[1]).toContain("FILTER (WHERE status IN ('blocked_over_budget', 'quarantined'))")
  expect(statements[1]).toContain("FILTER (WHERE status IN ('pending', 'running', 'failed'))")
  expect(statements[1]).toContain('FROM app.review_rebuild_chunk_manifest')
  expect(statements[1]).toContain("request_id = 'rebuild:active-project'")
  expect(statements[2]).toContain('UPDATE app.review_rebuild_request')
  expect(statements[2]).toContain("WHERE request_id = 'rebuild:active-project'")
  expect(joined).toContain('UPDATE app.review_rebuild_request')
  expect(joined).toContain('WHEN priority < 10000 THEN 10000')
  expect(joined).toContain('updated_at = current_timestamp')
  expect(joined).not.toContain('RETURNING request_id AS requestId')
  expect(joined).not.toContain('WHERE request_id = (')
})

test('boosting an active project rebuild request ignores completed-only admitted requests', async () => {
  const statements: string[] = []
  const database: ReviewServingChunkManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_rebuild_request')) {
        return [{requestId: 'rebuild:completed-only'}] as T[]
      }

      return statement.includes('FROM app.review_rebuild_chunk_manifest')
        ? ([{blockedCount: 0, progressableCount: 0}] as T[])
        : ([] as T[])
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
    transaction: async <T>(
      operation: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<T>,
    ): Promise<T> => {
      return operation(database)
    },
  }

  const boosted = await boostActiveReviewServingRebuildRequestForProject(
    {priority: 10_000, projectId: 'project-v4', reason: 'missingReviewServingSnapshot'},
    database,
  )

  expect(boosted).toBe(false)
  expect(statements).toHaveLength(2)
  expect(statements.join('\n')).not.toContain('UPDATE app.review_rebuild_request')
})

test('over-budget V4 rebuild requests park before their chunks can be claimable', async () => {
  const {database, statements} = createFakeRequestDatabase()

  const request = await createReviewServingRebuildRequest(
    {
      budget: {maxInputRows: 10, maxOutputBytes: 1_000},
      estimate: {estimatedInputRows: 99, estimatedOutputBytes: 500},
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['payload'],
      requestId: 'rebuild:blocked',
    },
    database,
  )

  expect(request).toMatchObject({
    admissionState: 'blocked_over_budget',
    oomCategory: 'request_over_budget',
    requestId: 'rebuild:blocked',
    status: 'blocked_over_budget',
  })
  expect(request.overBudgetReason).toContain('input rows')
  expect(statements.join('\n')).toContain("'blocked_over_budget'")
  expect(statements.join('\n')).toContain("'request_over_budget'")
})

test('default rebuild request chunks use existing projection identities and real article bounds', async () => {
  const {database, statements} = createFakeRequestDatabase({
    articleRangeRows: [
      {chunkEndKey: 'article-f', chunkStartKey: 'article-a', scopedArticleCount: 512},
      {chunkEndKey: 'article-m', chunkStartKey: 'article-f ', scopedArticleCount: 512},
      {chunkEndKey: 'article-t', chunkStartKey: 'article-m ', scopedArticleCount: 512},
      {chunkEndKey: 'article-z', chunkStartKey: 'article-t ', scopedArticleCount: 512},
    ],
  })

  const request = await createReviewServingRebuildRequest(
    {
      estimate: {estimatedInputRows: 2_048},
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['summary', 'payload'],
      requestId: 'rebuild:default-identities',
    },
    database,
  )
  const joined = statements.join('\n')

  expect(request).toMatchObject({requestId: 'rebuild:default-identities', status: 'admitted'})
  expect(joined).toContain('FROM app.project_article')
  expect(joined).toContain('FROM app.project_import_route')
  expect(joined).toContain('INNER JOIN app.article_import_route')
  expect(joined).toContain('FROM app.review_serving_snapshot_manifest')
  expect(joined).toContain('FROM app.review_projection_identity_manifest')
  expect(joined).toContain("'article-a'")
  expect(joined).toContain("'article-z'")
  expect(joined).toContain("'summary:identity-1'")
  expect(joined).toContain("'payload:identity-1'")
  expect(joined).toContain("'summary:active-identity-1'")
  expect(joined).toContain("'payload:active-identity-1'")
  expect(joined).toContain('NTILE(4)')
  expect(joined).toContain("'article-f '")
  expect(
    statements.filter((statement) => {
      return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'summary'")
    }),
  ).toHaveLength(8)
  expect(
    statements.filter((statement) => {
      return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'payload'")
    }),
  ).toHaveLength(2)
  expect(joined).not.toContain('component:all')
  expect(joined).not.toContain(':request:rebuild:default-identities')
})

test('search-only default rebuild presplit chunks preserve sparse article-id gap coverage', async () => {
  const {database, statements} = createFakeRequestDatabase({
    articleRangeRows: [
      {chunkEndKey: 'article-001', chunkStartKey: 'article-001', scopedArticleCount: 1},
      {chunkEndKey: 'article-100', chunkStartKey: 'article-001', scopedArticleCount: 1},
    ],
  })

  await createReviewServingRebuildRequest(
    {
      estimate: {estimatedInputRows: 100_001},
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['search'],
      requestId: 'rebuild:search-presplit-gaps',
    },
    database,
  )

  const joined = statements.join('\n')

  expect(joined).toContain("ELSE previous_scoped_end_key || ' '")
  expect(joined).toContain('LAG(scoped_end_key) OVER (ORDER BY chunk_index) AS previous_scoped_end_key')
  expect(joined).toContain(')\n    SELECT')
  expect(joined).toContain("'article-001'")
  expect(joined).toContain("'article-100'")
  expect(joined).toContain('"admissionPresplit":true')
  expect(joined).toContain('"admissionPlan"')
})

test('search-only default rebuild admission compares per-chunk budget after presplit', async () => {
  const {database, statements} = createFakeRequestDatabase({
    articleRangeRows: [
      {chunkEndKey: 'article-050', chunkStartKey: 'article-001', scopedArticleCount: 50},
      {chunkEndKey: 'article-100', chunkStartKey: 'article-050', scopedArticleCount: 50},
      {chunkEndKey: 'article-150', chunkStartKey: 'article-100', scopedArticleCount: 50},
      {chunkEndKey: 'article-200', chunkStartKey: 'article-150', scopedArticleCount: 50},
    ],
  })

  const request = await createReviewServingRebuildRequest(
    {
      budget: {maxInputRows: 250_000, maxOutputBytes: 128 * 1024 * 1024},
      estimate: {estimatedInputRows: 544_684, estimatedOutputBytes: 544_684 * 512},
      projectId: 'project-v4',
      reason: 'broadSearchDirtyWork',
      requestedComponents: ['search'],
      requestId: 'rebuild:search-budget-presplit',
    },
    database,
  )
  const joined = statements.join('\n')

  expect(request).toMatchObject({
    admissionState: 'admitted',
    overBudgetReason: null,
    requestId: 'rebuild:search-budget-presplit',
    status: 'admitted',
  })
  expect(joined).toContain('"admissionPresplit":true')
  expect(joined).toContain('"inputRowLimit":50000')
  expect(joined).toContain("'admitted'")
  expect(joined).toContain('136171')
  expect(joined).toContain('250000')
})

test('posting default rebuilds presplit into non-overlapping bounded chunks', async () => {
  const {database, statements} = createFakeRequestDatabase({
    activeComponentStateJson: {
      optional: [],
      required: [
        {baseGeneration: 4, component: 'posting', patchWatermark: 12, projectionIdentity: 'posting:active-identity-1'},
      ],
    },
    articleRangeRows: [
      {chunkEndKey: 'article-064', chunkStartKey: 'article-001', scopedArticleCount: 64},
      {chunkEndKey: 'article-128', chunkStartKey: 'article-064', scopedArticleCount: 64},
      {chunkEndKey: 'article-192', chunkStartKey: 'article-128', scopedArticleCount: 64},
      {chunkEndKey: 'article-256', chunkStartKey: 'article-192', scopedArticleCount: 64},
    ],
    componentStateJson: {
      optional: [],
      required: [
        {baseGeneration: 2, component: 'posting', patchWatermark: 10, projectionIdentity: 'posting:identity-1'},
      ],
    },
    projectionManifestRows: [
      {
        baseGeneration: 2,
        inputDigest: 'posting-digest-v1',
        inputWatermark: 10,
        projectionComponent: 'posting',
        projectionIdentity: 'posting:identity-1',
      },
      {
        baseGeneration: 4,
        inputDigest: 'posting-active-digest-v1',
        inputWatermark: 12,
        projectionComponent: 'posting',
        projectionIdentity: 'posting:active-identity-1',
      },
    ],
  })

  await createReviewServingRebuildRequest(
    {
      estimate: {estimatedInputRows: 2_048},
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['posting'],
      requestId: 'rebuild:posting-presplit',
    },
    database,
  )

  const joined = statements.join('\n')
  const postingChunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'posting'")
  })

  expect(joined).toContain('NTILE(4)')
  expect(joined).toContain("ELSE previous_scoped_end_key || ' '")
  expect(postingChunkInserts).toHaveLength(8)
  expect(joined).toContain('"admissionPresplit":true')
  expect(joined).toContain('"coalescingCandidate":true')
  expect(joined).toContain('"inputRowLimit":512')
})

test('human status default rebuilds presplit into bounded article chunks', async () => {
  const {database, statements} = createFakeRequestDatabase({
    activeComponentStateJson: {
      optional: [],
      required: [
        {
          baseGeneration: 4,
          component: 'humanStatus',
          patchWatermark: 12,
          projectionIdentity: 'humanStatus:active-identity-1',
        },
      ],
    },
    articleRangeRows: [
      {chunkEndKey: 'article-064', chunkStartKey: 'article-001', scopedArticleCount: 64},
      {chunkEndKey: 'article-128', chunkStartKey: 'article-064', scopedArticleCount: 64},
      {chunkEndKey: 'article-192', chunkStartKey: 'article-128', scopedArticleCount: 64},
      {chunkEndKey: 'article-256', chunkStartKey: 'article-192', scopedArticleCount: 64},
    ],
    componentStateJson: {
      optional: [],
      required: [
        {baseGeneration: 2, component: 'humanStatus', patchWatermark: 10, projectionIdentity: 'humanStatus:identity-1'},
      ],
    },
    projectionManifestRows: [
      {
        baseGeneration: 2,
        inputDigest: 'human-status-digest-v1',
        inputWatermark: 10,
        projectionComponent: 'humanStatus',
        projectionIdentity: 'humanStatus:identity-1',
      },
      {
        baseGeneration: 4,
        inputDigest: 'human-status-active-digest-v1',
        inputWatermark: 12,
        projectionComponent: 'humanStatus',
        projectionIdentity: 'humanStatus:active-identity-1',
      },
    ],
  })

  await createReviewServingRebuildRequest(
    {
      estimate: {estimatedInputRows: 256},
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['humanStatus'],
      requestId: 'rebuild:human-status-presplit',
    },
    database,
  )

  const joined = statements.join('\n')
  const humanStatusChunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'humanStatus'")
  })

  expect(joined).toContain('NTILE(4)')
  expect(joined).toContain("ELSE previous_scoped_end_key || ' '")
  expect(humanStatusChunkInserts).toHaveLength(8)
  expect(joined).toContain('"admissionPresplit":true')
})

test('judgment input content default rebuilds avoid admission presplit boundary overlap', async () => {
  const {database, statements} = createFakeRequestDatabase({
    activeComponentStateJson: {
      optional: [],
      required: [
        {
          baseGeneration: 4,
          component: 'judgmentInputContent',
          patchWatermark: 12,
          projectionIdentity: 'judgmentInputContent:active-identity-1',
        },
      ],
    },
    articleRangeRows: [
      {chunkEndKey: 'article-064', chunkStartKey: 'article-001', scopedArticleCount: 64},
      {chunkEndKey: 'article-128', chunkStartKey: 'article-064', scopedArticleCount: 64},
      {chunkEndKey: 'article-192', chunkStartKey: 'article-128', scopedArticleCount: 64},
      {chunkEndKey: 'article-256', chunkStartKey: 'article-192', scopedArticleCount: 64},
    ],
    componentStateJson: {
      optional: [],
      required: [
        {
          baseGeneration: 2,
          component: 'judgmentInputContent',
          patchWatermark: 10,
          projectionIdentity: 'judgmentInputContent:identity-1',
        },
      ],
    },
    projectionManifestRows: [
      {
        baseGeneration: 2,
        inputDigest: 'judgment-input-content-digest-v1',
        inputWatermark: 10,
        projectionComponent: 'judgmentInputContent',
        projectionIdentity: 'judgmentInputContent:identity-1',
      },
      {
        baseGeneration: 4,
        inputDigest: 'judgment-input-content-active-digest-v1',
        inputWatermark: 12,
        projectionComponent: 'judgmentInputContent',
        projectionIdentity: 'judgmentInputContent:active-identity-1',
      },
    ],
  })

  await createReviewServingRebuildRequest(
    {
      estimate: {estimatedInputRows: 20_001},
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['judgmentInputContent'],
      requestId: 'rebuild:judgment-input-content-presplit',
    },
    database,
  )

  const joined = statements.join('\n')
  const chunkInserts = statements.filter((statement) => {
    return (
      statement.includes('INSERT INTO app.review_rebuild_chunk_manifest')
      && statement.includes("'judgmentInputContent'")
    )
  })

  expect(joined).not.toContain('NTILE(')
  expect(chunkInserts).toHaveLength(2)
  expect(joined).not.toContain('"admissionPresplit":true')
})

test('queue default rebuilds avoid admission presplit boundary overlap', async () => {
  const {database, statements} = createFakeRequestDatabase({
    activeComponentStateJson: {
      optional: [],
      required: [
        {baseGeneration: 4, component: 'queue', patchWatermark: 12, projectionIdentity: 'queue:active-identity-1'},
      ],
    },
    articleRangeRows: [
      {chunkEndKey: 'article-064', chunkStartKey: 'article-001', scopedArticleCount: 64},
      {chunkEndKey: 'article-128', chunkStartKey: 'article-064', scopedArticleCount: 64},
      {chunkEndKey: 'article-192', chunkStartKey: 'article-128', scopedArticleCount: 64},
      {chunkEndKey: 'article-256', chunkStartKey: 'article-192', scopedArticleCount: 64},
    ],
    componentStateJson: {
      optional: [],
      required: [{baseGeneration: 2, component: 'queue', patchWatermark: 10, projectionIdentity: 'queue:identity-1'}],
    },
    projectionManifestRows: [
      {
        baseGeneration: 2,
        inputDigest: 'queue-digest-v1',
        inputWatermark: 10,
        projectionComponent: 'queue',
        projectionIdentity: 'queue:identity-1',
      },
      {
        baseGeneration: 4,
        inputDigest: 'queue-active-digest-v1',
        inputWatermark: 12,
        projectionComponent: 'queue',
        projectionIdentity: 'queue:active-identity-1',
      },
    ],
  })

  await createReviewServingRebuildRequest(
    {
      estimate: {estimatedInputRows: 20_001},
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['queue'],
      requestId: 'rebuild:queue-presplit',
    },
    database,
  )

  const joined = statements.join('\n')
  const chunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'queue'")
  })

  expect(joined).not.toContain('NTILE(')
  expect(chunkInserts).toHaveLength(2)
  expect(joined).not.toContain('"admissionPresplit":true')
})

test('display-only default rebuilds avoid admission presplit boundary overlap', async () => {
  const {database, statements} = createFakeRequestDatabase({
    articleRangeRows: [
      {chunkEndKey: 'article-064', chunkStartKey: 'article-001', scopedArticleCount: 64},
      {chunkEndKey: 'article-128', chunkStartKey: 'article-064', scopedArticleCount: 64},
      {chunkEndKey: 'article-192', chunkStartKey: 'article-128', scopedArticleCount: 64},
      {chunkEndKey: 'article-256', chunkStartKey: 'article-192', scopedArticleCount: 64},
    ],
  })

  await createReviewServingRebuildRequest(
    {
      estimate: {estimatedInputRows: 100_001},
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['display'],
      requestId: 'rebuild:display-presplit',
    },
    database,
  )

  const joined = statements.join('\n')
  const displayChunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'display'")
  })

  expect(joined).not.toContain('NTILE(')
  expect(displayChunkInserts).toHaveLength(1)
  expect(joined).not.toContain('"admissionPresplit":true')
})

test('project-scope-only default rebuilds avoid admission presplit boundary overlap', async () => {
  const {database, statements} = createFakeRequestDatabase({
    articleRangeRows: [
      {chunkEndKey: 'article-064', chunkStartKey: 'article-001', scopedArticleCount: 64},
      {chunkEndKey: 'article-128', chunkStartKey: 'article-064', scopedArticleCount: 64},
      {chunkEndKey: 'article-192', chunkStartKey: 'article-128', scopedArticleCount: 64},
      {chunkEndKey: 'article-256', chunkStartKey: 'article-192', scopedArticleCount: 64},
    ],
    componentStateJson: {
      optional: [],
      required: [
        {
          baseGeneration: 2,
          component: 'projectScope',
          patchWatermark: 10,
          projectionIdentity: 'projectScope:identity-1',
        },
      ],
    },
    projectionManifestRows: [
      {
        baseGeneration: 2,
        inputDigest: 'project-scope-digest-v1',
        inputWatermark: 10,
        projectionComponent: 'projectScope',
        projectionIdentity: 'projectScope:identity-1',
      },
    ],
  })

  await createReviewServingRebuildRequest(
    {
      estimate: {estimatedInputRows: 100_001},
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['projectScope'],
      requestId: 'rebuild:project-scope-presplit',
    },
    database,
  )

  const joined = statements.join('\n')
  const projectScopeChunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'projectScope'")
  })

  expect(joined).not.toContain('NTILE(')
  expect(projectScopeChunkInserts).toHaveLength(1)
  expect(joined).not.toContain('"admissionPresplit":true')
})

test('summary-only default rebuilds presplit into non-overlapping bounded chunks', async () => {
  const {database, statements} = createFakeRequestDatabase({
    articleRangeRows: [
      {chunkEndKey: 'article-064', chunkStartKey: 'article-001', scopedArticleCount: 64},
      {chunkEndKey: 'article-128', chunkStartKey: 'article-064', scopedArticleCount: 64},
      {chunkEndKey: 'article-192', chunkStartKey: 'article-128', scopedArticleCount: 64},
      {chunkEndKey: 'article-256', chunkStartKey: 'article-192', scopedArticleCount: 64},
    ],
  })

  await createReviewServingRebuildRequest(
    {
      estimate: {estimatedInputRows: 2_048},
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['summary'],
      requestId: 'rebuild:summary-presplit',
    },
    database,
  )

  const joined = statements.join('\n')
  const summaryChunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'summary'")
  })

  expect(joined).toContain('NTILE(4)')
  expect(joined).toContain("ELSE previous_scoped_end_key || ' '")
  expect(summaryChunkInserts).toHaveLength(8)
  expect(joined).toContain('"admissionPresplit":true')
  expect(joined).toContain('"component":"summary"')
})

test('selected-import-only default rebuilds avoid admission presplit boundary overlap', async () => {
  const {database, statements} = createFakeRequestDatabase({
    activeComponentStateJson: {
      optional: [],
      required: [
        {
          baseGeneration: 4,
          component: 'selectedImport',
          patchWatermark: 12,
          projectionIdentity: 'selectedImport:active-identity-1',
        },
      ],
    },
    articleRangeRows: [
      {chunkEndKey: 'article-064', chunkStartKey: 'article-001', scopedArticleCount: 64},
      {chunkEndKey: 'article-128', chunkStartKey: 'article-064', scopedArticleCount: 64},
      {chunkEndKey: 'article-192', chunkStartKey: 'article-128', scopedArticleCount: 64},
      {chunkEndKey: 'article-256', chunkStartKey: 'article-192', scopedArticleCount: 64},
    ],
    componentStateJson: {
      optional: [],
      required: [
        {
          baseGeneration: 2,
          component: 'selectedImport',
          patchWatermark: 10,
          projectionIdentity: 'selectedImport:identity-1',
        },
      ],
    },
    projectionManifestRows: [
      {
        baseGeneration: 2,
        inputDigest: 'selected-import-digest-v1',
        inputWatermark: 10,
        projectionComponent: 'selectedImport',
        projectionIdentity: 'selectedImport:identity-1',
      },
      {
        baseGeneration: 4,
        inputDigest: 'selected-import-active-digest-v1',
        inputWatermark: 12,
        projectionComponent: 'selectedImport',
        projectionIdentity: 'selectedImport:active-identity-1',
      },
    ],
  })

  await createReviewServingRebuildRequest(
    {
      estimate: {estimatedInputRows: 100_001},
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['selectedImport'],
      requestId: 'rebuild:selected-import-presplit',
    },
    database,
  )

  const joined = statements.join('\n')
  const selectedImportChunkInserts = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_chunk_manifest') && statement.includes("'selectedImport'")
  })

  expect(joined).not.toContain('NTILE(')
  expect(selectedImportChunkInserts).toHaveLength(2)
  expect(joined).not.toContain('"admissionPresplit":true')
})

test('default rebuild request keeps same projection identity across base generations', async () => {
  const {database, statements} = createFakeRequestDatabase({
    activeComponentStateJson: {
      optional: [],
      required: [
        {baseGeneration: 4, component: 'payload', patchWatermark: 12, projectionIdentity: 'payload:stable-identity'},
      ],
    },
    componentStateJson: {
      optional: [],
      required: [
        {baseGeneration: 2, component: 'payload', patchWatermark: 10, projectionIdentity: 'payload:stable-identity'},
      ],
    },
    projectionManifestRows: [
      {
        baseGeneration: 4,
        inputDigest: 'payload-active-digest-v1',
        inputWatermark: 12,
        projectionComponent: 'payload',
        projectionIdentity: 'payload:stable-identity',
      },
      {
        baseGeneration: 2,
        inputDigest: 'payload-candidate-digest-v1',
        inputWatermark: 10,
        projectionComponent: 'payload',
        projectionIdentity: 'payload:stable-identity',
      },
    ],
  })

  await createReviewServingRebuildRequest(
    {
      projectId: 'project-v4',
      reason: 'requestReviewServingLargeRebuild',
      requestedComponents: ['payload'],
      requestId: 'rebuild:stable-identity-generations',
    },
    database,
  )

  const joined = statements.join('\n')
  const identityOccurrences = joined.match(/'payload:stable-identity'/g) ?? []

  expect(identityOccurrences).toHaveLength(2)
  expect(joined).toContain("'payload-active-digest-v1'")
  expect(joined).toContain("'payload-candidate-digest-v1'")
})

test('default rebuild request rejects partial chunk expansion', async () => {
  const {database, statements} = createFakeRequestDatabase({
    projectionManifestRows: [
      {
        baseGeneration: 2,
        inputDigest: 'display-digest-v1',
        inputWatermark: 10,
        projectionComponent: 'display',
        projectionIdentity: 'display:identity-1',
      },
    ],
  })

  const error = await getThrownError(() => {
    return createReviewServingRebuildRequest(
      {
        projectId: 'project-v4',
        reason: 'requestReviewServingLargeRebuild',
        requestedComponents: ['display', 'payload'],
        requestId: 'rebuild:partial-chunks',
      },
      database,
    )
  })

  expect(error.message).toContain('skipped requested rebuild components')
  expect(error.message).toContain('payload')
  expect(statements.join('\n')).toContain('FROM app.review_projection_identity_manifest')
  expect(statements.join('\n')).not.toContain('INSERT INTO app.review_rebuild_request')
  expect(statements.join('\n')).not.toContain('INSERT INTO app.review_rebuild_chunk_manifest')
})
