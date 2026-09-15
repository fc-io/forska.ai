import {expect, test} from 'bun:test'
import {Effect} from 'effect'

import {countReadyReviewServingComponents, type ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import type {ReviewServingDirtyWorkClaim, ReviewServingDirtyWorkInput} from './reviewServingDirtyWorkService.ts'
import {
  getReviewServingDirtyWorkScopeForChange,
  type ReviewServingDirtyWorkScope,
} from './reviewServingProjectorDomain.ts'
import {
  ensureReviewServingClaimManifests,
  getReviewServingProjectorComponentRunPlan,
  intakeReviewServingProjectorDirtyWork,
  type ReviewServingProjectorServiceDependencies,
  wakeReviewServingProjectorService,
} from './reviewServingProjectorService.ts'
import type {PromoteReviewServingProjectorSnapshotInput} from './reviewServingProjectorWriter.ts'
import {getReviewServingReviewConfigHash} from './reviewServingReviewConfig.ts'

const getScope = (changeKind = 'judgment.human.updated') => {
  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind,
    sourceHighWaterMark: 42,
    sourcePartition: 'review-change',
    values: {articleId: 'article-1', humanJudgmentKey: 'human-1', projectId: 'project-1', sourceHighWaterMark: 42},
  })

  if (scope === null) {
    throw new Error('expected dirty work scope')
  }

  return scope
}

const getClaim = (input: {
  articleId?: string | null
  component: ReviewServingProjectionComponent
  dirtyWorkId: string
  latestSourceHighWaterMark?: number
  scopeId?: string
  scopeKind?: string
}) => {
  return {
    articleId: input.articleId ?? 'article-1',
    dirtyKind: 'judgment.human.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: input.dirtyWorkId,
    firstSourceHighWaterMark: 1,
    latestDeltaId: null,
    latestSourceHighWaterMark: input.latestSourceHighWaterMark ?? 1,
    projectId: 'project-1',
    projectionComponent: input.component,
    projectionIdentity: `${input.component}:identity`,
    scopeId: input.scopeId ?? 'project-1:article-1',
    scopeKind: input.scopeKind ?? 'article',
    sourcePartition: 'review-change',
    status: 'running',
  } satisfies ReviewServingDirtyWorkClaim
}

const promptConfigRow = () => {
  return {
    answerSchemaHash: null,
    promptId: 'prompt-1',
    promptOrder: 1,
    promptTextHash: 'prompt-text-1',
    settingsVersion: 'prompt-v1',
    thresholdVersion: null,
  }
}

const projectSettingsRow = () => {
  return {
    humanJudgmentMode: 'prompt' as const,
    modelExecutionOptions: '{"thinking":{"effort":"medium"}}',
    modelId: 'model-1',
    modelProviderBaseUrl: 'https://provider.example',
    modelProviderConnectionId: 'provider-1',
    modelProviderKind: 'openai-compatible',
    modelRemoteModelId: 'remote-model-1',
    modelVariant: 'thinking',
    useAbstract: true,
    useFulltext: false,
    useFulltextNoImages: false,
    useTitle: true,
  }
}

const createDependencyHarness = (
  pending: Partial<Record<ReviewServingProjectionComponent, ReviewServingDirtyWorkClaim[]>>,
) => {
  const failedClaimIds: string[] = []
  const releasedClaimIds: string[] = []
  const blockedClaimIds: string[] = []
  const completedClaimIds: string[] = []
  const claimedComponents: ReviewServingProjectionComponent[] = []
  const database = {
    queryJson: async <T>(_statement: string) => {
      return [] as T[]
    },
    run: async (_statement: string) => {},
    transaction: async <T>(
      operation: (tx: {
        queryJson: <T>(statement: string) => Promise<T[]>
        run: (statement: string) => Promise<void>
      }) => Promise<T>,
    ) => {
      return operation(database)
    },
  }
  const dependencies: ReviewServingProjectorServiceDependencies = {
    blockDirtyWorkForRebuild: async (dirtyWorkIds: readonly string[]) => {
      blockedClaimIds.push(...dirtyWorkIds)

      return {blockedCount: dirtyWorkIds.length}
    },
    claimDirtyWork: async (params: {limit: number; projectionComponent: ReviewServingProjectionComponent}) => {
      claimedComponents.push(params.projectionComponent)
      const claims = pending[params.projectionComponent] ?? []
      const claimed = claims.slice(0, params.limit)

      pending[params.projectionComponent] = claims.slice(params.limit)

      return claimed
    },
    completeDirtyWork: async (claims: readonly ReviewServingDirtyWorkClaim[]) => {
      completedClaimIds.push(
        ...claims.map((claim) => {
          return claim.dirtyWorkId
        }),
      )

      return {completedCount: claims.length}
    },
    database,
    failDirtyWork: async (dirtyWorkIds: readonly string[]) => {
      failedClaimIds.push(...dirtyWorkIds)

      return {failedCount: dirtyWorkIds.length}
    },
    releaseDirtyWork: async (dirtyWorkIds: readonly string[]) => {
      releasedClaimIds.push(...dirtyWorkIds)

      return {releasedCount: dirtyWorkIds.length}
    },
    runners: {},
  }

  return {blockedClaimIds, claimedComponents, completedClaimIds, dependencies, failedClaimIds, releasedClaimIds}
}

test('component run plan starts at the invalidation registry first affected component', () => {
  const scope = getScope()
  const plan = getReviewServingProjectorComponentRunPlan(scope)

  expect(plan).toEqual(['humanStatus', 'queue', 'payload', 'posting', 'summary'])
  expect(plan).not.toContain('selectedImport')
  expect(plan).not.toContain('display')
})

test('dirty-work intake enqueues only the affected component slice', async () => {
  const scope = getScope()
  const upserts: ReviewServingDirtyWorkInput[] = []
  const database = {
    queryJson: async <T>(_statement: string) => {
      return [] as T[]
    },
    run: async (_statement: string) => {},
    transaction: async <T>(
      operation: (tx: {
        queryJson: <T>(statement: string) => Promise<T[]>
        run: (statement: string) => Promise<void>
      }) => Promise<T>,
    ) => {
      return operation(database)
    },
  }

  const result = await intakeReviewServingProjectorDirtyWork(
    {
      identityResolver: ({component}) => {
        return `${component}:identity`
      },
      latestDeltaId: 'delta-1',
      scope,
    },
    {
      database,
      upsertDirtyWork: async (input) => {
        upserts.push(input)

        return {dirtyWorkId: input.projectionComponent, skipped: false}
      },
    },
  )

  expect(result).toEqual({dirtyWorkCount: 5, status: 'queued'})
  expect(
    upserts.map((input) => {
      return input.projectionComponent
    }),
  ).toEqual(['humanStatus', 'queue', 'payload', 'posting', 'summary'])
  expect(
    upserts.map((input) => {
      return input.projectionIdentity
    }),
  ).toEqual(['humanStatus:identity', 'queue:identity', 'payload:identity', 'posting:identity', 'summary:identity'])
})

test('claim manifest ensure refreshes stale review config hashes before reuse', async () => {
  const statements: string[] = []
  const expectedHash = getReviewServingReviewConfigHash({
    ...projectSettingsRow(),
    promptConfigRows: [promptConfigRow()],
  })
  const database = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      if (statement.includes('FROM app.review_projection_identity_manifest')) {
        return [
          {
            baseGeneration: 3,
            definitionVersion: 'posting-v1',
            inputDigest: null,
            inputWatermark: 12,
            inputWatermarksJson: '{}',
            invalidationReason: null,
            manifestId: 'manifest-1',
            patchRangeEnd: null,
            patchRangeStart: null,
            patchWatermark: 10,
            projectId: 'project-1',
            projectionComponent: 'posting',
            projectionIdentity: 'posting:identity',
            promptConfigHash: null,
            reviewConfigHash: 'review:stale',
            status: 'candidate',
          },
        ] as T[]
      }

      if (statement.includes('FROM app.project project')) {
        return [projectSettingsRow()] as T[]
      }

      if (statement.includes('FROM app.project_prompt project_prompt')) {
        return [promptConfigRow()] as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
    },
  }

  await ensureReviewServingClaimManifests([getClaim({component: 'posting', dirtyWorkId: 'posting-1'})], database)

  const manifestWrite = statements.find((statement) => {
    return (
      statement.includes('INSERT INTO app.review_projection_identity_manifest')
      || statement.includes('UPDATE app.review_projection_identity_manifest')
    )
  })

  expect(manifestWrite).toContain(expectedHash)
  expect(manifestWrite).not.toContain('review:stale')
})

test('wake runs claimed component batches in dependency order under row budgets', async () => {
  const order: ReviewServingProjectionComponent[] = []
  const {dependencies} = createDependencyHarness({
    humanStatus: [getClaim({component: 'humanStatus', dirtyWorkId: 'human-1'})],
    posting: [getClaim({component: 'posting', dirtyWorkId: 'posting-1'})],
    summary: [getClaim({component: 'summary', dirtyWorkId: 'summary-1'})],
  })

  dependencies.runners = {
    humanStatus: async () => {
      order.push('humanStatus')

      return {processedCount: 1}
    },
    posting: async () => {
      order.push('posting')

      return {processedCount: 1}
    },
    summary: async () => {
      order.push('summary')

      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {
      batchSize: 1,
      componentOrder: ['humanStatus', 'posting', 'summary'],
      maxRowsPerWake: 2,
      maxWakeMs: 1_000,
      wakeId: 'wake-1',
    },
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(order).toEqual(['humanStatus', 'posting'])
  expect(
    result.runs.map((run) => {
      return run.component
    }),
  ).toEqual(['humanStatus', 'posting'])
})

test('wake retries a failing projector batch and avoids marking it failed after replay succeeds', async () => {
  const {dependencies, failedClaimIds} = createDependencyHarness({
    posting: [getClaim({component: 'posting', dirtyWorkId: 'posting-1'})],
  })
  let attempts = 0

  dependencies.runners = {
    posting: async () => {
      attempts += 1

      if (attempts === 1) {
        throw new Error('transient projection failure')
      }

      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['posting'], maxRetries: 1, maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(result.runs[0]?.attempts).toBe(2)
  expect(failedClaimIds).toEqual([])
})

test('wake marks exhausted failures as failed lane blockers with diagnostics', async () => {
  const {dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    posting: [getClaim({component: 'posting', dirtyWorkId: 'posting-1'})],
  })

  dependencies.runners = {
    posting: async () => {
      throw new Error('projector crashed after write validation')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['posting'], maxRetries: 1, maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('failed')
  expect(result.failures).toEqual([
    {
      attempts: 2,
      claimIds: ['posting-1'],
      component: 'posting',
      diagnostic: 'projector crashed after write validation',
      status: 'failed',
    },
  ])
  expect(failedClaimIds).toEqual(['posting-1'])
  expect(releasedClaimIds).toEqual([])
})

test('wake releases claimed work when the duration budget is exhausted after claim', async () => {
  const {dependencies, releasedClaimIds} = createDependencyHarness({
    posting: [getClaim({component: 'posting', dirtyWorkId: 'posting-1'})],
  })
  const nowValues = [0, 0, 2_000]

  dependencies.nowMs = () => {
    return nowValues.shift() ?? 2_000
  }
  dependencies.runners = {
    posting: async () => {
      throw new Error('runner should not execute')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['posting'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('partial')
  expect(result.releasedClaimIds).toEqual(['posting-1'])
  expect(releasedClaimIds).toEqual(['posting-1'])
})

test('wake requests page-first V4 rebuild and blocks claims when a snapshot is not ready yet', async () => {
  const {blockedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    queue: [getClaim({component: 'queue', dirtyWorkId: 'queue-1'})],
  })
  const rebuildRequests: Array<{
    components: readonly ReviewServingProjectionComponent[] | undefined
    pageFirstOnly: boolean | undefined
    priority: number | undefined
    projectId: string
    reason: string
  }> = []

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({
      components: input.components,
      pageFirstOnly: input.pageFirstOnly,
      priority: input.priority,
      projectId: input.projectId,
      reason: input.reason,
    })

    return Effect.succeed({status: 'admitted'} as never)
  }
  dependencies.runners = {
    queue: async () => {
      throw new Error('cannot run projector without a candidate or active snapshot for project project-1')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['queue'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('partial')
  expect(result.failures).toEqual([])
  expect(rebuildRequests).toEqual([
    {
      components: [...countReadyReviewServingComponents],
      pageFirstOnly: true,
      priority: 10_000,
      projectId: 'project-1',
      reason: 'missingReviewServingSnapshot',
    },
  ])
  expect(blockedClaimIds).toEqual(['queue-1'])
  expect(releasedClaimIds).toEqual([])
  expect(failedClaimIds).toEqual([])
})

test('wake requests payload repair with count-ready dependencies for missing result visibility snapshots', async () => {
  const {blockedClaimIds, dependencies, releasedClaimIds} = createDependencyHarness({
    payload: [getClaim({component: 'payload', dirtyWorkId: 'payload-1'})],
  })
  const rebuildRequests: Array<{
    components: readonly ReviewServingProjectionComponent[] | undefined
    pageFirstOnly: boolean | undefined
    priority: number | undefined
    projectId: string
    reason: string
  }> = []

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({
      components: input.components,
      pageFirstOnly: input.pageFirstOnly,
      priority: input.priority,
      projectId: input.projectId,
      reason: input.reason,
    })

    return Effect.succeed({status: 'admitted'} as never)
  }
  dependencies.runners = {
    payload: async () => {
      throw new Error('cannot run projector without a candidate or active snapshot for project project-1')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['payload'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('partial')
  expect(rebuildRequests).toEqual([
    {
      components: [...countReadyReviewServingComponents, 'payload'],
      pageFirstOnly: true,
      priority: 50,
      projectId: 'project-1',
      reason: 'missingReviewServingSnapshot',
    },
  ])
  expect(blockedClaimIds).toEqual(['payload-1'])
  expect(releasedClaimIds).toEqual([])
})

test('wake requests payload-backed summary repair when a candidate lacks payload identity', async () => {
  const {blockedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    summary: [getClaim({component: 'summary', dirtyWorkId: 'summary-1'})],
  })
  const rebuildRequests: Array<{
    components: readonly ReviewServingProjectionComponent[] | undefined
    pageFirstOnly: boolean | undefined
    priority: number | undefined
    projectId: string
    reason: string
  }> = []

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({
      components: input.components,
      pageFirstOnly: input.pageFirstOnly,
      priority: input.priority,
      projectId: input.projectId,
      reason: input.reason,
    })

    return Effect.succeed({status: 'admitted'} as never)
  }
  dependencies.runners = {
    summary: async () => {
      throw new Error('cannot run projector without payload identity in snapshot snapshot-1')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['summary'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('partial')
  expect(result.failures).toEqual([])
  expect(rebuildRequests).toEqual([
    {
      components: [...countReadyReviewServingComponents, 'payload', 'summary'],
      pageFirstOnly: true,
      priority: 50,
      projectId: 'project-1',
      reason: 'missingReviewServingSnapshot',
    },
  ])
  expect(blockedClaimIds).toEqual(['summary-1'])
  expect(failedClaimIds).toEqual([])
  expect(releasedClaimIds).toEqual([])
})

test('wake routes search dirty work through chunked rebuilds instead of direct projection', async () => {
  const {completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    search: [getClaim({component: 'search', dirtyWorkId: 'search-article-1'})],
  })
  const rebuildRequests: Array<{
    components: readonly ReviewServingProjectionComponent[] | undefined
    priority: number | undefined
    projectId: string
    reason: string
  }> = []
  let runnerCalled = false

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({
      components: input.components,
      priority: input.priority,
      projectId: input.projectId,
      reason: input.reason,
    })

    return Effect.succeed({status: 'admitted'} as never)
  }
  dependencies.runners = {
    search: async () => {
      runnerCalled = true

      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['search'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(result.runs).toEqual([
    {attempts: 1, claimCount: 1, component: 'search', processedCount: 0, status: 'completed'},
  ])
  expect(runnerCalled).toBe(false)
  expect(rebuildRequests).toEqual([
    {components: ['search'], priority: 50, projectId: 'project-1', reason: 'searchDirtyWork'},
  ])
  expect(completedClaimIds).toEqual(['search-article-1'])
  expect(failedClaimIds).toEqual([])
  expect(releasedClaimIds).toEqual([])
})

test('wake routes high-fanout queue dirty work through chunked rebuilds instead of direct projection', async () => {
  const {completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    queue: [
      getClaim({
        articleId: null,
        component: 'queue',
        dirtyWorkId: 'queue-project-1',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ],
  })
  const rebuildRequests: Array<{
    components: readonly ReviewServingProjectionComponent[] | undefined
    priority: number | undefined
    projectId: string
    reason: string
  }> = []
  let runnerCalled = false

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({
      components: input.components,
      priority: input.priority,
      projectId: input.projectId,
      reason: input.reason,
    })

    return Effect.succeed({status: 'admitted'} as never)
  }
  dependencies.runners = {
    queue: async () => {
      runnerCalled = true

      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['queue'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(result.runs).toEqual([
    {attempts: 1, claimCount: 1, component: 'queue', processedCount: 0, status: 'completed'},
  ])
  expect(runnerCalled).toBe(false)
  expect(rebuildRequests).toEqual([
    {components: ['queue'], priority: 10_000, projectId: 'project-1', reason: 'queueDirtyWork'},
  ])
  expect(completedClaimIds).toEqual(['queue-project-1'])
  expect(failedClaimIds).toEqual([])
  expect(releasedClaimIds).toEqual([])
})

test('wake routes high-fanout human status dirty work through chunked rebuilds instead of direct projection', async () => {
  const {completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    humanStatus: [
      getClaim({
        articleId: null,
        component: 'humanStatus',
        dirtyWorkId: 'human-status-project-1',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ],
  })
  const rebuildRequests: Array<{
    components: readonly ReviewServingProjectionComponent[] | undefined
    priority: number | undefined
    projectId: string
    reason: string
  }> = []
  let runnerCalled = false

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({
      components: input.components,
      priority: input.priority,
      projectId: input.projectId,
      reason: input.reason,
    })

    return Effect.succeed({status: 'admitted'} as never)
  }
  dependencies.runners = {
    humanStatus: async () => {
      runnerCalled = true

      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['humanStatus'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(result.runs).toEqual([
    {attempts: 1, claimCount: 1, component: 'humanStatus', processedCount: 0, status: 'completed'},
  ])
  expect(runnerCalled).toBe(false)
  expect(rebuildRequests).toEqual([
    {components: ['humanStatus'], priority: 10_000, projectId: 'project-1', reason: 'humanStatusDirtyWork'},
  ])
  expect(completedClaimIds).toEqual(['human-status-project-1'])
  expect(failedClaimIds).toEqual([])
  expect(releasedClaimIds).toEqual([])
})

test('wake routes high-fanout LLM status dirty work through chunked rebuilds instead of direct projection', async () => {
  const {completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    llmStatus: [
      getClaim({
        articleId: null,
        component: 'llmStatus',
        dirtyWorkId: 'llm-status-project-1',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ],
  })
  const rebuildRequests: Array<{
    components: readonly ReviewServingProjectionComponent[] | undefined
    priority: number | undefined
    projectId: string
    reason: string
  }> = []
  let runnerCalled = false

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({
      components: input.components,
      priority: input.priority,
      projectId: input.projectId,
      reason: input.reason,
    })

    return Effect.succeed({status: 'admitted'} as never)
  }
  dependencies.runners = {
    llmStatus: async () => {
      runnerCalled = true

      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['llmStatus'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(result.runs).toEqual([
    {attempts: 1, claimCount: 1, component: 'llmStatus', processedCount: 0, status: 'completed'},
  ])
  expect(runnerCalled).toBe(false)
  expect(rebuildRequests).toEqual([
    {components: ['llmStatus'], priority: 10_000, projectId: 'project-1', reason: 'llmStatusDirtyWork'},
  ])
  expect(completedClaimIds).toEqual(['llm-status-project-1'])
  expect(failedClaimIds).toEqual([])
  expect(releasedClaimIds).toEqual([])
})

test('wake keeps article-scoped human status dirty work on the direct patch path', async () => {
  const {completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    humanStatus: [getClaim({component: 'humanStatus', dirtyWorkId: 'human-status-article-1'})],
  })
  const rebuildRequests: Array<{projectId: string; reason: string}> = []

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({projectId: input.projectId, reason: input.reason})

    return Effect.succeed({status: 'admitted'} as never)
  }
  dependencies.runners = {
    humanStatus: async () => {
      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['humanStatus'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(result.runs).toEqual([
    {attempts: 1, claimCount: 1, component: 'humanStatus', processedCount: 1, status: 'completed'},
  ])
  expect(rebuildRequests).toEqual([])
  expect(completedClaimIds).toEqual([])
  expect(failedClaimIds).toEqual([])
  expect(releasedClaimIds).toEqual([])
})

test('wake keeps article-scoped queue dirty work on the direct patch path', async () => {
  const {completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    queue: [getClaim({component: 'queue', dirtyWorkId: 'queue-article-1'})],
  })
  const rebuildRequests: Array<{projectId: string; reason: string}> = []

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({projectId: input.projectId, reason: input.reason})

    return Effect.succeed({status: 'admitted'} as never)
  }
  dependencies.runners = {
    queue: async () => {
      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['queue'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(result.runs).toEqual([
    {attempts: 1, claimCount: 1, component: 'queue', processedCount: 1, status: 'completed'},
  ])
  expect(rebuildRequests).toEqual([])
  expect(completedClaimIds).toEqual([])
  expect(failedClaimIds).toEqual([])
  expect(releasedClaimIds).toEqual([])
})

test('wake fails claimed work when missing-snapshot rebuild request is blocked', async () => {
  const {dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    queue: [getClaim({component: 'queue', dirtyWorkId: 'queue-1'})],
  })
  const rebuildRequests: Array<{projectId: string; reason: string}> = []

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({projectId: input.projectId, reason: input.reason})

    return Effect.succeed({
      overBudgetReason: 'estimated input rows exceed default request budget',
      status: 'blocked_over_budget',
    } as never)
  }
  dependencies.runners = {
    queue: async () => {
      throw new Error('cannot run projector without a candidate or active snapshot for project project-1')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['queue'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('failed')
  expect(result.failures).toEqual([
    {
      attempts: 2,
      claimIds: ['queue-1'],
      component: 'queue',
      diagnostic: 'estimated input rows exceed default request budget',
      status: 'failed',
    },
  ])
  expect(rebuildRequests).toEqual([{projectId: 'project-1', reason: 'missingReviewServingSnapshot'}])
  expect(failedClaimIds).toEqual(['queue-1'])
  expect(releasedClaimIds).toEqual([])
})

test('wake fails claimed work when missing-snapshot rebuild admission fails', async () => {
  const {dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    queue: [getClaim({component: 'queue', dirtyWorkId: 'queue-1'})],
  })
  const rebuildRequests: Array<{projectId: string; reason: string}> = []

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({projectId: input.projectId, reason: input.reason})

    return Effect.fail(new Error('Review rebuild request created no rebuild chunks')) as unknown as ReturnType<
      NonNullable<typeof dependencies.requestRebuild>
    >
  }
  dependencies.runners = {
    queue: async () => {
      throw new Error('cannot run projector without a candidate or active snapshot for project project-1')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['queue'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('failed')
  expect(result.failures).toEqual([
    {
      attempts: 2,
      claimIds: ['queue-1'],
      component: 'queue',
      diagnostic: 'Review rebuild request created no rebuild chunks',
      status: 'failed',
    },
  ])
  expect(rebuildRequests).toEqual([{projectId: 'project-1', reason: 'missingReviewServingSnapshot'}])
  expect(failedClaimIds).toEqual(['queue-1'])
  expect(releasedClaimIds).toEqual([])
})

test('wake does not claim work while queue pressure or active imports exceed configured limits', async () => {
  const {claimedComponents, dependencies} = createDependencyHarness({
    posting: [getClaim({component: 'posting', dirtyWorkId: 'posting-1'})],
  })

  dependencies.getQueueState = async () => {
    return {activeImportCount: 1, pendingDirtyWorkCount: 10}
  }
  dependencies.runners = {
    posting: async () => {
      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {
      batchSize: 1,
      componentOrder: ['posting'],
      maxActiveImportCount: 0,
      maxPendingDirtyWorkCount: 5,
      maxRowsPerWake: 1,
      maxWakeMs: 1_000,
      wakeId: 'wake-1',
    },
    dependencies,
  )

  expect(result.status).toBe('blocked')
  expect(claimedComponents).toEqual([])
})

test('wake does not claim work when its admission barrier remains blocked after foreground work drains', async () => {
  const {claimedComponents, dependencies} = createDependencyHarness({
    posting: [getClaim({component: 'posting', dirtyWorkId: 'posting-1'})],
  })

  dependencies.getQueueState = async () => {
    return {blocked: true, foregroundDuckdbQueueDepth: 0}
  }
  dependencies.runners = {
    posting: async () => {
      throw new Error('The projector must not run after admission is canceled or another barrier becomes active')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['posting'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('blocked')
  expect(claimedComponents).toEqual([])
})

test('wake releases its claim when admission is canceled before projector writes', async () => {
  const {completedClaimIds, dependencies, releasedClaimIds} = createDependencyHarness({
    posting: [getClaim({component: 'posting', dirtyWorkId: 'posting-1'})],
  })
  let admissionChecks = 0

  dependencies.getQueueState = async () => {
    admissionChecks += 1

    return {blocked: admissionChecks >= 3, foregroundDuckdbQueueDepth: 0}
  }
  dependencies.runners = {
    posting: async () => {
      throw new Error('The projector must not run after admission is canceled')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['posting'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('partial')
  expect(releasedClaimIds).toEqual(['posting-1'])
  expect(completedClaimIds).toEqual([])
})

test('wake stops claiming later dirty-work batches when foreground DuckDB work queues mid-wake', async () => {
  const {claimedComponents, dependencies} = createDependencyHarness({
    humanStatus: [getClaim({component: 'humanStatus', dirtyWorkId: 'human-1'})],
    posting: [getClaim({component: 'posting', dirtyWorkId: 'posting-1'})],
  })
  let foregroundDuckdbQueueDepth = 0

  dependencies.getQueueState = async () => {
    return {foregroundDuckdbQueueDepth}
  }
  dependencies.runners = {
    humanStatus: async () => {
      foregroundDuckdbQueueDepth = 1

      return {processedCount: 1}
    },
    posting: async () => {
      throw new Error('posting runner should not execute while foreground DuckDB work is queued')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['humanStatus', 'posting'], maxRowsPerWake: 2, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(claimedComponents).toEqual(['humanStatus'])
  expect(
    result.runs.map((run) => {
      return run.component
    }),
  ).toEqual(['humanStatus'])
})

test('wake releases claimed work when foreground DuckDB work queues before projector writes', async () => {
  const {completedClaimIds, dependencies, releasedClaimIds} = createDependencyHarness({
    posting: [getClaim({component: 'posting', dirtyWorkId: 'posting-1'})],
  })
  let queueStateReadCount = 0
  const runnerCalls: string[] = []

  dependencies.getQueueState = async () => {
    queueStateReadCount += 1

    return {foregroundDuckdbQueueDepth: queueStateReadCount >= 3 ? 1 : 0}
  }
  dependencies.runners = {
    posting: async () => {
      runnerCalls.push('posting')

      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['posting'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('partial')
  expect(releasedClaimIds).toEqual(['posting-1'])
  expect(completedClaimIds).toEqual([])
  expect(runnerCalls).toEqual([])
})

test('failed snapshot promotion is reported without replacing last-known-good data in the service', async () => {
  const {dependencies} = createDependencyHarness({
    summary: [getClaim({component: 'summary', dirtyWorkId: 'summary-1'})],
  })

  dependencies.promoteSnapshot = async (input: PromoteReviewServingProjectorSnapshotInput) => {
    return {
      error: 'candidate snapshot failed validation; active snapshot remains unchanged',
      promoted: false,
      snapshotId: input.snapshotId,
    }
  }
  dependencies.runners = {
    summary: async () => {
      return {
        candidateSnapshots: [{projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'candidate-1'}],
        processedCount: 1,
      }
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['summary'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(result.promotions).toEqual([
    {
      error: 'candidate snapshot failed validation; active snapshot remains unchanged',
      promoted: false,
      snapshotId: 'candidate-1',
    },
  ])
})

test('unsupported scopes fail intake instead of falling back to foreground raw serving', async () => {
  const scope = {...getScope(), dirtyKind: 'unknown.change'} as unknown as ReviewServingDirtyWorkScope

  const result = await intakeReviewServingProjectorDirtyWork({
    identityResolver: ({component}) => {
      return `${component}:identity`
    },
    scope,
  })

  expect(result).toEqual({reason: 'unsupported dirty kind: unknown.change', status: 'failed'})
})
