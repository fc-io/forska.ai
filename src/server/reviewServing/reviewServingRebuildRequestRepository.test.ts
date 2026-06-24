import {expect, test} from 'bun:test'

import type {ReviewServingChunkManifestRepositoryDatabase} from './reviewServingChunkManifestRepository.ts'
import {
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

const getSqlStrings = (statement: string) => {
  return [...statement.matchAll(/'((?:''|[^'])*)'/g)].map((match) => {
    return match[1]?.replaceAll("''", "'") ?? ''
  })
}

const getClock = (statements: readonly string[]) => {
  return new Date(2026, 5, 23, 16, statements.length).toISOString()
}

const createFakeRequestDatabase = () => {
  const requests = new Map<string, FakeRequestRow>()
  const statements: string[] = []
  const componentStateJson = {
    optional: [{baseGeneration: 3, component: 'search', patchWatermark: 11, projectionIdentity: 'search:identity-1'}],
    required: [
      {baseGeneration: 2, component: 'display', patchWatermark: 10, projectionIdentity: 'display:identity-1'},
      {baseGeneration: 2, component: 'payload', patchWatermark: 10, projectionIdentity: 'payload:identity-1'},
      {baseGeneration: 2, component: 'summary', patchWatermark: 10, projectionIdentity: 'summary:identity-1'},
    ],
  }

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

    if (statement.includes('FROM app.project_article')) {
      return [{chunkEndKey: 'article-z', chunkStartKey: 'article-a', scopedArticleCount: 3}] as T[]
    }

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      return [{componentStateJson}] as T[]
    }

    if (statement.includes('FROM app.review_projection_identity_manifest')) {
      return [
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
          baseGeneration: 3,
          inputDigest: 'search-digest-v1',
          inputWatermark: 11,
          projectionComponent: 'search',
          projectionIdentity: 'search:identity-1',
        },
      ] as T[]
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
  const {database, statements} = createFakeRequestDatabase()

  const request = await createReviewServingRebuildRequest(
    {
      estimate: {estimatedInputRows: 100},
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
  expect(joined).not.toContain('component:all')
  expect(joined).not.toContain(':request:rebuild:default-identities')
})
