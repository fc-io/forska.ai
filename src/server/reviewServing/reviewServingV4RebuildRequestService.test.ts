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
  projectArticleUpdatedAt: string | null
  projectPromptUpdatedAt: string | null
  projectUpdatedAt: string
  scopedArticleCount: number
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
  status: 'admitted' | 'blocked_over_budget'
  updatedAt: string
}

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
  projectArticleUpdatedAt: '2026-06-20T10:00:00.000Z',
  projectPromptUpdatedAt: '2026-06-20T10:01:00.000Z',
  projectUpdatedAt: '2026-06-20T09:59:00.000Z',
  scopedArticleCount: 10,
} satisfies FakeStats

const createFakeRequestDatabase = (stats: FakeStats) => {
  const requests = new Map<string, FakeRequestRow>()
  const statements: string[] = []
  const componentStateJson = {
    optional: [],
    required: [
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

    if (statement.includes('FROM app.review_serving_snapshot_manifest')) {
      return [{componentStateJson}] as T[]
    }

    if (statement.includes('FROM app.review_projection_identity_manifest')) {
      return [
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

test('V4 rebuild request service estimates admission budget from project data', async () => {
  const {database, statements} = createFakeRequestDatabase({
    ...baseStats,
    enabledPromptCount: 4,
    humanJudgmentCount: 2_000,
    judgmentCount: 5_000,
    scopedArticleCount: 100_000,
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
    projectArticles: {count: 100_000, updatedAt: '2026-06-20T10:00:00.000Z'},
    projectPrompts: {count: 4, updatedAt: '2026-06-20T10:01:00.000Z'},
  })
  expect(joined).toContain('judgment.model_id = project.model_id')
  expect(joined).toContain('judgment.use_fulltext_no_images = project.use_fulltext_no_images')
})

test('V4 rebuild request service watermarks make changed data produce a new request id', async () => {
  const first = createFakeRequestDatabase(baseStats)
  const second = createFakeRequestDatabase({...baseStats, projectArticleUpdatedAt: '2026-06-20T11:00:00.000Z'})

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
