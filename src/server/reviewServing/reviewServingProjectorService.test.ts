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
  projectId?: string
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
    projectId: input.projectId ?? 'project-1',
    projectionComponent: input.component,
    projectionIdentity: `${input.component}:identity`,
    scopeId: input.scopeId ?? 'project-1:article-1',
    scopeKind: input.scopeKind ?? 'article',
    sourcePartition: 'review-change',
    status: 'running',
  } satisfies ReviewServingDirtyWorkClaim
}

const getAdmittedRebuildRequest = (input: {projectId?: string; sourceWatermark?: number} = {}) => {
  return {
    projectId: input.projectId ?? 'project-1',
    sourceWatermarksJson: {dirtySourceWatermarks: {reviewChange: input.sourceWatermark ?? 1}},
    status: 'admitted',
  } as never
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
    queue: [getClaim({component: 'queue', dirtyWorkId: 'queue-1'})],
    selectedImport: [getClaim({component: 'selectedImport', dirtyWorkId: 'selected-import-1'})],
  })

  dependencies.runners = {
    humanStatus: async () => {
      order.push('humanStatus')

      return {processedCount: 1}
    },
    queue: async () => {
      order.push('queue')

      return {processedCount: 1}
    },
    selectedImport: async () => {
      order.push('selectedImport')

      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {
      batchSize: 1,
      componentOrder: ['humanStatus', 'queue', 'selectedImport'],
      maxRowsPerWake: 2,
      maxWakeMs: 1_000,
      wakeId: 'wake-1',
    },
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(order).toEqual(['humanStatus', 'queue'])
  expect(
    result.runs.map((run) => {
      return run.component
    }),
  ).toEqual(['humanStatus', 'queue'])
})

test('wake retries a failing projector batch and avoids marking it failed after replay succeeds', async () => {
  const {dependencies, failedClaimIds} = createDependencyHarness({
    queue: [getClaim({component: 'queue', dirtyWorkId: 'queue-1'})],
  })
  let attempts = 0

  dependencies.runners = {
    queue: async () => {
      attempts += 1

      if (attempts === 1) {
        throw new Error('transient projection failure')
      }

      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['queue'], maxRetries: 1, maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(result.runs[0]?.attempts).toBe(2)
  expect(failedClaimIds).toEqual([])
})

test('wake marks exhausted failures as failed lane blockers with diagnostics', async () => {
  const {dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    queue: [getClaim({component: 'queue', dirtyWorkId: 'queue-1'})],
  })

  dependencies.runners = {
    queue: async () => {
      throw new Error('projector crashed after write validation')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['queue'], maxRetries: 1, maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('failed')
  expect(result.failures).toEqual([
    {
      attempts: 2,
      claimIds: ['queue-1'],
      component: 'queue',
      diagnostic: 'projector crashed after write validation',
      status: 'failed',
    },
  ])
  expect(failedClaimIds).toEqual(['queue-1'])
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

    return Effect.succeed(getAdmittedRebuildRequest())
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

for (const component of ['payload', 'posting', 'summary', 'judgmentInputContent'] as const) {
  test(`wake routes article-scoped ${component} dirty work through chunked rebuilds before direct projection`, async () => {
    const {completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
      [component]: [getClaim({component, dirtyWorkId: `${component}-article-1`})],
    })
    const rebuildRequests: Array<{
      components: readonly ReviewServingProjectionComponent[] | undefined
      pageFirstOnly: boolean | undefined
      priority: number | undefined
      projectId: string
      reason: string
    }> = []
    let runnerCalled = false

    dependencies.requestRebuild = (input) => {
      rebuildRequests.push({
        components: input.components,
        pageFirstOnly: input.pageFirstOnly,
        priority: input.priority,
        projectId: input.projectId,
        reason: input.reason,
      })

      return Effect.succeed(getAdmittedRebuildRequest())
    }
    dependencies.runners = {
      [component]: async () => {
        runnerCalled = true

        return {processedCount: 1}
      },
    }

    const result = await wakeReviewServingProjectorService(
      {batchSize: 1, componentOrder: [component], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
      dependencies,
    )

    expect(result.status).toBe('completed')
    expect(result.runs).toEqual([{attempts: 1, claimCount: 1, component, processedCount: 0, status: 'completed'}])
    expect(runnerCalled).toBe(false)
    expect(rebuildRequests).toEqual([
      {
        components: [component],
        pageFirstOnly: undefined,
        priority: 50,
        projectId: 'project-1',
        reason: `${component}DirtyWork`,
      },
    ])
    expect(completedClaimIds).toEqual([`${component}-article-1`])
    expect(failedClaimIds).toEqual([])
    expect(releasedClaimIds).toEqual([])
  })
}

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

    return Effect.succeed(getAdmittedRebuildRequest())
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

test('wake retains chunked dirty work when an older active rebuild is reused', async () => {
  const {completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    search: [getClaim({component: 'search', dirtyWorkId: 'search-article-1', latestSourceHighWaterMark: 5})],
  })
  let runnerCalled = false

  dependencies.requestRebuild = () => {
    return Effect.succeed({
      projectId: 'project-1',
      sourceWatermarksJson: {reviewChange: 4},
      status: 'admitted',
    } as never)
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

  expect(result.status).toBe('partial')
  expect(runnerCalled).toBe(false)
  expect(completedClaimIds).toEqual([])
  expect(failedClaimIds).toEqual([])
  expect(releasedClaimIds).toEqual(['search-article-1'])
})

test('wake does not complete dirty work from another project with malformed rebuild watermarks', async () => {
  const {completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    search: [
      getClaim({
        component: 'search',
        dirtyWorkId: 'search-project-2',
        latestSourceHighWaterMark: 5,
        projectId: 'project-2',
        scopeId: 'project-2:article-1',
      }),
    ],
  })
  let runnerCalled = false

  dependencies.requestRebuild = () => {
    return Effect.succeed({projectId: 'project-1', sourceWatermarksJson: null, status: 'admitted'} as never)
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

  expect(result.status).toBe('partial')
  expect(runnerCalled).toBe(false)
  expect(completedClaimIds).toEqual([])
  expect(failedClaimIds).toEqual([])
  expect(releasedClaimIds).toEqual(['search-project-2'])
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

    return Effect.succeed(getAdmittedRebuildRequest())
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

const getProjectScopeLlmStatusClaim = () => {
  return {
    ...getClaim({
      articleId: null,
      component: 'llmStatus',
      dirtyWorkId: 'llm-status-project-1',
      latestSourceHighWaterMark: 3,
      scopeId: 'project-1',
      scopeKind: 'project',
    }),
    sourcePartition: 'projectReviewConfig:project-1',
  }
}

const getNonFreshRebuildRequest = (dirtySourceWatermarks: Record<string, number> | null) => {
  return {
    projectId: 'project-1',
    sourceWatermarksJson: {
      ...(dirtySourceWatermarks === null ? {} : {dirtySourceWatermarks}),
      judgments: {count: 0, updatedAt: null},
      snapshots: {count: 1, updatedAt: '2026-09-20T09:30:22.801Z'},
    },
    status: 'admitted',
  } as never
}

const wakeProjectScopeLlmStatusDirtyWork = async (dirtySourceWatermarks: Record<string, number> | null) => {
  const harness = createDependencyHarness({llmStatus: [getProjectScopeLlmStatusClaim()]})

  harness.dependencies.requestRebuild = () => {
    return Effect.succeed(getNonFreshRebuildRequest(dirtySourceWatermarks))
  }
  harness.dependencies.runners = {
    llmStatus: async () => {
      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['llmStatus'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    harness.dependencies,
  )

  return {...harness, result}
}

test('wake completes project-scope llm status dirty work only when the non-fresh rebuild carries its dirty source watermark', async () => {
  const covered = await wakeProjectScopeLlmStatusDirtyWork({projectReviewConfig: 3})
  const stale = await wakeProjectScopeLlmStatusDirtyWork({projectReviewConfig: 2})
  const statsOnly = await wakeProjectScopeLlmStatusDirtyWork(null)

  expect(covered.result.status).toBe('completed')
  expect(covered.completedClaimIds).toEqual(['llm-status-project-1'])
  expect(covered.releasedClaimIds).toEqual([])
  expect(covered.failedClaimIds).toEqual([])
  expect(stale.result.status).toBe('partial')
  expect(stale.completedClaimIds).toEqual([])
  expect(stale.releasedClaimIds).toEqual(['llm-status-project-1'])
  expect(statsOnly.result.status).toBe('partial')
  expect(statsOnly.completedClaimIds).toEqual([])
  expect(statsOnly.releasedClaimIds).toEqual(['llm-status-project-1'])
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

    return Effect.succeed(getAdmittedRebuildRequest())
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

    return Effect.succeed(getAdmittedRebuildRequest())
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

test('wake routes high-fanout selected import dirty work through chunked rebuilds instead of direct projection', async () => {
  const {completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    selectedImport: [
      getClaim({
        articleId: null,
        component: 'selectedImport',
        dirtyWorkId: 'selected-import-project-1',
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

    return Effect.succeed(getAdmittedRebuildRequest())
  }
  dependencies.runners = {
    selectedImport: async () => {
      runnerCalled = true

      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['selectedImport'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(result.runs).toEqual([
    {attempts: 1, claimCount: 1, component: 'selectedImport', processedCount: 0, status: 'completed'},
  ])
  expect(runnerCalled).toBe(false)
  expect(rebuildRequests).toEqual([
    {components: ['selectedImport'], priority: 10_000, projectId: 'project-1', reason: 'selectedImportDirtyWork'},
  ])
  expect(completedClaimIds).toEqual(['selected-import-project-1'])
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

    return Effect.succeed(getAdmittedRebuildRequest())
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

test('wake keeps article-scoped selected import dirty work on the direct patch path', async () => {
  const {completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    selectedImport: [getClaim({component: 'selectedImport', dirtyWorkId: 'selected-import-article-1'})],
  })
  const rebuildRequests: Array<{projectId: string; reason: string}> = []

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({projectId: input.projectId, reason: input.reason})

    return Effect.succeed(getAdmittedRebuildRequest())
  }
  dependencies.runners = {
    selectedImport: async () => {
      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['selectedImport'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(result.status).toBe('completed')
  expect(result.runs).toEqual([
    {attempts: 1, claimCount: 1, component: 'selectedImport', processedCount: 1, status: 'completed'},
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

    return Effect.succeed(getAdmittedRebuildRequest())
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

test('wake parks claimed work when a missing-snapshot rebuild request is blocked over budget', async () => {
  const {blockedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    queue: [getClaim({component: 'queue', dirtyWorkId: 'queue-1'})],
  })
  const rebuildRequests: Array<{projectId: string; reason: string; reuseBlockedRequestWithinMs: number | undefined}> =
    []

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({
      projectId: input.projectId,
      reason: input.reason,
      reuseBlockedRequestWithinMs: input.reuseBlockedRequestWithinMs,
    })

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

  expect(result.status).toBe('partial')
  expect(result.failures).toEqual([])
  expect(result.blockedRebuilds).toEqual([
    {
      claimIds: ['queue-1'],
      component: 'queue',
      diagnostic: 'estimated input rows exceed default request budget',
      status: 'blocked_by_rebuild',
    },
  ])
  expect(result.releasedClaimIds).toEqual(['queue-1'])
  expect(rebuildRequests).toEqual([
    {projectId: 'project-1', reason: 'missingReviewServingSnapshot', reuseBlockedRequestWithinMs: 3_600_000},
  ])
  expect(blockedClaimIds).toEqual(['queue-1'])
  expect(failedClaimIds).toEqual([])
  expect(releasedClaimIds).toEqual([])
})

test('wake parks chunked dirty work blocked over budget and keeps serving later components', async () => {
  const {blockedClaimIds, completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} = createDependencyHarness({
    display: [getClaim({component: 'display', dirtyWorkId: 'display-1'})],
    selectedImport: [
      getClaim({
        articleId: null,
        component: 'selectedImport',
        dirtyWorkId: 'selected-import-project-1',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ],
  })
  const rebuildRequests: Array<{
    components: readonly ReviewServingProjectionComponent[] | undefined
    projectId: string
    reason: string
    reuseBlockedRequestWithinMs: number | undefined
  }> = []

  dependencies.requestRebuild = (input) => {
    rebuildRequests.push({
      components: input.components,
      projectId: input.projectId,
      reason: input.reason,
      reuseBlockedRequestWithinMs: input.reuseBlockedRequestWithinMs,
    })

    return Effect.succeed({
      overBudgetReason: 'snapshot count: estimated 2 > max 1',
      projectId: 'project-1',
      status: 'blocked_over_budget',
    } as never)
  }
  dependencies.runners = {
    display: async () => {
      return {processedCount: 1}
    },
    selectedImport: async () => {
      throw new Error('runner should not execute')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {
      batchSize: 1,
      componentOrder: ['selectedImport', 'display'],
      maxRowsPerWake: 2,
      maxWakeMs: 1_000,
      wakeId: 'wake-1',
    },
    dependencies,
  )

  expect(result.status).toBe('partial')
  expect(result.failures).toEqual([])
  expect(result.blockedRebuilds).toEqual([
    {
      claimIds: ['selected-import-project-1'],
      component: 'selectedImport',
      diagnostic: 'snapshot count: estimated 2 > max 1',
      status: 'blocked_by_rebuild',
    },
  ])
  expect(result.runs).toEqual([
    {attempts: 1, claimCount: 1, component: 'display', processedCount: 1, status: 'completed'},
  ])
  expect(result.releasedClaimIds).toEqual(['selected-import-project-1'])
  expect(rebuildRequests).toEqual([
    {
      components: ['selectedImport'],
      projectId: 'project-1',
      reason: 'selectedImportDirtyWork',
      reuseBlockedRequestWithinMs: 3_600_000,
    },
  ])
  expect(blockedClaimIds).toEqual(['selected-import-project-1'])
  expect(completedClaimIds).toEqual([])
  expect(failedClaimIds).toEqual([])
  expect(releasedClaimIds).toEqual([])
})

test('wake completes formerly parked chunked dirty work once its rebuild request becomes admissible', async () => {
  const claim = getClaim({
    articleId: null,
    component: 'selectedImport',
    dirtyWorkId: 'selected-import-project-1',
    scopeId: 'project-1',
    scopeKind: 'project',
  })
  const pending: Partial<Record<ReviewServingProjectionComponent, ReviewServingDirtyWorkClaim[]>> = {
    selectedImport: [claim],
  }
  const {blockedClaimIds, completedClaimIds, dependencies, failedClaimIds, releasedClaimIds} =
    createDependencyHarness(pending)
  const wakeInput = {batchSize: 1, componentOrder: ['selectedImport' as const], maxRowsPerWake: 1, maxWakeMs: 1_000}

  dependencies.requestRebuild = () => {
    return Effect.succeed({
      overBudgetReason: 'input rows: estimated 1333664 > max 250000',
      projectId: 'project-1',
      status: 'blocked_over_budget',
    } as never)
  }
  dependencies.runners = {
    selectedImport: async () => {
      throw new Error('runner should not execute')
    },
  }

  const blockedWake = await wakeReviewServingProjectorService({...wakeInput, wakeId: 'wake-1'}, dependencies)

  expect(blockedWake.status).toBe('partial')
  expect(blockedWake.blockedRebuilds).toEqual([
    {
      claimIds: ['selected-import-project-1'],
      component: 'selectedImport',
      diagnostic: 'input rows: estimated 1333664 > max 250000',
      status: 'blocked_by_rebuild',
    },
  ])
  expect(blockedClaimIds).toEqual(['selected-import-project-1'])
  expect(completedClaimIds).toEqual([])

  pending.selectedImport = [claim]
  dependencies.requestRebuild = () => {
    return Effect.succeed(getAdmittedRebuildRequest({sourceWatermark: claim.latestSourceHighWaterMark}))
  }

  const admittedWake = await wakeReviewServingProjectorService({...wakeInput, wakeId: 'wake-2'}, dependencies)

  expect(admittedWake.status).toBe('completed')
  expect(admittedWake.blockedRebuilds).toEqual([])
  expect(admittedWake.failures).toEqual([])
  expect(admittedWake.runs).toEqual([
    {attempts: 1, claimCount: 1, component: 'selectedImport', processedCount: 0, status: 'completed'},
  ])
  expect(completedClaimIds).toEqual(['selected-import-project-1'])
  expect(blockedClaimIds).toEqual(['selected-import-project-1'])
  expect(failedClaimIds).toEqual([])
  expect(releasedClaimIds).toEqual([])
})

test('wake counts parked chunked dirty work against the row budget', async () => {
  const {claimedComponents, dependencies} = createDependencyHarness({
    display: [getClaim({component: 'display', dirtyWorkId: 'display-1'})],
    selectedImport: [
      getClaim({
        articleId: null,
        component: 'selectedImport',
        dirtyWorkId: 'selected-import-project-1',
        scopeId: 'project-1',
        scopeKind: 'project',
      }),
    ],
  })

  dependencies.requestRebuild = () => {
    return Effect.succeed({
      overBudgetReason: 'snapshot count: estimated 2 > max 1',
      status: 'blocked_over_budget',
    } as never)
  }
  dependencies.runners = {
    display: async () => {
      throw new Error('runner should not execute')
    },
    selectedImport: async () => {
      throw new Error('runner should not execute')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {
      batchSize: 1,
      componentOrder: ['selectedImport', 'display'],
      maxRowsPerWake: 1,
      maxWakeMs: 1_000,
      wakeId: 'wake-1',
    },
    dependencies,
  )

  expect(result.status).toBe('partial')
  expect(result.runs).toEqual([])
  expect(claimedComponents).toEqual(['selectedImport'])
})

test('wake keeps running later components after an earlier component fails', async () => {
  const {dependencies, failedClaimIds} = createDependencyHarness({
    display: [getClaim({component: 'display', dirtyWorkId: 'display-1'})],
    queue: [getClaim({component: 'queue', dirtyWorkId: 'queue-1'})],
  })

  dependencies.runners = {
    display: async () => {
      return {processedCount: 1}
    },
    queue: async () => {
      throw new Error('queue projector crashed')
    },
  }

  const result = await wakeReviewServingProjectorService(
    {
      batchSize: 1,
      componentOrder: ['queue', 'display'],
      maxRetries: 0,
      maxRowsPerWake: 2,
      maxWakeMs: 1_000,
      wakeId: 'wake-1',
    },
    dependencies,
  )

  expect(result.status).toBe('failed')
  expect(result.failures).toEqual([
    {attempts: 1, claimIds: ['queue-1'], component: 'queue', diagnostic: 'queue projector crashed', status: 'failed'},
  ])
  expect(result.runs).toEqual([
    {attempts: 1, claimCount: 1, component: 'display', processedCount: 1, status: 'completed'},
  ])
  expect(failedClaimIds).toEqual(['queue-1'])
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
  const {dependencies} = createDependencyHarness({queue: [getClaim({component: 'queue', dirtyWorkId: 'queue-1'})]})

  dependencies.promoteSnapshot = async (input: PromoteReviewServingProjectorSnapshotInput) => {
    return {
      error: 'candidate snapshot failed validation; active snapshot remains unchanged',
      promoted: false,
      snapshotId: input.snapshotId,
    }
  }
  dependencies.runners = {
    queue: async () => {
      return {
        candidateSnapshots: [{projectId: 'project-1', reviewConfigHash: 'review-config-1', snapshotId: 'candidate-1'}],
        processedCount: 1,
      }
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['queue'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
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

const wakeFirstClaimedComponent = async (input: {
  componentOrder?: readonly ReviewServingProjectionComponent[]
  componentRotationOffset: number
}) => {
  const allComponents: readonly ReviewServingProjectionComponent[] = [
    'projectScope',
    'selectedImport',
    'display',
    'llmStatus',
    'humanStatus',
    'queue',
    'payload',
    'posting',
    'summary',
    'judgmentInputContent',
    'search',
  ]
  const {claimedComponents, dependencies} = createDependencyHarness({})
  const nowValues = [0, 0]

  dependencies.nowMs = () => {
    return nowValues.shift() ?? 2_000
  }
  dependencies.runners = allComponents.reduce<ReviewServingProjectorServiceDependencies['runners']>(
    (runners, component) => {
      return {
        ...runners,
        [component]: async () => {
          return {processedCount: 1}
        },
      }
    },
    {},
  )

  await wakeReviewServingProjectorService(
    {
      batchSize: 1,
      componentOrder: input.componentOrder,
      componentRotationOffset: input.componentRotationOffset,
      maxRowsPerWake: 11,
      maxWakeMs: 1_000,
      wakeId: `wake-${input.componentRotationOffset}`,
    },
    dependencies,
  )

  return claimedComponents
}

test('wake rotates the default component order by the rotation offset so tail components periodically go first', async () => {
  expect(await wakeFirstClaimedComponent({componentRotationOffset: 0})).toEqual(['projectScope'])
  expect(await wakeFirstClaimedComponent({componentRotationOffset: 1})).toEqual(['selectedImport'])
  expect(await wakeFirstClaimedComponent({componentRotationOffset: 2})).toEqual(['display'])
  expect(await wakeFirstClaimedComponent({componentRotationOffset: 8})).toEqual(['summary'])
  expect(await wakeFirstClaimedComponent({componentRotationOffset: 9})).toEqual(['judgmentInputContent'])
  expect(await wakeFirstClaimedComponent({componentRotationOffset: 10})).toEqual(['search'])
  expect(await wakeFirstClaimedComponent({componentRotationOffset: 11})).toEqual(['projectScope'])
  expect(await wakeFirstClaimedComponent({componentRotationOffset: 23})).toEqual(['selectedImport'])
})

test('wake reports why it was blocked and lets an explicit caller admission override the queue depth rule', async () => {
  const wakeWithQueueState = async (
    queueState: Awaited<ReturnType<NonNullable<ReviewServingProjectorServiceDependencies['getQueueState']>>> | null,
    maxWakeMs = 1_000,
  ) => {
    const {claimedComponents, dependencies} = createDependencyHarness({
      queue: [getClaim({component: 'queue', dirtyWorkId: 'queue-1'})],
    })

    dependencies.getQueueState =
      queueState === null
        ? undefined
        : async () => {
            return queueState
          }
    dependencies.runners = {
      queue: async () => {
        return {processedCount: 1}
      },
    }

    const result = await wakeReviewServingProjectorService(
      {batchSize: 1, componentOrder: ['queue'], maxRowsPerWake: 1, maxWakeMs, wakeId: 'wake-1'},
      dependencies,
    )

    return {blockedReason: result.blockedReason, claimedComponents, status: result.status}
  }

  expect(await wakeWithQueueState({blocked: true, blockedReason: 'appendQueue'})).toEqual({
    blockedReason: 'appendQueue',
    claimedComponents: [],
    status: 'blocked',
  })
  expect(await wakeWithQueueState({blocked: true})).toMatchObject({blockedReason: 'foregroundQueue', status: 'blocked'})
  expect(await wakeWithQueueState({foregroundDuckdbQueueDepth: 1})).toMatchObject({
    blockedReason: 'foregroundQueue',
    status: 'blocked',
  })
  expect(await wakeWithQueueState({blocked: false, foregroundDuckdbQueueDepth: 1})).toEqual({
    blockedReason: null,
    claimedComponents: ['queue'],
    status: 'completed',
  })
  expect(await wakeWithQueueState({activeImportCount: 1}, 0)).toMatchObject({
    blockedReason: 'budget',
    status: 'blocked',
  })
  expect(await wakeWithQueueState(null)).toEqual({
    blockedReason: null,
    claimedComponents: ['queue'],
    status: 'completed',
  })
})

test('wake reports idle instead of blocked when the admitted sweep claims nothing', async () => {
  const {claimedComponents, dependencies} = createDependencyHarness({})

  dependencies.runners = {
    queue: async () => {
      return {processedCount: 1}
    },
  }

  const result = await wakeReviewServingProjectorService(
    {batchSize: 1, componentOrder: ['queue'], maxRowsPerWake: 1, maxWakeMs: 1_000, wakeId: 'wake-1'},
    dependencies,
  )

  expect(claimedComponents).toEqual(['queue'])
  expect(result).toMatchObject({blockedReason: null, runs: [], status: 'idle'})
})

test('wake never rotates an explicit component order', async () => {
  expect(
    await wakeFirstClaimedComponent({componentOrder: ['humanStatus', 'queue'], componentRotationOffset: 1}),
  ).toEqual(['humanStatus'])
  expect(await wakeFirstClaimedComponent({componentOrder: ['llmStatus'], componentRotationOffset: 10})).toEqual([
    'llmStatus',
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
