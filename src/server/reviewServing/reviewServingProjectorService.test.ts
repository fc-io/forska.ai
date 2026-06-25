import {expect, test} from 'bun:test'
import {Effect} from 'effect'

import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
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
  component: ReviewServingProjectionComponent
  dirtyWorkId: string
  latestSourceHighWaterMark?: number
}) => {
  return {
    articleId: 'article-1',
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
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
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
    claimDirtyWork: async (params: {limit: number; projectionComponent: ReviewServingProjectionComponent}) => {
      claimedComponents.push(params.projectionComponent)
      const claims = pending[params.projectionComponent] ?? []
      const claimed = claims.slice(0, params.limit)

      pending[params.projectionComponent] = claims.slice(params.limit)

      return claimed
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

  return {claimedComponents, dependencies, failedClaimIds, releasedClaimIds}
}

test('component run plan starts at the invalidation registry first affected component', () => {
  const scope = getScope()
  const plan = getReviewServingProjectorComponentRunPlan(scope)

  expect(plan).toEqual(['humanStatus', 'queue', 'posting', 'summary', 'payload'])
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
  ).toEqual(['humanStatus', 'queue', 'posting', 'summary', 'payload'])
  expect(
    upserts.map((input) => {
      return input.projectionIdentity
    }),
  ).toEqual(['humanStatus:identity', 'queue:identity', 'posting:identity', 'summary:identity', 'payload:identity'])
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

  const upsert = statements.find((statement) => {
    return statement.includes('INSERT INTO app.review_projection_identity_manifest')
  })

  expect(upsert).toContain(expectedHash)
  expect(upsert).not.toContain('review:stale')
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

test('wake marks exhausted failures with diagnostics for later bounded retry', async () => {
  const {dependencies, failedClaimIds} = createDependencyHarness({
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

test('wake requests V4 rebuild and releases claims when a snapshot is not ready yet', async () => {
  const {dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    queue: [getClaim({component: 'queue', dirtyWorkId: 'queue-1'})],
  })
  const rebuildRequests: Array<{projectId: string; reason: string}> = []

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({projectId: input.projectId, reason: input.reason})

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
  expect(rebuildRequests).toEqual([{projectId: 'project-1', reason: 'missingReviewServingSnapshot'}])
  expect(releasedClaimIds).toEqual(['queue-1'])
  expect(failedClaimIds).toEqual([])
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

    return Effect.fail(new Error('Review rebuild request created no rebuild chunks'))
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
