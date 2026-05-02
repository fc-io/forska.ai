import {beforeEach, expect, mock, test} from 'bun:test'

import {
  getProjectMartLargeRebuildRuntimeMetrics,
  resetProjectMartLargeRebuildRuntimeMetricsForTests,
} from '../utils/projectMartLargeRebuildRuntimeMetrics.ts'
import {
  type ProjectMartLargeRebuildRunnerDependencies,
  runProjectMartLargeRebuildCycle,
} from './projectMartLargeRebuildRunner.ts'

beforeEach(() => {
  resetProjectMartLargeRebuildRuntimeMetricsForTests()
})

const createRunnerContext = (params: {
  batchRows?: Array<{
    articleCreatedAt: Date | null
    articleId: string
    articleUpdatedAt: Date | null
    inCuratedScope: boolean
    inRouteScope: boolean
  }>
  martBatchRows?: Array<{
    articleCreatedAt: Date | null
    articleId: string
    articleUpdatedAt: Date | null
    inCuratedScope: boolean
    inRouteScope: boolean
  }>
  claim?: {
    leaseExpiresAt: Date
    projectId: string
    rebuildPhase:
      | 'project_scope_article'
      | 'judgment_fact'
      | 'prompt_answer_fact'
      | 'review_answer_dictionary'
      | 'review_article_filter_member'
      | 'review_article_rollup'
      | 'review_article_serving'
    refreshToken: number
    workerId: string
  }
  state?: {
    cursorArticleCreatedAt: Date | null
    cursorArticleId: string | null
    projectId: string
    rebuildPhase: string
    targetGeneration: number | null
  } | null
}) => {
  const callLog: string[] = []
  const completed: string[] = []
  const failed: Array<{error: string; projectId: string}> = []
  const finalizedRefreshes: Array<{completedToken: number; projectId: string}> = []
  const publishedAcks: Array<{ackToken: number | null; projectId: string}> = []
  const resets: Array<{
    cursorArticleCreatedAt: Date | null
    cursorArticleId: string | null
    projectId: string
    rebuildPhase?: string
    targetGeneration?: number | null
  }> = []
  const scopeBatches: string[][] = []
  const rebuildBatches: string[][] = []
  const dictionaryRebuilds: string[] = []
  const dictionaryResets: string[] = []
  const claim = params.claim ?? null
  const dependencies: ProjectMartLargeRebuildRunnerDependencies = {
    executor: {
      finalizeProjectReviewServing: mock(async (projectId: string, targetGeneration: number) => {
        callLog.push(`serving:finalize:${projectId}:${targetGeneration}`)
      }),
      getNextBatchCursor: (rows: Array<{articleCreatedAt: Date | string | null; articleId: string}>) => {
        const [lastRow] = rows.slice(-1)
        return lastRow ? {articleCreatedAt: lastRow.articleCreatedAt, articleId: lastRow.articleId} : null
      },
      getProjectScopeMartBatch: mock(async ({projectId}: {projectId: string}) => {
        callLog.push(`mart-batch:${projectId}`)
        return params.martBatchRows ?? params.batchRows ?? []
      }),
      getProjectScopeSourceBatch: mock(async ({projectId}: {projectId: string}) => {
        callLog.push(`source-batch:${projectId}`)
        return params.batchRows ?? []
      }),
      rebuildProjectScopeBatch: mock(async (projectId: string, rows: Array<{articleId: string}>) => {
        const articleIds = rows.map((row) => {
          return row.articleId
        })
        callLog.push(`scope:rebuild:${projectId}:${articleIds.join(',')}`)
        scopeBatches.push(articleIds)
      }),
      rebuildProjectJudgmentFactBatch: mock(async (projectId: string, articleIds: string[]) => {
        callLog.push(`judgment:rebuild:${projectId}:${articleIds.join(',')}`)
      }),
      rebuildProjectPromptAnswerFactBatch: mock(async (projectId: string, articleIds: string[]) => {
        callLog.push(`rebuild:${projectId}:${articleIds.join(',')}`)
        rebuildBatches.push(articleIds)
      }),
      rebuildProjectReviewAnswerDictionary: mock(async (projectId: string) => {
        callLog.push(`dictionary:rebuild:${projectId}`)
        dictionaryRebuilds.push(projectId)
      }),
      rebuildProjectReviewArticleFilterMemberBatch: mock(
        async (projectId: string, articleIds: string[], targetGeneration: number) => {
          callLog.push(`filter:rebuild:${projectId}:${articleIds.join(',')}:${targetGeneration}`)
        },
      ),
      rebuildProjectReviewArticleRollupBatch: mock(async (projectId: string, articleIds: string[]) => {
        callLog.push(`rollup:rebuild:${projectId}:${articleIds.join(',')}`)
      }),
      rebuildProjectReviewServingBatch: mock(
        async (projectId: string, articleIds: string[], targetGeneration: number) => {
          callLog.push(`serving:rebuild:${projectId}:${articleIds.join(',')}:${targetGeneration}`)
        },
      ),
      resetProjectScope: mock(async (projectId: string) => {
        callLog.push(`scope:reset:${projectId}`)
      }),
      resetProjectJudgmentFact: mock(async (projectId: string) => {
        callLog.push(`judgment:reset:${projectId}`)
      }),
      resetProjectPromptAnswerFact: mock(async (projectId: string) => {
        callLog.push(`reset:${projectId}`)
      }),
      resetProjectReviewAnswerDictionary: mock(async (projectId: string) => {
        callLog.push(`dictionary:reset:${projectId}`)
        dictionaryResets.push(projectId)
      }),
      resetProjectReviewArticleRollup: mock(async (projectId: string) => {
        callLog.push(`rollup:reset:${projectId}`)
      }),
      setupProjectReviewServingStaging: mock(async (projectId: string, targetGeneration: number) => {
        callLog.push(`serving:setup:${projectId}:${targetGeneration}`)
      }),
    },
    largeRebuildStateService: {
      clearArchivedLargeRebuildStates: mock(async () => {
        callLog.push('clearArchived')
      }),
      claimLargeRebuilds: mock(async () => {
        callLog.push('claim')
        return claim ? [claim] : []
      }),
      completeLargeRebuild: mock(async ({projectId}: {projectId: string}) => {
        callLog.push(`complete:${projectId}`)
        completed.push(projectId)
        return null
      }),
      ensureLargeRebuildTargetGeneration: mock(async ({projectId}: {projectId: string}) => {
        callLog.push(`target:${projectId}`)

        return params.state === null || params.state === undefined
          ? null
          : {...params.state, targetGeneration: params.state.targetGeneration ?? 1}
      }),
      failLargeRebuild: mock(async ({error, projectId}: {error: string; projectId: string}) => {
        callLog.push(`fail:${projectId}:${error}`)
        failed.push({error, projectId})
        return null
      }),
      getLargeRebuildState: mock(async (projectId: string) => {
        callLog.push(`state:${projectId}`)
        return params.state ?? null
      }),
      heartbeatLargeRebuildClaim: mock(async ({projectId}: {projectId: string}) => {
        callLog.push(`heartbeat:${projectId}`)
        return null
      }),
      resetLargeRebuild: mock(
        async ({
          cursorArticleCreatedAt,
          cursorArticleId,
          projectId,
          rebuildPhase,
          targetGeneration,
        }: {
          cursorArticleCreatedAt?: Date | null
          cursorArticleId?: string | null
          projectId: string
          rebuildPhase?: string
          targetGeneration?: number | null
        }) => {
          callLog.push(`advance:${projectId}:${cursorArticleId ?? 'null'}:${rebuildPhase ?? 'same'}`)
          resets.push({
            cursorArticleCreatedAt: cursorArticleCreatedAt ?? null,
            cursorArticleId: cursorArticleId ?? null,
            projectId,
            rebuildPhase,
            targetGeneration,
          })
          return null
        },
      ),
    },
    refreshStateService: {
      finalizeProjectRefreshAfterLargeRebuild: mock(
        async ({completedToken, projectId}: {completedToken: number; projectId: string}) => {
          callLog.push(`refresh:complete:${projectId}:${completedToken}`)
          finalizedRefreshes.push({completedToken, projectId})
          return null
        },
      ),
    },
    sqliteService: {
      publishProjectRefreshAck: mock(async ({ackToken, projectId}: {ackToken: number | null; projectId: string}) => {
        callLog.push(`ack:${projectId}:${ackToken}`)
        publishedAcks.push({ackToken, projectId})
        return 1
      }),
    },
  }

  return {
    callLog,
    completed,
    dependencies,
    dictionaryRebuilds,
    dictionaryResets,
    failed,
    finalizedRefreshes,
    publishedAcks,
    rebuildBatches,
    resets,
    scopeBatches,
  }
}

test('returns idle when no large rebuild work is claimable', async () => {
  const context = createRunnerContext({})

  const result = await runProjectMartLargeRebuildCycle({workerId: 'worker-1'}, context.dependencies)
  const runtimeMetrics = getProjectMartLargeRebuildRuntimeMetrics()

  expect(result).toEqual({projectId: null, status: 'idle', workerId: 'worker-1'})
  expect(context.callLog).toEqual(['claim'])
  expect(runtimeMetrics.totals.cyclesIdle).toBe(1)
  expect(runtimeMetrics.recentCycles).toHaveLength(1)
  expect(runtimeMetrics.recentCycles[0]).toMatchObject({
    articleCount: 0,
    error: null,
    phase: null,
    projectId: null,
    status: 'idle',
    workerId: 'worker-1',
  })
})

test('runs one project_scope_article batch and advances the cursor without judgment fact work', async () => {
  const context = createRunnerContext({
    batchRows: [
      {
        articleCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
        articleId: 'article-1',
        articleUpdatedAt: new Date('2026-04-01T01:00:00.000Z'),
        inCuratedScope: true,
        inRouteScope: false,
      },
      {
        articleCreatedAt: new Date('2026-04-02T00:00:00.000Z'),
        articleId: 'article-2',
        articleUpdatedAt: new Date('2026-04-02T01:00:00.000Z'),
        inCuratedScope: false,
        inRouteScope: true,
      },
    ],
    claim: {
      leaseExpiresAt: new Date('2026-04-03T10:00:00.000Z'),
      projectId: 'project-1',
      rebuildPhase: 'project_scope_article',
      refreshToken: 9,
      workerId: 'worker-1',
    },
    state: {
      cursorArticleCreatedAt: null,
      cursorArticleId: null,
      projectId: 'project-1',
      rebuildPhase: 'project_scope_article',
      targetGeneration: null,
    },
  })

  const result = await runProjectMartLargeRebuildCycle({workerId: 'worker-1'}, context.dependencies)
  const runtimeMetrics = getProjectMartLargeRebuildRuntimeMetrics()

  expect(result).toEqual({
    articleCount: 2,
    nextCursor: {articleCreatedAt: new Date('2026-04-02T00:00:00.000Z'), articleId: 'article-2'},
    projectId: 'project-1',
    status: 'progressed',
    workerId: 'worker-1',
  })
  expect(context.callLog).toEqual([
    'claim',
    'state:project-1',
    'scope:reset:project-1',
    'source-batch:project-1',
    'scope:rebuild:project-1:article-1,article-2',
    'advance:project-1:article-2:project_scope_article',
  ])
  expect(context.scopeBatches).toEqual([['article-1', 'article-2']])
  expect(context.rebuildBatches).toEqual([])
  expect(runtimeMetrics.totals.cyclesProgressed).toBe(1)
  expect(runtimeMetrics.totals.rowsProcessed).toBe(2)
  expect(runtimeMetrics.recentCycles[0]).toMatchObject({
    articleCount: 2,
    error: null,
    phase: 'project_scope_article',
    projectId: 'project-1',
    status: 'progressed',
    workerId: 'worker-1',
  })
})

test('transitions from project_scope_article to judgment_fact when no source rows remain for the current cursor', async () => {
  const context = createRunnerContext({
    batchRows: [],
    claim: {
      leaseExpiresAt: new Date('2026-04-03T10:00:00.000Z'),
      projectId: 'project-1',
      rebuildPhase: 'project_scope_article',
      refreshToken: 9,
      workerId: 'worker-1',
    },
    state: {
      cursorArticleCreatedAt: new Date('2026-04-02T00:00:00.000Z'),
      cursorArticleId: 'article-2',
      projectId: 'project-1',
      rebuildPhase: 'project_scope_article',
      targetGeneration: null,
    },
  })

  const result = await runProjectMartLargeRebuildCycle({workerId: 'worker-1'}, context.dependencies)

  expect(result).toEqual({
    articleCount: 0,
    nextCursor: null,
    projectId: 'project-1',
    status: 'progressed',
    workerId: 'worker-1',
  })
  expect(context.callLog).toEqual([
    'claim',
    'state:project-1',
    'source-batch:project-1',
    'advance:project-1:null:judgment_fact',
  ])
  expect(context.completed).toEqual([])
})

test('runs one judgment_fact batch from frozen scope and advances the cursor', async () => {
  const context = createRunnerContext({
    martBatchRows: [
      {
        articleCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
        articleId: 'article-1',
        articleUpdatedAt: new Date('2026-04-01T01:00:00.000Z'),
        inCuratedScope: true,
        inRouteScope: false,
      },
      {
        articleCreatedAt: new Date('2026-04-02T00:00:00.000Z'),
        articleId: 'article-2',
        articleUpdatedAt: new Date('2026-04-02T01:00:00.000Z'),
        inCuratedScope: false,
        inRouteScope: true,
      },
    ],
    claim: {
      leaseExpiresAt: new Date('2026-04-03T10:00:00.000Z'),
      projectId: 'project-1',
      rebuildPhase: 'judgment_fact',
      refreshToken: 9,
      workerId: 'worker-1',
    },
    state: {
      cursorArticleCreatedAt: null,
      cursorArticleId: null,
      projectId: 'project-1',
      rebuildPhase: 'judgment_fact',
      targetGeneration: null,
    },
  })

  const result = await runProjectMartLargeRebuildCycle({workerId: 'worker-1'}, context.dependencies)
  const runtimeMetrics = getProjectMartLargeRebuildRuntimeMetrics()

  expect(result).toEqual({
    articleCount: 2,
    nextCursor: {articleCreatedAt: new Date('2026-04-02T00:00:00.000Z'), articleId: 'article-2'},
    projectId: 'project-1',
    status: 'progressed',
    workerId: 'worker-1',
  })
  expect(context.callLog).toEqual([
    'claim',
    'state:project-1',
    'judgment:reset:project-1',
    'mart-batch:project-1',
    'judgment:rebuild:project-1:article-1,article-2',
    'advance:project-1:article-2:judgment_fact',
  ])
  expect(context.scopeBatches).toEqual([])
  expect(runtimeMetrics.totals.cyclesProgressed).toBe(1)
  expect(runtimeMetrics.totals.rowsProcessed).toBe(2)
  expect(runtimeMetrics.recentCycles[0]).toMatchObject({
    articleCount: 2,
    error: null,
    phase: 'judgment_fact',
    projectId: 'project-1',
    status: 'progressed',
    workerId: 'worker-1',
  })
})

test('transitions from judgment_fact to prompt_answer_fact when no frozen scope rows remain for the current cursor', async () => {
  const context = createRunnerContext({
    martBatchRows: [],
    claim: {
      leaseExpiresAt: new Date('2026-04-03T10:00:00.000Z'),
      projectId: 'project-1',
      rebuildPhase: 'judgment_fact',
      refreshToken: 9,
      workerId: 'worker-1',
    },
    state: {
      cursorArticleCreatedAt: new Date('2026-04-02T00:00:00.000Z'),
      cursorArticleId: 'article-2',
      projectId: 'project-1',
      rebuildPhase: 'judgment_fact',
      targetGeneration: null,
    },
  })

  const result = await runProjectMartLargeRebuildCycle({workerId: 'worker-1'}, context.dependencies)

  expect(result).toEqual({
    articleCount: 0,
    nextCursor: null,
    projectId: 'project-1',
    status: 'progressed',
    workerId: 'worker-1',
  })
  expect(context.callLog).toEqual([
    'claim',
    'state:project-1',
    'mart-batch:project-1',
    'advance:project-1:null:prompt_answer_fact',
  ])
  expect(context.completed).toEqual([])
})

test('runs one prompt_answer_fact batch and advances the cursor', async () => {
  const context = createRunnerContext({
    batchRows: [
      {
        articleCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
        articleId: 'article-1',
        articleUpdatedAt: new Date('2026-04-01T01:00:00.000Z'),
        inCuratedScope: true,
        inRouteScope: false,
      },
      {
        articleCreatedAt: new Date('2026-04-02T00:00:00.000Z'),
        articleId: 'article-2',
        articleUpdatedAt: new Date('2026-04-02T01:00:00.000Z'),
        inCuratedScope: false,
        inRouteScope: true,
      },
    ],
    claim: {
      leaseExpiresAt: new Date('2026-04-03T10:00:00.000Z'),
      projectId: 'project-1',
      rebuildPhase: 'prompt_answer_fact',
      refreshToken: 9,
      workerId: 'worker-1',
    },
    state: {
      cursorArticleCreatedAt: null,
      cursorArticleId: null,
      projectId: 'project-1',
      rebuildPhase: 'prompt_answer_fact',
      targetGeneration: null,
    },
  })

  const result = await runProjectMartLargeRebuildCycle({workerId: 'worker-1'}, context.dependencies)
  const runtimeMetrics = getProjectMartLargeRebuildRuntimeMetrics()

  expect(result).toEqual({
    articleCount: 2,
    nextCursor: {articleCreatedAt: new Date('2026-04-02T00:00:00.000Z'), articleId: 'article-2'},
    projectId: 'project-1',
    status: 'progressed',
    workerId: 'worker-1',
  })
  expect(context.callLog).toEqual([
    'claim',
    'state:project-1',
    'reset:project-1',
    'mart-batch:project-1',
    'rebuild:project-1:article-1,article-2',
    'advance:project-1:article-2:prompt_answer_fact',
  ])
  expect(context.rebuildBatches).toEqual([['article-1', 'article-2']])
  expect(runtimeMetrics.totals.cyclesProgressed).toBe(1)
  expect(runtimeMetrics.totals.rowsProcessed).toBe(2)
  expect(runtimeMetrics.recentCycles[0]).toMatchObject({
    articleCount: 2,
    error: null,
    phase: 'prompt_answer_fact',
    projectId: 'project-1',
    status: 'progressed',
    workerId: 'worker-1',
  })
})

test('transitions from prompt_answer_fact to review_answer_dictionary when no rows remain for the current cursor', async () => {
  const context = createRunnerContext({
    batchRows: [],
    claim: {
      leaseExpiresAt: new Date('2026-04-03T10:00:00.000Z'),
      projectId: 'project-1',
      rebuildPhase: 'prompt_answer_fact',
      refreshToken: 9,
      workerId: 'worker-1',
    },
    state: {
      cursorArticleCreatedAt: new Date('2026-04-02T00:00:00.000Z'),
      cursorArticleId: 'article-2',
      projectId: 'project-1',
      rebuildPhase: 'prompt_answer_fact',
      targetGeneration: null,
    },
  })

  const result = await runProjectMartLargeRebuildCycle({workerId: 'worker-1'}, context.dependencies)

  expect(result).toEqual({
    articleCount: 0,
    nextCursor: null,
    projectId: 'project-1',
    status: 'progressed',
    workerId: 'worker-1',
  })
  expect(context.callLog).toEqual([
    'claim',
    'state:project-1',
    'mart-batch:project-1',
    'advance:project-1:null:review_answer_dictionary',
  ])
  expect(context.completed).toEqual([])
})

test('transitions from review_answer_dictionary to review_article_filter_member', async () => {
  const context = createRunnerContext({
    claim: {
      leaseExpiresAt: new Date('2026-04-03T10:00:00.000Z'),
      projectId: 'project-1',
      rebuildPhase: 'review_answer_dictionary',
      refreshToken: 9,
      workerId: 'worker-1',
    },
    state: {
      cursorArticleCreatedAt: null,
      cursorArticleId: null,
      projectId: 'project-1',
      rebuildPhase: 'review_answer_dictionary',
      targetGeneration: null,
    },
  })

  const result = await runProjectMartLargeRebuildCycle({workerId: 'worker-1'}, context.dependencies)

  expect(result).toEqual({
    articleCount: 0,
    nextCursor: null,
    projectId: 'project-1',
    status: 'progressed',
    workerId: 'worker-1',
  })
  expect(context.callLog).toEqual([
    'claim',
    'state:project-1',
    'dictionary:reset:project-1',
    'dictionary:rebuild:project-1',
    'advance:project-1:null:review_article_filter_member',
  ])
  expect(context.resets[0]?.targetGeneration).toBeNull()
})

test('transitions through filter_member rollup and serving to completion', async () => {
  const filterContext = createRunnerContext({
    batchRows: [],
    claim: {
      leaseExpiresAt: new Date('2026-04-03T10:00:00.000Z'),
      projectId: 'project-1',
      rebuildPhase: 'review_article_filter_member',
      refreshToken: 9,
      workerId: 'worker-1',
    },
    state: {
      cursorArticleCreatedAt: null,
      cursorArticleId: null,
      projectId: 'project-1',
      rebuildPhase: 'review_article_filter_member',
      targetGeneration: null,
    },
  })
  const filterResult = await runProjectMartLargeRebuildCycle({workerId: 'worker-1'}, filterContext.dependencies)
  expect(filterResult.status).toBe('progressed')
  expect(filterContext.callLog).toEqual([
    'claim',
    'state:project-1',
    'target:project-1',
    'serving:setup:project-1:1',
    'mart-batch:project-1',
    'advance:project-1:null:review_article_rollup',
  ])
  expect(filterContext.resets[0]?.targetGeneration).toBe(1)

  const rollupContext = createRunnerContext({
    batchRows: [],
    claim: {
      leaseExpiresAt: new Date('2026-04-03T10:00:00.000Z'),
      projectId: 'project-1',
      rebuildPhase: 'review_article_rollup',
      refreshToken: 9,
      workerId: 'worker-1',
    },
    state: {
      cursorArticleCreatedAt: null,
      cursorArticleId: null,
      projectId: 'project-1',
      rebuildPhase: 'review_article_rollup',
      targetGeneration: null,
    },
  })
  const rollupResult = await runProjectMartLargeRebuildCycle({workerId: 'worker-1'}, rollupContext.dependencies)
  expect(rollupResult.status).toBe('progressed')
  expect(rollupContext.callLog).toEqual([
    'claim',
    'state:project-1',
    'rollup:reset:project-1',
    'mart-batch:project-1',
    'advance:project-1:null:review_article_serving',
  ])

  const servingContext = createRunnerContext({
    batchRows: [],
    claim: {
      leaseExpiresAt: new Date('2026-04-03T10:00:00.000Z'),
      projectId: 'project-1',
      rebuildPhase: 'review_article_serving',
      refreshToken: 9,
      workerId: 'worker-1',
    },
    state: {
      cursorArticleCreatedAt: null,
      cursorArticleId: null,
      projectId: 'project-1',
      rebuildPhase: 'review_article_serving',
      targetGeneration: null,
    },
  })
  const servingResult = await runProjectMartLargeRebuildCycle({workerId: 'worker-1'}, servingContext.dependencies)
  expect(servingResult).toEqual({projectId: 'project-1', status: 'completed', workerId: 'worker-1'})
  expect(servingContext.callLog).toEqual([
    'claim',
    'state:project-1',
    'target:project-1',
    'mart-batch:project-1',
    'serving:finalize:project-1:1',
    'refresh:complete:project-1:9',
    'complete:project-1',
    'ack:project-1:9',
  ])
  expect(servingContext.finalizedRefreshes).toEqual([{completedToken: 9, projectId: 'project-1'}])
  expect(servingContext.publishedAcks).toEqual([{ackToken: 9, projectId: 'project-1'}])
})

test('resumes review_article_filter_member with the stored target generation', async () => {
  const context = createRunnerContext({
    batchRows: [
      {
        articleCreatedAt: new Date('2026-04-03T00:00:00.000Z'),
        articleId: 'article-3',
        articleUpdatedAt: new Date('2026-04-03T01:00:00.000Z'),
        inCuratedScope: true,
        inRouteScope: false,
      },
    ],
    claim: {
      leaseExpiresAt: new Date('2026-04-03T10:00:00.000Z'),
      projectId: 'project-1',
      rebuildPhase: 'review_article_filter_member',
      refreshToken: 9,
      workerId: 'worker-2',
    },
    state: {
      cursorArticleCreatedAt: new Date('2026-04-02T00:00:00.000Z'),
      cursorArticleId: 'article-2',
      projectId: 'project-1',
      rebuildPhase: 'review_article_filter_member',
      targetGeneration: 7,
    },
  })

  const result = await runProjectMartLargeRebuildCycle({workerId: 'worker-2'}, context.dependencies)

  expect(result).toEqual({
    articleCount: 1,
    nextCursor: {articleCreatedAt: new Date('2026-04-03T00:00:00.000Z'), articleId: 'article-3'},
    projectId: 'project-1',
    status: 'progressed',
    workerId: 'worker-2',
  })
  expect(context.callLog).toEqual([
    'claim',
    'state:project-1',
    'target:project-1',
    'mart-batch:project-1',
    'filter:rebuild:project-1:article-3:7',
    'advance:project-1:article-3:review_article_filter_member',
  ])
  expect(context.resets[0]?.targetGeneration).toBe(7)
})

test('fails unsupported phases explicitly', async () => {
  const context = createRunnerContext({
    claim: {
      leaseExpiresAt: new Date('2026-04-03T10:00:00.000Z'),
      projectId: 'project-1',
      rebuildPhase: 'review_article_rollup',
      refreshToken: 9,
      workerId: 'worker-1',
    },
    state: null,
  })

  const result = await runProjectMartLargeRebuildCycle({workerId: 'worker-1'}, context.dependencies)
  const runtimeMetrics = getProjectMartLargeRebuildRuntimeMetrics()

  expect(result).toEqual({
    error: 'Missing large rebuild state for project-1',
    projectId: 'project-1',
    status: 'failed',
    workerId: 'worker-1',
  })
  expect(context.failed).toEqual([{error: 'Missing large rebuild state for project-1', projectId: 'project-1'}])
  expect(runtimeMetrics.totals.cyclesFailed).toBe(1)
  expect(runtimeMetrics.recentCycles[0]).toMatchObject({
    articleCount: 0,
    error: 'Missing large rebuild state for project-1',
    phase: 'review_article_rollup',
    projectId: 'project-1',
    status: 'failed',
    workerId: 'worker-1',
  })
})
