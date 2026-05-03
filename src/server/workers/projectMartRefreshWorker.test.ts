import {rmSync} from 'node:fs'

import {beforeEach, expect, mock, test} from 'bun:test'

import {
  defaultProjectMartRefreshWorkerDirtyArticleBatchSize,
  type ProjectMartRefreshRunnerService,
  type ProjectMartRefreshStateWorkerService,
  type ProjectMartRefreshWorkerDependencies,
  runProjectMartRefreshWorkerCycle,
  runProjectMartRefreshWorkerOnce,
} from './projectMartRefreshWorker.ts'

type ClaimPlan = {
  claimedToken: number
  lastCompletedToken: number
  leaseExpiresAt: Date
  projectId: string
  workerId: string
}

const getLastJsonLine = (output: string) => {
  return output
    .trim()
    .split('\n')
    .reverse()
    .find((line) => {
      return line.trim().startsWith('{')
    })
}

const createWorkerTestContext = (params: {
  ackPublishShouldThrow?: boolean
  activeServingGenerationByProject?: Record<string, boolean>
  articlesByProject?: Record<string, string[]>
  claims?: ClaimPlan[]
  onRefreshProjectArticleMartsBatch?: (projectId: string, articleIds: string[]) => Promise<void>
  quarantinedArticlesByProject?: Record<string, string[]>
  reconciledProjectIds?: string[]
  scopeArticleCountByProject?: Record<string, number>
}) => {
  const callLog: string[] = []
  const claims = [...(params.claims ?? [])]
  const dirtyArticlesByProject = Object.fromEntries(
    Object.entries(params.articlesByProject ?? {}).map(([projectId, articleIds]) => {
      return [projectId, [...articleIds]]
    }),
  )
  const quarantinedArticlesByProject = Object.fromEntries(
    Object.entries(params.quarantinedArticlesByProject ?? {}).map(([projectId, articleIds]) => {
      return [projectId, [...articleIds]]
    }),
  )
  const acknowledgedProjects: Array<{ackToken: number | null; projectId: string}> = []
  const completed: Array<{completedToken: number; projectId: string; workerId: string}> = []
  const failed: Array<{error: string; projectId: string; workerId: string}> = []
  const heartbeatCalls: Array<{leaseMs: number; projectId: string; workerId: string}> = []
  const released: Array<{projectId: string; workerId: string}> = []
  const stateService: ProjectMartRefreshStateWorkerService = {
    claimDirtyProjects: mock(async ({leaseMs, limit, workerId}: {leaseMs: number; limit: number; workerId: string}) => {
      callLog.push(`claim:${workerId}:${limit}:${leaseMs}`)
      const [claim] = claims

      return claim === undefined ? [] : [claims.shift() as ClaimPlan]
    }),
    clearArchivedProjectRefreshStates: mock(async () => {
      callLog.push('clearArchivedRefreshStates')
      return null
    }),
    completeDirtyArticleBatchForClaim: mock(
      async ({
        articleIds,
        claimedToken,
        projectId,
        workerId,
      }: {
        articleIds: string[]
        claimedToken: number
        projectId: string
        workerId: string
      }) => {
        callLog.push(`complete:${projectId}:${claimedToken}`)
        completed.push({completedToken: claimedToken, projectId, workerId})
        dirtyArticlesByProject[projectId] = (dirtyArticlesByProject[projectId] ?? []).filter((articleId) => {
          return !articleIds.includes(articleId)
        })
        const remainingArticleIds = dirtyArticlesByProject[projectId] ?? []
        const quarantinedArticleIds = new Set(quarantinedArticlesByProject[projectId] ?? [])
        const remainingHealthyArticleCount = remainingArticleIds.filter((articleId) => {
          return !quarantinedArticleIds.has(articleId)
        }).length
        const isBlockedByQuarantine = remainingHealthyArticleCount === 0 && remainingArticleIds.length > 0

        return {
          completedState: remainingArticleIds.length === 0 ? {} : null,
          isBlockedByQuarantine,
          isClaimComplete: remainingArticleIds.length === 0,
        }
      },
    ),
    completeProjectRefresh: mock(
      async ({completedToken, projectId, workerId}: {completedToken: number; projectId: string; workerId: string}) => {
        callLog.push(`complete:${projectId}:${completedToken}`)
        completed.push({completedToken, projectId, workerId})
        return null
      },
    ),
    failProjectRefresh: mock(
      async ({error, projectId, workerId}: {error: string; projectId: string; workerId: string}) => {
        callLog.push(`fail:${projectId}:${error}`)
        failed.push({error, projectId, workerId})
        return null
      },
    ),
    getDirtyArticleBatchForClaim: mock(
      async ({
        batchSize,
        projectId,
      }: {
        batchSize: number
        claimedToken: number
        projectId: string
        workerId: string
      }) => {
        callLog.push(`batch:${projectId}:${batchSize}`)
        const quarantinedArticleIds = new Set(quarantinedArticlesByProject[projectId] ?? [])
        const articleIds = (dirtyArticlesByProject[projectId] ?? []).filter((articleId) => {
          return !quarantinedArticleIds.has(articleId)
        })

        return {articleIds: articleIds.slice(0, batchSize), hasMore: articleIds.length > batchSize}
      },
    ),
    heartbeatClaim: mock(
      async ({leaseMs, projectId, workerId}: {leaseMs: number; projectId: string; workerId: string}) => {
        callLog.push(`heartbeat:${projectId}`)
        heartbeatCalls.push({leaseMs, projectId, workerId})
        return null
      },
    ),
    releaseProjectRefreshClaim: mock(async ({projectId, workerId}: {projectId: string; workerId: string}) => {
      callLog.push(`release:${projectId}`)
      released.push({projectId, workerId})
      return null
    }),
  }
  const refreshService: ProjectMartRefreshRunnerService = {
    hasActiveProjectReviewServingGeneration: mock(async (projectId: string) => {
      return params.activeServingGenerationByProject?.[projectId] ?? true
    }),
    refreshJudgmentArticle: mock(async (articleId: string) => {
      callLog.push(`judgment:${articleId}`)
    }),
    refreshJudgmentFactsForArticles: mock(async (articleIds: string[]) => {
      articleIds.forEach((articleId) => {
        callLog.push(`judgment:${articleId}`)
      })
    }),
    refreshProjectScopeArticles: mock(async (projectId: string, articleIds: string[]) => {
      articleIds.forEach((articleId) => {
        callLog.push(`scopeArticle:${projectId}:${articleId}`)
      })
    }),
    refreshProjectArticleMartsBatch: mock(async (projectId: string, articleIds: string[]) => {
      callLog.push(`articleMartsBatch:${projectId}:${articleIds.join(',')}`)
      return params.onRefreshProjectArticleMartsBatch?.(projectId, articleIds)
    }),
  }
  const remainingReconciledProjectIds = [...(params.reconciledProjectIds ?? [])]
  const sqliteService = {
    publishProjectRefreshAck: mock(async ({ackToken, projectId}: {ackToken: number | null; projectId: string}) => {
      callLog.push(`ack:${projectId}:${ackToken ?? 'null'}`)
      acknowledgedProjects.push({ackToken, projectId})

      if (params.ackPublishShouldThrow) {
        throw new Error('sqlite ack publish exploded')
      }

      return 1
    }),
    reconcileProjectRefreshAcks: mock(async ({projectId}: {projectId?: string} = {}) => {
      callLog.push(`reconcile:${projectId ?? 'all'}`)

      return projectId
        ? Number(remainingReconciledProjectIds.includes(projectId))
        : remainingReconciledProjectIds.splice(0, remainingReconciledProjectIds.length).length
    }),
  }
  const queuedLargeRebuilds: Array<{projectId: string; rebuildPhase: string; refreshToken: number}> = []
  const dependencies: ProjectMartRefreshWorkerDependencies = {
    largeRebuildStateService: {
      clearArchivedLargeRebuildStates: mock(async () => {
        callLog.push('clearArchivedLargeRebuildStates')
        return null
      }),
      queueLargeRebuild: mock(
        async ({
          projectId,
          rebuildPhase,
          refreshToken,
        }: {
          projectId: string
          rebuildPhase: string
          refreshToken: number
        }) => {
          callLog.push(`largeRebuild:${projectId}:${rebuildPhase}:${refreshToken}`)
          queuedLargeRebuilds.push({projectId, rebuildPhase, refreshToken})
          return null
        },
      ),
    },
    projectInspector: {
      getProjectScopeArticleCount: mock(async (projectId: string) => {
        callLog.push(`scope:${projectId}`)
        return params.scopeArticleCountByProject?.[projectId] ?? 0
      }),
    },
    refreshService,
    sleep: mock(async () => {}),
    sqliteService,
    stateService,
  }

  return {acknowledgedProjects, callLog, completed, dependencies, failed, heartbeatCalls, queuedLargeRebuilds}
}

beforeEach(() => {
  mock.restore()
})

test('one-shot worker reuses single-cycle behavior and exits after one claim attempt', async () => {
  const context = createWorkerTestContext({
    claims: [
      {
        claimedToken: 3,
        lastCompletedToken: 2,
        leaseExpiresAt: new Date('2026-04-02T13:00:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
      {
        claimedToken: 1,
        lastCompletedToken: 0,
        leaseExpiresAt: new Date('2026-04-02T13:00:30.000Z'),
        projectId: 'project-2',
        workerId: 'worker-1',
      },
    ],
  })

  const result = await runProjectMartRefreshWorkerOnce({leaseMs: 2_000, workerId: 'worker-1'}, context.dependencies)

  expect(result).toEqual({claimedToken: 3, projectId: 'project-1', status: 'completed', workerId: 'worker-1'})
  expect(context.callLog[0]).toBe('reconcile:all')
  expect(context.callLog[1]).toBe('claim:worker-1:1:2000')
  expect(context.completed).toEqual([{completedToken: 3, projectId: 'project-1', workerId: 'worker-1'}])
  expect(context.acknowledgedProjects).toEqual([{ackToken: 3, projectId: 'project-1'}])
})

test('claims at most one project per cycle', async () => {
  const context = createWorkerTestContext({
    claims: [
      {
        claimedToken: 3,
        lastCompletedToken: 2,
        leaseExpiresAt: new Date('2026-04-02T13:00:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
      {
        claimedToken: 1,
        lastCompletedToken: 0,
        leaseExpiresAt: new Date('2026-04-02T13:00:30.000Z'),
        projectId: 'project-2',
        workerId: 'worker-1',
      },
    ],
  })

  const result = await runProjectMartRefreshWorkerCycle({leaseMs: 2_000, workerId: 'worker-1'}, context.dependencies)

  expect(result).toEqual({claimedToken: 3, projectId: 'project-1', status: 'completed', workerId: 'worker-1'})
  expect(context.callLog[0]).toBe('reconcile:all')
  expect(context.callLog[1]).toBe('claim:worker-1:1:2000')
  expect(context.completed).toEqual([{completedToken: 3, projectId: 'project-1', workerId: 'worker-1'}])
  expect(context.acknowledgedProjects).toEqual([{ackToken: 3, projectId: 'project-1'}])
})

test('processes dirty articles through bounded batches until the claim is complete', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-2', 'article-1']},
    claims: [
      {
        claimedToken: 2,
        lastCompletedToken: 1,
        leaseExpiresAt: new Date('2026-04-02T13:10:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
  })

  await runProjectMartRefreshWorkerCycle({dirtyArticleBatchSize: 1, workerId: 'worker-1'}, context.dependencies)

  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-1:1:30000',
    'batch:project-1:1',
    'scopeArticle:project-1:article-2',
    'judgment:article-2',
    'articleMartsBatch:project-1:article-2',
    'complete:project-1:2',
    'batch:project-1:1',
    'scopeArticle:project-1:article-1',
    'judgment:article-1',
    'articleMartsBatch:project-1:article-1',
    'complete:project-1:2',
    'ack:project-1:2',
  ])
})

test('parks dirty claims held behind quarantined article barriers', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-quarantined', 'article-healthy']},
    claims: [
      {
        claimedToken: 2,
        lastCompletedToken: 1,
        leaseExpiresAt: new Date('2026-04-02T13:10:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
    quarantinedArticlesByProject: {'project-1': ['article-quarantined']},
  })

  const result = await runProjectMartRefreshWorkerCycle(
    {dirtyArticleBatchSize: 5, workerId: 'worker-1'},
    context.dependencies,
  )

  expect(result).toEqual({
    claimedToken: 2,
    projectId: 'project-1',
    status: 'blocked_by_quarantine',
    workerId: 'worker-1',
  })
  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-1:1:30000',
    'batch:project-1:5',
    'scopeArticle:project-1:article-healthy',
    'judgment:article-healthy',
    'articleMartsBatch:project-1:article-healthy',
    'complete:project-1:2',
  ])
  expect(context.failed).toEqual([])
  expect(context.acknowledgedProjects).toEqual([])
})

test('uses dirty article batch size for article-aware refresh routing', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-1', 'article-2']},
    claims: [
      {
        claimedToken: 3,
        lastCompletedToken: 2,
        leaseExpiresAt: new Date('2026-04-02T13:10:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
  })

  await runProjectMartRefreshWorkerCycle({dirtyArticleBatchSize: 2, workerId: 'worker-1'}, context.dependencies)

  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-1:1:30000',
    'batch:project-1:2',
    'scopeArticle:project-1:article-1',
    'scopeArticle:project-1:article-2',
    'judgment:article-1',
    'judgment:article-2',
    'articleMartsBatch:project-1:article-1,article-2',
    'complete:project-1:3',
    'ack:project-1:3',
  ])
})

test('does not route large dirty-article deltas into full project refreshes', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-1', 'article-2', 'article-3', 'article-4']},
    claims: [
      {
        claimedToken: 5,
        lastCompletedToken: 4,
        leaseExpiresAt: new Date('2026-04-02T13:10:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
  })

  await runProjectMartRefreshWorkerCycle({dirtyArticleBatchSize: 3, workerId: 'worker-1'}, context.dependencies)

  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-1:1:30000',
    'batch:project-1:3',
    'scopeArticle:project-1:article-1',
    'scopeArticle:project-1:article-2',
    'scopeArticle:project-1:article-3',
    'judgment:article-1',
    'judgment:article-2',
    'judgment:article-3',
    'articleMartsBatch:project-1:article-1,article-2,article-3',
    'complete:project-1:5',
    'batch:project-1:3',
    'scopeArticle:project-1:article-4',
    'judgment:article-4',
    'articleMartsBatch:project-1:article-4',
    'complete:project-1:5',
    'ack:project-1:5',
  ])
  expect(context.queuedLargeRebuilds).toEqual([])
})

test('records failures when a claimed refresh errors', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-1']},
    claims: [
      {
        claimedToken: 7,
        lastCompletedToken: 6,
        leaseExpiresAt: new Date('2026-04-02T13:20:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
    onRefreshProjectArticleMartsBatch: async () => {
      throw new Error('article marts batch exploded')
    },
  })

  const result = await runProjectMartRefreshWorkerCycle(
    {dirtyArticleBatchSize: 1, workerId: 'worker-1'},
    context.dependencies,
  )

  expect(result).toEqual({
    claimedToken: 7,
    error: 'article marts batch exploded',
    projectId: 'project-1',
    status: 'failed',
    workerId: 'worker-1',
  })
  expect(context.failed).toEqual([
    {error: 'article marts batch exploded', projectId: 'project-1', workerId: 'worker-1'},
  ])
  expect(context.completed).toEqual([])
  expect(context.acknowledgedProjects).toEqual([])
})

test('queues bounded initial setup when no active serving generation exists', async () => {
  const context = createWorkerTestContext({
    activeServingGenerationByProject: {'project-1': false},
    articlesByProject: {'project-1': ['article-1', 'article-2', 'article-3', 'article-4']},
    claims: [
      {
        claimedToken: 9,
        lastCompletedToken: 8,
        leaseExpiresAt: new Date('2026-04-02T13:20:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
    scopeArticleCountByProject: {'project-1': 200_000},
  })

  const result = await runProjectMartRefreshWorkerCycle(
    {dirtyArticleBatchSize: 3, workerId: 'worker-1'},
    context.dependencies,
  )

  expect(result).toEqual({claimedToken: 9, projectId: 'project-1', status: 'completed', workerId: 'worker-1'})
  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-1:1:30000',
    'scope:project-1',
    'largeRebuild:project-1:project_scope_article:9',
    'release:project-1',
  ])
  expect(context.queuedLargeRebuilds).toEqual([
    {projectId: 'project-1', rebuildPhase: 'project_scope_article', refreshToken: 9},
  ])
  expect(context.failed).toEqual([])
  expect(context.completed).toEqual([])
  expect(context.acknowledgedProjects).toEqual([])
})

test('large active projects keep normal dirty churn on the batch path', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-1', 'article-2', 'article-3', 'article-4']},
    claims: [
      {
        claimedToken: 9,
        lastCompletedToken: 8,
        leaseExpiresAt: new Date('2026-04-02T13:20:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
    scopeArticleCountByProject: {'project-1': 2_000_000},
  })

  const result = await runProjectMartRefreshWorkerCycle(
    {dirtyArticleBatchSize: 2, workerId: 'worker-1'},
    context.dependencies,
  )

  expect(result).toEqual({claimedToken: 9, projectId: 'project-1', status: 'completed', workerId: 'worker-1'})
  expect(context.queuedLargeRebuilds).toEqual([])
  expect(context.callLog).not.toContain('scope:project-1')
  expect(context.callLog).not.toContain('largeRebuild:project-1:project_scope_article:9')
  expect(context.callLog).not.toContain('project:project-1')
  expect(context.acknowledgedProjects).toEqual([{ackToken: 9, projectId: 'project-1'}])
})

test('can process work reclaimed after an expired lease', async () => {
  const context = createWorkerTestContext({
    articlesByProject: {'project-1': ['article-1']},
    claims: [
      {
        claimedToken: 4,
        lastCompletedToken: 3,
        leaseExpiresAt: new Date('2026-04-02T13:30:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-2',
      },
    ],
  })

  const result = await runProjectMartRefreshWorkerCycle(
    {dirtyArticleBatchSize: 1, leaseMs: 5_000, workerId: 'worker-2'},
    context.dependencies,
  )

  expect(result).toEqual({claimedToken: 4, projectId: 'project-1', status: 'completed', workerId: 'worker-2'})
  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-2:1:5000',
    'batch:project-1:1',
    'scopeArticle:project-1:article-1',
    'judgment:article-1',
    'articleMartsBatch:project-1:article-1',
    'complete:project-1:4',
    'ack:project-1:4',
  ])
})

test('returns idle when nothing is claimable', async () => {
  const context = createWorkerTestContext({})

  const result = await runProjectMartRefreshWorkerCycle({workerId: 'worker-1'}, context.dependencies)

  expect(result).toEqual({projectId: null, status: 'idle', workerId: 'worker-1'})
  expect(context.callLog).toEqual(['reconcile:all', 'claim:worker-1:1:30000'])
})

test('replays sqlite ack publication after a post-completion crash without rerunning refresh work', async () => {
  const crashContext = createWorkerTestContext({
    ackPublishShouldThrow: true,
    articlesByProject: {'project-1': ['article-1']},
    claims: [
      {
        claimedToken: 8,
        lastCompletedToken: 7,
        leaseExpiresAt: new Date('2026-04-02T13:40:30.000Z'),
        projectId: 'project-1',
        workerId: 'worker-1',
      },
    ],
  })

  try {
    await runProjectMartRefreshWorkerCycle({workerId: 'worker-1'}, crashContext.dependencies)
    throw new Error('Expected sqlite ack publish failure')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : '').toBe('sqlite ack publish exploded')
  }
  expect(crashContext.completed).toEqual([{completedToken: 8, projectId: 'project-1', workerId: 'worker-1'}])
  expect(crashContext.failed).toEqual([])

  const reconcileContext = createWorkerTestContext({reconciledProjectIds: ['project-1']})

  const result = await runProjectMartRefreshWorkerCycle({workerId: 'worker-1'}, reconcileContext.dependencies)

  expect(result).toEqual({projectId: null, status: 'idle', workerId: 'worker-1'})
  expect(reconcileContext.callLog).toEqual(['reconcile:all', 'claim:worker-1:1:30000'])
  expect(reconcileContext.completed).toEqual([])
  expect(reconcileContext.failed).toEqual([])
})

test('dirty batch routing keeps review pages counts warnings and prompt queueing aligned across batch sizes', () => {
  const runWorkerMode = (duckdbPath: string, dirtyArticleBatchSize: number) => {
    const runScript = globalThis.Bun.spawnSync(
      [
        'bun',
        '-e',
        `
          const {Elysia} = await import('elysia')
          const {migrateDuckdb} = await import('./src/db/migrateDuckdb.ts')
          const {getAppDatabaseService} = await import('./src/server/services/appDatabaseService.ts')
          const {getDuckdbMartRefreshService} = await import('./src/server/services/getDuckdbMartRefreshService.ts')
          const {getProjectMartDirtyRefreshStateService} = await import('./src/server/services/projectMartDirtyRefreshStateService.ts')
          const {projectsRoutesGetReviewsWarnings} = await import('./src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts')
          const {judgmentsJobsCronGetPrompts} = await import('./src/server/cron/judgmentsJobs/judgmentsJobsCronGetPrompts.ts')
          const {queryArticlesReviewsFromDuckdb, getUnassessedCountFromDuckdb} = await import('./src/services/olap/duckdbOlap.ts')
          const {runProjectMartRefreshWorkerCycle} = await import('./src/server/workers/projectMartRefreshWorker.ts')

          await migrateDuckdb()

          const database = getAppDatabaseService()
          const martRefreshService = getDuckdbMartRefreshService()
          const refreshStateService = getProjectMartDirtyRefreshStateService()

          await database.run(\`
            INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
            VALUES ('connection-worker-routing-test', 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
          \`)
          await database.run(\`
            INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
            VALUES ('model-worker-routing-test', 'connection-worker-routing-test', 'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen 35B', 'manual', TRUE)
          \`)
          await database.run(\`
            INSERT INTO app.project (id, name, model_id, use_title, use_abstract, use_fulltext, use_fulltext_no_images)
            VALUES ('project-worker-routing-test', 'Worker Routing Project', 'model-worker-routing-test', TRUE, TRUE, FALSE, FALSE)
          \`)
          await database.run(\`
            INSERT INTO app.prompt (id, original_text, content_hash)
            VALUES
              ('prompt-worker-routing-1', 'Prompt 1', 'hash-worker-routing-1'),
              ('prompt-worker-routing-2', 'Prompt 2', 'hash-worker-routing-2')
          \`)
          await database.run(\`
            INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, enabled)
            VALUES
              ('project-prompt-worker-routing-1', 'project-worker-routing-test', 'prompt-worker-routing-1', 1, TRUE),
              ('project-prompt-worker-routing-2', 'project-worker-routing-test', 'prompt-worker-routing-2', 2, TRUE)
          \`)
          await database.run(\`
            INSERT INTO app.article (id, article_title, article_created_at, article_updated_at, article_id)
            VALUES
              ('article-worker-routing-1', 'Worker Routing Article 1', '2024-01-02T00:00:00.000Z', '2024-01-03T00:00:00.000Z', 'external-worker-routing-1'),
              ('article-worker-routing-2', 'Worker Routing Article 2', '2024-01-04T00:00:00.000Z', '2024-01-05T00:00:00.000Z', 'external-worker-routing-2')
          \`)
          await database.run(\`
            INSERT INTO app.project_article (id, project_id, article_id)
            VALUES
              ('project-article-worker-routing-1', 'project-worker-routing-test', 'article-worker-routing-1'),
              ('project-article-worker-routing-2', 'project-worker-routing-test', 'article-worker-routing-2')
          \`)
          await database.run(\`
            INSERT INTO app.judgment (
              id,
              article_id,
              prompt_id,
              model_id,
              project_id,
              snapshot_project_id,
              use_title,
              use_abstract,
              use_fulltext,
              use_fulltext_no_images,
              is_answered,
              answered_original,
              answered_original_as_array,
              confidence_original
            ) VALUES
              (
                'judgment-worker-routing-1a',
                'article-worker-routing-1',
                'prompt-worker-routing-1',
                'model-worker-routing-test',
                'project-worker-routing-test',
                'project-worker-routing-test',
                TRUE,
                TRUE,
                FALSE,
                FALSE,
                TRUE,
                'yes',
                ['yes'],
                90
              ),
              (
                'judgment-worker-routing-1b',
                'article-worker-routing-1',
                'prompt-worker-routing-2',
                'model-worker-routing-test',
                'project-worker-routing-test',
                'project-worker-routing-test',
                TRUE,
                TRUE,
                FALSE,
                FALSE,
                TRUE,
                'maybe',
                ['maybe'],
                80
              ),
              (
                'judgment-worker-routing-2a',
                'article-worker-routing-2',
                'prompt-worker-routing-1',
                'model-worker-routing-test',
                'project-worker-routing-test',
                'project-worker-routing-test',
                TRUE,
                TRUE,
                FALSE,
                FALSE,
                TRUE,
                'no',
                ['no'],
                75
              )
          \`)

          await martRefreshService.refreshProject('project-worker-routing-test')

          await database.run(\`
            UPDATE app.judgment
            SET answered_original = 'include',
                answered_original_as_array = ['include'],
                updated_at = current_timestamp
            WHERE id = 'judgment-worker-routing-1a'
          \`)

          await refreshStateService.markProjectsDirtyAtomically({
            projects: [{
              articleIds: ['article-worker-routing-1'],
              projectId: 'project-worker-routing-test',
            }],
            reason: 'projectMartRefreshWorker.test.delta',
          })

          await runProjectMartRefreshWorkerCycle({
            dirtyArticleBatchSize: Number(process.env.WORKER_DIRTY_ARTICLE_BATCH_SIZE ?? '1'),
            workerId: 'worker-routing-delta',
          })

          const reviews = await queryArticlesReviewsFromDuckdb({limit: 10, page: 1, projectId: 'project-worker-routing-test'})
          const unassessedCount = await getUnassessedCountFromDuckdb({jobId: 'job-worker-routing-test', projectId: 'project-worker-routing-test'})
          const promptQueue = await judgmentsJobsCronGetPrompts('project-worker-routing-test', 'job-worker-routing-test', 10)

          const app = new Elysia().use(projectsRoutesGetReviewsWarnings)
          const warningsResponse = await app.handle(
            new Request('http://localhost/api/projectsreviewswarnings', {
              body: JSON.stringify({projectId: 'project-worker-routing-test'}),
              headers: {'content-type': 'application/json'},
              method: 'POST',
            }),
          )
          const warningsResponseBody = await warningsResponse.json()
          const warnings = warningsResponseBody.data
          const [refreshState] = await database.queryJson(\`
            SELECT
              CAST(dirty_token AS INTEGER) AS dirtyToken,
              CAST(last_completed_dirty_token AS INTEGER) AS lastCompletedDirtyToken,
              refresh_status AS refreshStatus
            FROM app.project_mart_refresh_state
            WHERE project_id = 'project-worker-routing-test'
            LIMIT 1
          \`)

          console.log(JSON.stringify({
            promptEntries: promptQueue.promptEntries,
            refreshState,
            reviews: {
              data: reviews.data.map((row) => {
                return {
                  id: row.id,
                  isFullyJudged: row.isFullyJudged,
                  judgedPromptIds: row.judgedPromptIds,
                }
              }),
              totalCount: reviews.totalCount,
            },
            unassessedCount,
            warnings: {
              indexing: {
                inFlightArticleRefreshCount: warnings.indexing.inFlightArticleRefreshCount,
                inFlightProjectRefreshCount: warnings.indexing.inFlightProjectRefreshCount,
                oldestQueuedAt: warnings.indexing.oldestQueuedAt,
                queuedArticleRefreshCount: warnings.indexing.queuedArticleRefreshCount,
                queuedProjectRefreshCount: warnings.indexing.queuedProjectRefreshCount,
                queuedRefreshCount: warnings.indexing.queuedRefreshCount,
                status: warnings.indexing.status,
              },
              warning: warnings.warning,
            },
          }))

          await database.close()
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          API_SERVER_PORT: '3001',
          DUCKDB_PATH: duckdbPath,
          SERVER_ROLE: 'dev-single',
          VITE_PORT: '3000',
          WORKER_DIRTY_ARTICLE_BATCH_SIZE: String(dirtyArticleBatchSize),
        },
      },
    )

    if (runScript.exitCode !== 0) {
      throw new Error(
        runScript.stderr.toString() || runScript.stdout.toString() || 'Worker dirty batch routing parity test failed',
      )
    }

    const resultLine = getLastJsonLine(runScript.stdout.toString())

    if (!resultLine) {
      throw new Error(runScript.stdout.toString() || 'Missing JSON result from worker dirty batch routing test')
    }

    return JSON.parse(resultLine) as {
      promptEntries: Array<{articleId: string; promptId: string}>
      refreshState: {dirtyToken: number; lastCompletedDirtyToken: number; refreshStatus: string}
      reviews: {data: Array<{id: string; isFullyJudged: boolean; judgedPromptIds: string[]}>; totalCount: number | null}
      unassessedCount: number
      warnings: unknown
    }
  }

  const singleBatchDuckdbPath = `/tmp/f1-worker-routing-single-batch-${Date.now()}.duckdb`
  const defaultBatchDuckdbPath = `/tmp/f1-worker-routing-default-batch-${Date.now()}.duckdb`

  try {
    const singleBatchResult = runWorkerMode(singleBatchDuckdbPath, 1)
    const defaultBatchResult = runWorkerMode(
      defaultBatchDuckdbPath,
      defaultProjectMartRefreshWorkerDirtyArticleBatchSize,
    )

    expect(singleBatchResult).toEqual(defaultBatchResult)
    expect(singleBatchResult.reviews.data).toEqual([
      {id: 'article-worker-routing-2', isFullyJudged: false, judgedPromptIds: ['prompt-worker-routing-1']},
      {
        id: 'article-worker-routing-1',
        isFullyJudged: true,
        judgedPromptIds: ['prompt-worker-routing-1', 'prompt-worker-routing-2'],
      },
    ])
    expect(singleBatchResult.unassessedCount).toBe(1)
    expect(singleBatchResult.promptEntries).toEqual([
      {articleId: 'article-worker-routing-2', promptId: 'prompt-worker-routing-2'},
    ])
  } finally {
    for (const path of [singleBatchDuckdbPath, defaultBatchDuckdbPath]) {
      rmSync(path, {force: true})
      rmSync(`${path}.duckdb-owner.lock`, {force: true})
      rmSync(`${path}.duckdb-owner.history.json`, {force: true})
    }
  }
})
