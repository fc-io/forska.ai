import {expect, test} from 'bun:test'

import {
  beginProcessActivity,
  finishProcessActivity,
  getProcessActivitySnapshot,
  recordProcessActivityEvent,
  resetProcessActivityStateForTests,
} from './processActivityState.ts'

test('process activity state tracks active work and keeps a bounded recent history', () => {
  resetProcessActivityStateForTests()

  const activityId = beginProcessActivity({
    category: 'review-serving',
    details: {projectId: 'project-1'},
    label: 'Review-serving projector loop',
    now: new Date('2026-09-21T12:00:00.000Z'),
  })

  expect(getProcessActivitySnapshot().active).toMatchObject([
    {
      category: 'review-serving',
      details: {projectId: 'project-1'},
      id: activityId,
      label: 'Review-serving projector loop',
      status: 'running',
    },
  ])

  finishProcessActivity(activityId, {
    details: {reason: 'completedChunkLimit'},
    now: new Date('2026-09-21T12:00:01.250Z'),
    status: 'completed',
  })
  recordProcessActivityEvent({
    category: 'judgment-cron',
    details: {cronName: 'judgments-jobs-add-to-queue'},
    label: 'Judgment jobs Add To Queue',
    now: new Date('2026-09-21T12:00:02.000Z'),
    status: 'skipped',
  })

  const snapshot = getProcessActivitySnapshot({limit: 1})

  expect(snapshot.active).toEqual([])
  expect(snapshot.recent).toMatchObject([
    {category: 'judgment-cron', label: 'Judgment jobs Add To Queue', status: 'skipped'},
  ])
  expect(getProcessActivitySnapshot().recent).toMatchObject([
    {status: 'skipped'},
    {details: {projectId: 'project-1', reason: 'completedChunkLimit'}, durationMs: 1250, status: 'completed'},
  ])

  const overflowStartedAtMs = new Date('2026-09-21T12:01:00.000Z').getTime()
  Array.from({length: 82}, (_, index) => {
    return recordProcessActivityEvent({
      category: 'judgment-cron',
      label: `Overflow event ${index}`,
      now: new Date(overflowStartedAtMs + index * 1_000),
      status: 'completed',
    })
  })

  const cappedSnapshot = getProcessActivitySnapshot({limit: 200})

  expect(cappedSnapshot.maxRecent).toBe(80)
  expect(cappedSnapshot.recent).toHaveLength(80)
  expect(cappedSnapshot.recent[0]?.label).toBe('Overflow event 81')
  expect(cappedSnapshot.recent.at(-1)?.label).toBe('Overflow event 2')
})
