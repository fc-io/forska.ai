import {expect, mock, test} from 'bun:test'

import type {ProjectMartRefreshWorkerDependencies} from './projectMartRefreshWorker.ts'
import {runProjectMartRefreshWorkerCycle} from './projectMartRefreshWorker.ts'

test('dirty refresh worker parks quarantine-blocked claims without publishing ACKs', async () => {
  const callLog: string[] = []
  const dependencies: ProjectMartRefreshWorkerDependencies = {
    largeRebuildStateService: {
      clearArchivedLargeRebuildStates: mock(async () => {
        return null
      }),
      queueLargeRebuild: mock(async () => {
        return null
      }),
    },
    projectInspector: {
      getProjectScopeArticleCount: mock(async () => {
        return 1
      }),
    },
    refreshService: {
      hasActiveProjectReviewServingGeneration: mock(async () => {
        return true
      }),
      refreshJudgmentArticle: mock(async () => {
        return undefined
      }),
      refreshJudgmentFactsForArticles: mock(async (articleIds: string[]) => {
        callLog.push(`judgments:${articleIds.join(',')}`)
      }),
      refreshProjectArticleMartsBatch: mock(async (_projectId: string, articleIds: string[]) => {
        callLog.push(`articleMarts:${articleIds.join(',')}`)
      }),
      refreshProjectScopeArticles: mock(async (_projectId: string, articleIds: string[]) => {
        callLog.push(`scope:${articleIds.join(',')}`)
      }),
    },
    sleep: mock(async () => {
      return undefined
    }),
    sqliteService: {
      publishProjectRefreshAck: mock(async ({ackToken, projectId}: {ackToken: number | null; projectId: string}) => {
        callLog.push(`ack:${projectId}:${ackToken ?? 'null'}`)
        return 1
      }),
      reconcileProjectRefreshAcks: mock(async () => {
        callLog.push('reconcile')
        return 0
      }),
    },
    stateService: {
      claimDirtyProjects: mock(async () => {
        return [
          {
            claimedToken: 2,
            lastCompletedToken: 0,
            leaseExpiresAt: new Date('2026-05-03T08:00:30.000Z'),
            projectId: 'project-1',
            workerId: 'worker-1',
          },
        ]
      }),
      clearArchivedProjectRefreshStates: mock(async () => {
        return null
      }),
      completeDirtyArticleBatchForClaim: mock(async () => {
        callLog.push('complete')
        return {completedState: null, isBlockedByQuarantine: true, isClaimComplete: false}
      }),
      completeProjectRefresh: mock(async () => {
        return null
      }),
      failProjectRefresh: mock(async ({error}: {error: string}) => {
        callLog.push(`fail:${error}`)
        return null
      }),
      getDirtyArticleBatchForClaim: mock(async () => {
        callLog.push('batch')
        return {articleIds: ['article-healthy'], hasMore: false}
      }),
      heartbeatClaim: mock(async () => {
        return null
      }),
      releaseProjectRefreshClaim: mock(async () => {
        return null
      }),
    },
  }

  const result = await runProjectMartRefreshWorkerCycle({workerId: 'worker-1'}, dependencies)

  expect(result).toEqual({
    claimedToken: 2,
    projectId: 'project-1',
    status: 'blocked_by_quarantine',
    workerId: 'worker-1',
  })
  expect(callLog).toEqual([
    'reconcile',
    'batch',
    'scope:article-healthy',
    'judgments:article-healthy',
    'articleMarts:article-healthy',
    'complete',
  ])
})
