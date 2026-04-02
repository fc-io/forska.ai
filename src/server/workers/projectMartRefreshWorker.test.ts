import {beforeEach, expect, mock, test} from 'bun:test'

import {
  type ProjectMartRefreshRunnerService,
  type ProjectMartRefreshStateWorkerService,
  type ProjectMartRefreshWorkerDependencies,
  runProjectMartRefreshWorkerCycle,
} from './projectMartRefreshWorker.ts'

type ClaimPlan = {
  claimedToken: number
  lastCompletedToken: number
  leaseExpiresAt: Date
  projectId: string
  workerId: string
}

const createWorkerTestContext = (params: {
  ackPublishShouldThrow?: boolean
  articlesByProject?: Record<string, string[]>
  claims?: ClaimPlan[]
  onRefreshProject?: (projectId: string) => Promise<void>
  reconciledProjectIds?: string[]
}) => {
  const callLog: string[] = []
  const claims = [...(params.claims ?? [])]
  const acknowledgedProjects: Array<{ackToken: number | null; projectId: string}> = []
  const completed: Array<{completedToken: number; projectId: string; workerId: string}> = []
  const failed: Array<{error: string; projectId: string; workerId: string}> = []
  const heartbeatCalls: Array<{leaseMs: number; projectId: string; workerId: string}> = []
  const stateService: ProjectMartRefreshStateWorkerService = {
    claimDirtyProjects: mock(async ({leaseMs, limit, workerId}: {leaseMs: number; limit: number; workerId: string}) => {
      callLog.push(`claim:${workerId}:${limit}:${leaseMs}`)
      const [claim] = claims

      return claim === undefined ? [] : [claims.shift() as ClaimPlan]
    }),
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
    getDirtyArticlesForClaim: mock(
      async ({projectId}: {claimedToken: number; lastCompletedToken: number; projectId: string}) => {
        callLog.push(`load:${projectId}`)

        return (params.articlesByProject?.[projectId] ?? []).map((articleId) => {
          return {articleId}
        })
      },
    ),
    heartbeatClaim: mock(
      async ({leaseMs, projectId, workerId}: {leaseMs: number; projectId: string; workerId: string}) => {
        callLog.push(`heartbeat:${projectId}`)
        heartbeatCalls.push({leaseMs, projectId, workerId})
        return null
      },
    ),
  }
  const refreshService: ProjectMartRefreshRunnerService = {
    refreshJudgmentArticle: mock(async (articleId: string) => {
      callLog.push(`judgment:${articleId}`)
    }),
    refreshProject: mock(async (projectId: string) => {
      callLog.push(`project:${projectId}`)
      return params.onRefreshProject?.(projectId)
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
  const dependencies: ProjectMartRefreshWorkerDependencies = {
    refreshService,
    sleep: mock(async () => {}),
    sqliteService,
    stateService,
  }

  return {acknowledgedProjects, callLog, completed, dependencies, failed, heartbeatCalls}
}

beforeEach(() => {
  mock.restore()
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

test('refreshes judgment facts before the project rebuild', async () => {
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

  await runProjectMartRefreshWorkerCycle({workerId: 'worker-1'}, context.dependencies)

  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-1:1:30000',
    'load:project-1',
    'judgment:article-2',
    'judgment:article-1',
    'project:project-1',
    'complete:project-1:2',
    'ack:project-1:2',
  ])
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
    onRefreshProject: async () => {
      throw new Error('project refresh exploded')
    },
  })

  const result = await runProjectMartRefreshWorkerCycle({workerId: 'worker-1'}, context.dependencies)

  expect(result).toEqual({
    claimedToken: 7,
    error: 'project refresh exploded',
    projectId: 'project-1',
    status: 'failed',
    workerId: 'worker-1',
  })
  expect(context.failed).toEqual([{error: 'project refresh exploded', projectId: 'project-1', workerId: 'worker-1'}])
  expect(context.completed).toEqual([])
  expect(context.acknowledgedProjects).toEqual([])
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

  const result = await runProjectMartRefreshWorkerCycle({leaseMs: 5_000, workerId: 'worker-2'}, context.dependencies)

  expect(result).toEqual({claimedToken: 4, projectId: 'project-1', status: 'completed', workerId: 'worker-2'})
  expect(context.callLog).toEqual([
    'reconcile:all',
    'claim:worker-2:1:5000',
    'load:project-1',
    'judgment:article-1',
    'project:project-1',
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
