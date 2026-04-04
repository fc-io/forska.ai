import {expect, test} from 'bun:test'

import {runProjectMartLargeRebuildCycles} from './projectMartLargeRebuildCyclesService.ts'

test('runProjectMartLargeRebuildCycles returns paused immediately for a paused targeted project', async () => {
  const result = await runProjectMartLargeRebuildCycles(
    {maxCycles: 5, projectId: 'project-paused', workerId: 'worker-paused'},
    {
      getSnapshot: async () => ({rebuildPhase: 'prompt_answer_fact', refreshStatus: 'paused'}),
      runCycle: async () => {
        throw new Error('runCycle should not execute for paused projects')
      },
      wait: async () => undefined,
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
      getSnapshot: async () => ({rebuildPhase: 'prompt_answer_fact', refreshStatus: 'running'}),
      runCycle: async () => ({
        articleCount: 1,
        nextCursor: {articleCreatedAt: '2026-04-03T00:00:00.000Z', articleId: 'article-1'},
        projectId: 'project-backoff',
        status: 'progressed',
        workerId: 'worker-backoff',
      }),
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
