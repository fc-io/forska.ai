import {expect, test} from 'bun:test'

import type {
  ReviewServingChunkManifestRepositoryDatabase,
  ReviewServingChunkManifestRepositoryTransaction,
} from './reviewServingChunkManifestRepository.ts'
import {
  boostActiveReviewServingRebuildRequestForProject,
  boostReviewServingRebuildRequestPriority,
  createReviewServingRebuildRequest,
  releaseFailedRequestlessReviewServingRebuildChunks,
  terminalizeStaleZeroChunkReviewServingRebuildRequest,
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

type FakeReleaseChunkRow = {
  actualInputRows: number | null
  admissionState: 'admitted' | 'blocked_over_budget' | 'pending'
  chunkId: string
  completedAt: string | null
  diagnosticsJson: unknown
  lastError: string | null
  leaseExpiresAt: string | null
  leaseOwner: string | null
  projectId: string
  projectionComponent: string
  requestId: string | null
  retryAfter: string | null
  retryCount: number
  startedAt: string | null
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked_over_budget' | 'quarantined'
  updatedAt: string
}

const safeFailedRequestlessReleaseStatuses = new Set(['pending', 'running', 'completed', 'failed'])

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
      if (statement.includes('SELECT request.request_id AS requestId') && getSqlStrings(statement).length === 0) {
        return [...requests.values()].map((request) => ({requestId: request.requestId})) as T[]
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

  return {database, statements}
}

const createFakeTerminalizationRequest = (overrides: Partial<FakeRequestRow> = {}): FakeRequestRow => {
  return {
    admissionState: 'admitted',
    admittedAt: '2026-06-23T14:00:00.000Z',
    completedAt: null,
    createdAt: '2026-06-23T14:00:00.000Z',
    diagnosticsJson: '{}',
    failedAt: null,
    identityJson: '{}',
    lastError: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    oomCategory: null,
    overBudgetReason: null,
    priority: 100,
    projectId: 'project-v4',
    reason: 'requestReviewServingLargeRebuild',
    requestedComponentsJson: '["summary"]',
    requestId: 'rebuild:zero-chunk',
    retryAfter: null,
    retryCount: 0,
    retryPolicyJson: '{}',
    sourceWatermarksJson: '{}',
    status: 'admitted',
    updatedAt: '2026-06-23T14:00:00.000Z',
    ...overrides,
  }
}

const createFakeTerminalizationDatabase = (input: {chunkCount?: number; request?: FakeRequestRow | null}) => {
  const statements: string[] = []
  let request = input.request === undefined ? createFakeTerminalizationRequest() : input.request
  const chunkCount = input.chunkCount ?? 0
  const terminalizationLastError =
    'Operator terminalized stale malformed V4 review rebuild request: admitted/running request has no rebuild chunks; no cleanup authorized.'

  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('FROM app.review_rebuild_chunk_manifest') && statement.includes('COUNT(*)')) {
      return [{chunkCount}] as T[]
    }

    if (statement.includes('FROM app.review_rebuild_request')) {
      const requestId = getSqlStrings(statement)[0] ?? ''

      return (request === null || request.requestId !== requestId ? [] : [request]) as T[]
    }

    return [] as T[]
  }

  const run = async (statement: string) => {
    statements.push(statement)

    if (
      request !== null
      && statement.includes('UPDATE app.review_rebuild_request')
      && request.projectId === 'project-v4'
      && request.admissionState === 'admitted'
      && (request.status === 'admitted' || request.status === 'running')
      && request.leaseOwner === null
      && request.leaseExpiresAt === null
      && chunkCount === 0
    ) {
      request = {
        ...request,
        failedAt: '2026-06-23T16:00:00.000Z',
        lastError: terminalizationLastError,
        leaseExpiresAt: null,
        leaseOwner: null,
        status: 'failed',
        updatedAt: '2026-06-23T16:00:00.000Z',
      }
    }
  }

  const database = {
    queryJson,
    run,
    transaction: async <T>(operation: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<T>) => {
      return operation({queryJson, run})
    },
  } satisfies ReviewServingChunkManifestRepositoryDatabase

  return {database, getRequest: () => request, statements}
}

const createFakeReleaseRequestlessChunksDatabase = (input: {
  chunks?: readonly FakeReleaseChunkRow[]
  request?: FakeRequestRow | null
}) => {
  const statements: string[] = []
  const chunks = new Map<string, FakeReleaseChunkRow>()
  let request =
    input.request === undefined
      ? createFakeTerminalizationRequest({
          failedAt: '2026-06-23T15:00:00.000Z',
          requestId: 'requestless-bootstrap:release-safe',
          status: 'failed',
        })
      : input.request

  for (const chunk of input.chunks ?? []) {
    chunks.set(chunk.chunkId, chunk)
  }

  const getRequestChunks = () => {
    const requestId = getSqlStrings(statements.at(-1) ?? '')[0] ?? request?.requestId ?? ''

    return [...chunks.values()].filter((chunk) => {
      return chunk.requestId === requestId
    })
  }

  const queryJson = async <T>(statement: string) => {
    statements.push(statement)

    if (statement.includes('UPDATE app.review_rebuild_chunk_manifest') && statement.includes('RETURNING')) {
      const strings = getSqlStrings(statement)
      const requestId =
        strings.find((value) => {
          return value.startsWith('requestless-bootstrap:') || value.startsWith('requestless-summary:')
        }) ?? ''
      const projectId =
        strings.find((value) => {
          return value.startsWith('project-')
        }) ?? ''
      const canReleaseRequest =
        request !== null
        && request.requestId === requestId
        && request.projectId === projectId
        && request.status === 'failed'
        && request.admissionState === 'admitted'
        && request.leaseOwner === null
        && request.leaseExpiresAt === null
        && (request.requestId.startsWith('requestless-bootstrap:')
          || request.requestId.startsWith('requestless-summary:'))
      const released = canReleaseRequest
        ? [...chunks.values()].filter((chunk) => {
            return (
              chunk.requestId === requestId
              && chunk.projectId === projectId
              && chunk.leaseOwner === null
              && chunk.leaseExpiresAt === null
            )
          })
        : []

      for (const chunk of released) {
        chunks.set(chunk.chunkId, {
          ...chunk,
          actualInputRows: null,
          admissionState: 'admitted',
          completedAt: null,
          diagnosticsJson: null,
          lastError: null,
          leaseExpiresAt: null,
          leaseOwner: null,
          requestId: null,
          retryAfter: null,
          retryCount: 0,
          startedAt: null,
          status: 'pending',
          updatedAt: '2026-06-23T16:00:00.000Z',
        })
      }

      return released.map((chunk) => {
        return {chunkId: chunk.chunkId}
      }) as T[]
    }

    if (statement.includes('FROM app.review_rebuild_chunk_manifest') && statement.includes('GROUP BY')) {
      const grouped = new Map<
        string,
        {admissionState: string; chunkCount: number; projectionComponent: string; status: string}
      >()

      for (const chunk of getRequestChunks()) {
        const key = `${chunk.status}\0${chunk.projectionComponent}\0${chunk.admissionState}`
        const existing = grouped.get(key)

        grouped.set(key, {
          admissionState: chunk.admissionState,
          chunkCount: (existing?.chunkCount ?? 0) + 1,
          projectionComponent: chunk.projectionComponent,
          status: chunk.status,
        })
      }

      return [...grouped.values()] as T[]
    }

    if (statement.includes('FROM app.review_rebuild_chunk_manifest') && statement.includes('LIMIT 20')) {
      return getRequestChunks()
        .toSorted((left, right) => {
          return left.updatedAt.localeCompare(right.updatedAt) || left.chunkId.localeCompare(right.chunkId)
        })
        .slice(0, 20)
        .map((chunk) => {
          return {chunkId: chunk.chunkId}
        }) as T[]
    }

    if (
      statement.includes('FROM app.review_rebuild_chunk_manifest')
      && statement.includes('affectedCount')
      && statement.includes('liveLeaseCount')
    ) {
      const projectId = getSqlStrings(statement)[0] ?? ''
      const requestId = getSqlStrings(statement).at(-1) ?? ''
      const requestChunks = [...chunks.values()].filter((chunk) => {
        return chunk.requestId === requestId
      })

      return [
        {
          affectedCount: requestChunks.length,
          liveLeaseCount: requestChunks.filter((chunk) => {
            return chunk.leaseOwner !== null || chunk.leaseExpiresAt !== null
          }).length,
          otherProjectCount: requestChunks.filter((chunk) => {
            return chunk.projectId !== projectId
          }).length,
          unsafeStatusCount: requestChunks.filter((chunk) => {
            return !safeFailedRequestlessReleaseStatuses.has(chunk.status)
          }).length,
        },
      ] as T[]
    }

    if (statement.includes('FROM app.review_rebuild_request')) {
      return (request === null ? [] : [request]) as T[]
    }

    return [] as T[]
  }

  const run = async (statement: string) => {
    statements.push(statement)
  }

  const database = {
    queryJson,
    run,
    transaction: async <T>(operation: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<T>) => {
      return operation({queryJson, run})
    },
  } satisfies ReviewServingChunkManifestRepositoryDatabase

  return {chunks, database, getRequest: () => request, statements}
}

const createFakeReleaseChunk = (overrides: Partial<FakeReleaseChunkRow> = {}): FakeReleaseChunkRow => {
  return {
    actualInputRows: 10,
    admissionState: 'admitted',
    chunkId: 'chunk:release-1',
    completedAt: null,
    diagnosticsJson: {old: true},
    lastError: 'old failed request',
    leaseExpiresAt: null,
    leaseOwner: null,
    projectId: 'project-v4',
    projectionComponent: 'summary',
    requestId: 'requestless-bootstrap:release-safe',
    retryAfter: '2026-06-23T17:00:00.000Z',
    retryCount: 2,
    startedAt: '2026-06-23T15:00:00.000Z',
    status: 'failed',
    updatedAt: '2026-06-23T15:00:00.000Z',
    ...overrides,
  }
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

test('requestless V4 rebuild request re-admission does not mutate the request row', async () => {
  const {database, statements} = createFakeRequestDatabase()
  const input = {
    chunks: [
      {
        chunkEndKey: 'article:010',
        chunkStartKey: 'article:001',
        inputDigest: 'digest-v1',
        inputWatermark: 5,
        outputBaseGeneration: 1,
        projectId: 'project-v4',
        projectionComponent: 'projectScope' as const,
        projectionIdentity: 'projectScope:project-v4',
      },
    ],
    projectId: 'project-v4',
    reason: 'requestless_bootstrap_rebuild' as const,
    requestedComponents: ['projectScope' as const],
    requestId: 'requestless-bootstrap:release-safe',
  }

  await createReviewServingRebuildRequest(input, database)
  const firstInsertCount = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_request')
  }).length

  await createReviewServingRebuildRequest(input, database)
  const joined = statements.join('\n')
  const secondInsertCount = statements.filter((statement) => {
    return statement.includes('INSERT INTO app.review_rebuild_request')
  }).length

  expect(firstInsertCount).toBe(1)
  expect(secondInsertCount).toBe(1)
  expect(joined).toContain('SELECT request.request_id AS requestId')
  expect(joined).toContain('FROM app.review_rebuild_request request')
  expect(joined).not.toContain('ON CONFLICT(request_id) DO UPDATE SET')
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

test('terminalizing a stale zero-chunk rebuild request fails only the request row', async () => {
  const {database, getRequest, statements} = createFakeTerminalizationDatabase({
    request: createFakeTerminalizationRequest({status: 'running'}),
  })

  const result = await terminalizeStaleZeroChunkReviewServingRebuildRequest(
    {apply: true, now: new Date('2026-06-23T16:00:00.000Z'), projectId: 'project-v4', requestId: 'rebuild:zero-chunk'},
    database,
  )
  const joined = statements.join('\n')

  expect(result.status).toBe('terminalized')
  expect(result.applied).toBe(true)
  expect(result.refusalReasons).toEqual([])
  expect(result.chunkCount).toBe(0)
  expect(getRequest()).toMatchObject({
    admissionState: 'admitted',
    completedAt: null,
    lastError:
      'Operator terminalized stale malformed V4 review rebuild request: admitted/running request has no rebuild chunks; no cleanup authorized.',
    leaseExpiresAt: null,
    leaseOwner: null,
    status: 'failed',
  })
  expect(joined).toContain('UPDATE app.review_rebuild_request')
  expect(joined).toContain("SET status = 'failed'")
  expect(joined).toContain('failed_at = current_timestamp')
  expect(joined).toContain('lease_owner = NULL')
  expect(joined).toContain('lease_expires_at = NULL')
  expect(joined).toContain('updated_at = current_timestamp')
  expect(joined).toContain('no cleanup authorized')
  expect(joined).toContain("AND project_id = 'project-v4'")
  expect(joined).toContain("AND admission_state = 'admitted'")
  expect(joined).toContain("AND status IN ('admitted', 'running')")
  expect(joined).toContain('AND lease_owner IS NULL')
  expect(joined).toContain('AND lease_expires_at IS NULL')
  expect(joined).toContain('AND created_at <=')
  expect(joined).toContain('INTERVAL 60 MINUTE')
  expect(joined).toContain('NOT EXISTS')
  expect(joined).not.toContain('DELETE FROM app.review_rebuild_chunk_manifest')
  expect(joined).not.toContain("status = 'completed'")
})

test('terminalizing a stale zero-chunk rebuild request is dry-run by default', async () => {
  const {database, getRequest, statements} = createFakeTerminalizationDatabase({
    request: createFakeTerminalizationRequest(),
  })

  const result = await terminalizeStaleZeroChunkReviewServingRebuildRequest(
    {now: new Date('2026-06-23T16:00:00.000Z'), projectId: 'project-v4', requestId: 'rebuild:zero-chunk'},
    database,
  )

  expect(result.status).toBe('dry_run')
  expect(result.applied).toBe(false)
  expect(result.refusalReasons).toEqual([])
  expect(getRequest()?.status).toBe('admitted')
  expect(statements.join('\n')).not.toContain('UPDATE app.review_rebuild_request')
})

const terminalizationRefusalCases: Array<{
  chunkCount?: number
  expectedReason: string
  inputProjectId?: string
  minimumAgeMinutes?: number
  request: FakeRequestRow | null
}> = [
  {expectedReason: 'request_not_found', request: null},
  {expectedReason: 'wrong_project', inputProjectId: 'wrong-project', request: createFakeTerminalizationRequest()},
  {
    expectedReason: 'non_admitted_admission_state',
    request: createFakeTerminalizationRequest({admissionState: 'pending'}),
  },
  {expectedReason: 'non_active_request_status', request: createFakeTerminalizationRequest({status: 'completed'})},
  {expectedReason: 'request_has_lease', request: createFakeTerminalizationRequest({leaseOwner: 'worker-1'})},
  {
    expectedReason: 'request_has_lease',
    request: createFakeTerminalizationRequest({leaseExpiresAt: '2026-06-23T17:00:00.000Z'}),
  },
  {chunkCount: 1, expectedReason: 'request_has_chunks', request: createFakeTerminalizationRequest()},
  {
    expectedReason: 'request_too_new',
    minimumAgeMinutes: 180,
    request: createFakeTerminalizationRequest({createdAt: '2026-06-23T14:30:00.000Z'}),
  },
]

for (const refusalCase of terminalizationRefusalCases) {
  test(`terminalizing a zero-chunk rebuild request refuses ${refusalCase.expectedReason}`, async () => {
    const {database, getRequest, statements} = createFakeTerminalizationDatabase({
      chunkCount: refusalCase.chunkCount,
      request: refusalCase.request,
    })

    const result = await terminalizeStaleZeroChunkReviewServingRebuildRequest(
      {
        apply: true,
        minimumAgeMinutes: refusalCase.minimumAgeMinutes,
        now: new Date('2026-06-23T16:00:00.000Z'),
        projectId: refusalCase.inputProjectId ?? 'project-v4',
        requestId: 'rebuild:zero-chunk',
      },
      database,
    )

    expect(result.applied).toBe(false)
    expect(result.refusalReasons).toContain(refusalCase.expectedReason)
    expect(getRequest()?.status).not.toBe('failed')
    expect(statements.join('\n')).not.toContain('UPDATE app.review_rebuild_request')
  })
}

test('failed requestless rebuild chunk release is dry-run by default with operator evidence', async () => {
  const chunkA = createFakeReleaseChunk({chunkId: 'chunk:release-a', status: 'failed'})
  const chunkB = createFakeReleaseChunk({
    chunkId: 'chunk:release-b',
    projectionComponent: 'posting',
    status: 'completed',
    updatedAt: '2026-06-23T15:01:00.000Z',
  })
  const {chunks, database, getRequest, statements} = createFakeReleaseRequestlessChunksDatabase({
    chunks: [chunkA, chunkB],
  })

  const result = await releaseFailedRequestlessReviewServingRebuildChunks(
    {projectId: 'project-v4', requestId: 'requestless-bootstrap:release-safe'},
    database,
  )

  expect(result).toMatchObject({
    affectedCount: 2,
    applied: false,
    refusalReasons: [],
    sampleChunkIds: ['chunk:release-a', 'chunk:release-b'],
    status: 'dry_run',
  })
  expect(result.currentRequest).toMatchObject({
    admissionState: 'admitted',
    projectId: 'project-v4',
    requestId: 'requestless-bootstrap:release-safe',
    status: 'failed',
  })
  expect(result.chunkCounts).toEqual([
    {admissionState: 'admitted', chunkCount: 1, projectionComponent: 'summary', status: 'failed'},
    {admissionState: 'admitted', chunkCount: 1, projectionComponent: 'posting', status: 'completed'},
  ])
  expect(chunks.get('chunk:release-a')).toMatchObject({
    requestId: 'requestless-bootstrap:release-safe',
    status: 'failed',
  })
  expect(getRequest()?.status).toBe('failed')
  expect(statements.join('\n')).not.toContain('UPDATE app.review_rebuild_chunk_manifest')
})

test('failed requestless rebuild chunk release apply clears only chunk ownership and execution metadata', async () => {
  const {chunks, database, getRequest, statements} = createFakeReleaseRequestlessChunksDatabase({
    chunks: [createFakeReleaseChunk()],
  })

  const result = await releaseFailedRequestlessReviewServingRebuildChunks(
    {apply: true, projectId: 'project-v4', requestId: 'requestless-bootstrap:release-safe'},
    database,
  )
  const joined = statements.join('\n')

  expect(result.status).toBe('released')
  expect(result.applied).toBe(true)
  expect(result.affectedCount).toBe(1)
  expect(chunks.get('chunk:release-1')).toMatchObject({
    actualInputRows: null,
    admissionState: 'admitted',
    completedAt: null,
    diagnosticsJson: null,
    lastError: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    requestId: null,
    retryAfter: null,
    retryCount: 0,
    startedAt: null,
    status: 'pending',
  })
  expect(getRequest()).toMatchObject({requestId: 'requestless-bootstrap:release-safe', status: 'failed'})
  expect(joined).toContain('UPDATE app.review_rebuild_chunk_manifest')
  expect(joined).toContain('request_id = NULL')
  expect(joined).toContain("status = 'pending'")
  expect(joined).toContain("request.status = 'failed'")
  expect(joined).toContain("request.admission_state = 'admitted'")
  expect(joined).toContain("request.request_id LIKE 'requestless-bootstrap:%'")
  expect(joined).toContain("request.request_id LIKE 'requestless-summary:%'")
  expect(joined).toContain('lease_owner IS NULL')
  expect(joined).toContain('lease_expires_at IS NULL')
  expect(joined).toContain('RETURNING chunk_id AS chunkId')
  expect(joined).not.toContain('DELETE FROM app.review_rebuild_chunk_manifest')
  expect(joined).not.toContain('UPDATE app.review_rebuild_request')
})

const failedRequestlessReleaseRefusalCases: Array<{
  chunk?: FakeReleaseChunkRow
  expectedReason: string
  inputRequestId?: string
  inputProjectId?: string
  request: FakeRequestRow | null
}> = [
  {expectedReason: 'request_not_found', request: null},
  {
    expectedReason: 'wrong_project',
    inputProjectId: 'project-other',
    request: createFakeTerminalizationRequest({
      failedAt: '2026-06-23T15:00:00.000Z',
      requestId: 'requestless-bootstrap:release-safe',
      status: 'failed',
    }),
  },
  {
    chunk: createFakeReleaseChunk({requestId: 'rebuild:zero-chunk'}),
    expectedReason: 'non_requestless_request_id',
    inputRequestId: 'rebuild:zero-chunk',
    request: createFakeTerminalizationRequest({failedAt: '2026-06-23T15:00:00.000Z', status: 'failed'}),
  },
  {
    expectedReason: 'non_failed_request_status',
    request: createFakeTerminalizationRequest({requestId: 'requestless-bootstrap:release-safe', status: 'admitted'}),
  },
  {
    expectedReason: 'non_admitted_admission_state',
    request: createFakeTerminalizationRequest({
      admissionState: 'pending',
      failedAt: '2026-06-23T15:00:00.000Z',
      requestId: 'requestless-bootstrap:release-safe',
      status: 'failed',
    }),
  },
  {
    expectedReason: 'request_has_lease',
    request: createFakeTerminalizationRequest({
      failedAt: '2026-06-23T15:00:00.000Z',
      leaseOwner: 'worker-1',
      requestId: 'requestless-bootstrap:release-safe',
      status: 'failed',
    }),
  },
  {
    chunk: createFakeReleaseChunk({leaseOwner: 'worker-1'}),
    expectedReason: 'chunk_has_lease',
    request: createFakeTerminalizationRequest({
      failedAt: '2026-06-23T15:00:00.000Z',
      requestId: 'requestless-bootstrap:release-safe',
      status: 'failed',
    }),
  },
  {
    chunk: createFakeReleaseChunk({projectId: 'project-other'}),
    expectedReason: 'chunk_project_mismatch',
    request: createFakeTerminalizationRequest({
      failedAt: '2026-06-23T15:00:00.000Z',
      requestId: 'requestless-bootstrap:release-safe',
      status: 'failed',
    }),
  },
  {
    chunk: createFakeReleaseChunk({status: 'blocked_over_budget'}),
    expectedReason: 'unsafe_chunk_status',
    request: createFakeTerminalizationRequest({
      failedAt: '2026-06-23T15:00:00.000Z',
      requestId: 'requestless-bootstrap:release-safe',
      status: 'failed',
    }),
  },
]

for (const refusalCase of failedRequestlessReleaseRefusalCases) {
  test(`failed requestless rebuild chunk release refuses ${refusalCase.expectedReason}`, async () => {
    const {chunks, database, statements} = createFakeReleaseRequestlessChunksDatabase({
      chunks: refusalCase.request === null ? [] : [refusalCase.chunk ?? createFakeReleaseChunk()],
      request: refusalCase.request,
    })

    const result = await releaseFailedRequestlessReviewServingRebuildChunks(
      {
        apply: true,
        projectId: refusalCase.inputProjectId ?? 'project-v4',
        requestId: refusalCase.inputRequestId ?? 'requestless-bootstrap:release-safe',
      },
      database,
    )

    expect(result.applied).toBe(false)
    expect(result.refusalReasons).toContain(refusalCase.expectedReason)
    expect(chunks.get(refusalCase.chunk?.chunkId ?? 'chunk:release-1')?.requestId).toBe(
      refusalCase.request === null ? undefined : (refusalCase.inputRequestId ?? 'requestless-bootstrap:release-safe'),
    )
    expect(statements.join('\n')).not.toContain('UPDATE app.review_rebuild_chunk_manifest')
  })
}

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
