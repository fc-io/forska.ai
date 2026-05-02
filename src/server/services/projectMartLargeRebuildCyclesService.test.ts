import {expect, test} from 'bun:test'

import {runProjectMartLargeRebuildCycles} from './projectMartLargeRebuildCyclesService.ts'

test('runProjectMartLargeRebuildCycles returns paused immediately for a paused targeted project', async () => {
  const result = await runProjectMartLargeRebuildCycles(
    {maxCycles: 5, projectId: 'project-paused', workerId: 'worker-paused'},
    {
      getSnapshot: async () => {
        return {rebuildPhase: 'prompt_answer_fact', refreshStatus: 'paused'}
      },
      runCycle: async () => {
        throw new Error('runCycle should not execute for paused projects')
      },
      wait: async () => {
        return undefined
      },
    },
  )

  expect(result.status).toBe('completed')
  expect(result.stopReason).toBe('paused')
  expect(result.completedCycles).toBe(0)
  expect(result.backoffCount).toBe(0)
})

test('runProjectMartLargeRebuildCycles applies bounded backoff before failing repeated no-progress loops', async () => {
  const waits: number[] = []
  const result = await runProjectMartLargeRebuildCycles(
    {maxCycles: 5, maxNoProgressBackoffs: 2, projectId: 'project-backoff', workerId: 'worker-backoff'},
    {
      getSnapshot: async () => {
        return {rebuildPhase: 'prompt_answer_fact', refreshStatus: 'running'}
      },
      runCycle: async () => {
        return {
          articleCount: 1,
          nextCursor: {articleCreatedAt: '2026-04-03T00:00:00.000Z', articleId: 'article-1'},
          projectId: 'project-backoff',
          status: 'progressed',
          workerId: 'worker-backoff',
        }
      },
      wait: async (ms: number) => {
        waits.push(ms)
      },
    },
  )

  expect(result.status).toBe('failed')
  expect(result.stopReason).toBe('no-progress')
  expect(result.completedCycles).toBe(4)
  expect(result.backoffCount).toBe(2)
  expect(result.totalBackoffMs).toBe(750)
  expect(waits).toEqual([250, 500])
})

test('runProjectMartLargeRebuildCycles keeps an untargeted burst on the first progressed project', async () => {
  const requestedProjectIds: Array<string | undefined> = []
  const result = await runProjectMartLargeRebuildCycles(
    {maxCycles: 3, workerId: 'worker-burst'},
    {
      getSnapshot: async (projectId) => {
        return projectId === null
          ? {rebuildPhase: null, refreshStatus: null}
          : {rebuildPhase: 'prompt_answer_fact', refreshStatus: 'running'}
      },
      runCycle: async ({projectId, workerId}) => {
        requestedProjectIds.push(projectId)

        return {
          articleCount: 1,
          nextCursor: {
            articleCreatedAt: `2026-04-03T00:00:0${requestedProjectIds.length}.000Z`,
            articleId: `article-${requestedProjectIds.length}`,
          },
          projectId: projectId ?? 'project-first',
          status: 'progressed',
          workerId,
        }
      },
      wait: async () => {
        return undefined
      },
    },
  )

  expect(result.status).toBe('completed')
  expect(result.stopReason).toBe('max-cycles')
  expect(result.completedCycles).toBe(3)
  expect(requestedProjectIds).toEqual([undefined, 'project-first', 'project-first'])
  expect(
    result.cycleResults.map((cycleResult) => {
      return cycleResult.projectId
    }),
  ).toEqual(['project-first', 'project-first', 'project-first'])
})

test('runProjectMartLargeRebuildCycles stops successfully when the wake budget is exhausted after committed progress', async () => {
  let nowMs = 0
  const requestedProjectIds: Array<string | undefined> = []
  const result = await runProjectMartLargeRebuildCycles(
    {maxCycles: 5, maxWakeMs: 100, projectId: 'project-budget', workerId: 'worker-budget'},
    {
      getSnapshot: async () => {
        return {rebuildPhase: 'prompt_answer_fact', refreshStatus: 'running'}
      },
      now: () => {
        return nowMs
      },
      runCycle: async ({projectId, workerId}) => {
        requestedProjectIds.push(projectId)
        nowMs += 150

        return {
          articleCount: 2,
          nextCursor: {articleCreatedAt: '2026-04-03T00:00:00.000Z', articleId: 'article-budget'},
          projectId: 'project-budget',
          status: 'progressed',
          workerId,
        }
      },
      wait: async () => {
        return undefined
      },
    },
  )

  expect(result.status).toBe('completed')
  expect(result.stopReason).toBe('budget-exhausted')
  expect(result.completedCycles).toBe(1)
  expect(result.elapsedMs).toBe(150)
  expect(result.maxWakeMs).toBe(100)
  expect(requestedProjectIds).toEqual(['project-budget'])
  expect(result.cycleResults[0]).toEqual({
    articleCount: 2,
    nextCursor: {articleCreatedAt: '2026-04-03T00:00:00.000Z', articleId: 'article-budget'},
    projectId: 'project-budget',
    status: 'progressed',
    workerId: 'worker-budget',
  })
})
