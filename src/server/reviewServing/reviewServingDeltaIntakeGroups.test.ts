import {expect, test} from 'bun:test'

import {getReviewServingDeltaIntakeGroups, runReviewServingDeltaIntakeGroups} from './reviewServingDeltaIntakeGroups.ts'

type Entry = {deltaId: string; dirtyWorkCount: number}

const getGroupIds = (entries: readonly Entry[], maxDirtyWorkPerGroup: number) => {
  return getReviewServingDeltaIntakeGroups({
    entries,
    getDeltaId: (entry) => {
      return entry.deltaId
    },
    getDirtyWorkCount: (entry) => {
      return entry.dirtyWorkCount
    },
    maxDirtyWorkPerGroup,
  }).map((group) => {
    return group.map((entry) => {
      return entry.deltaId
    })
  })
}

test('delta intake groups pack ordered deltas up to the dirty-work bound and never split one delta', () => {
  expect(
    getGroupIds(
      [
        {deltaId: 'a', dirtyWorkCount: 4},
        {deltaId: 'b', dirtyWorkCount: 5},
        {deltaId: 'c', dirtyWorkCount: 2},
        {deltaId: 'c', dirtyWorkCount: 9},
        {deltaId: 'd', dirtyWorkCount: 3},
        {deltaId: 'e', dirtyWorkCount: 7},
        {deltaId: 'f', dirtyWorkCount: 12},
        {deltaId: 'g', dirtyWorkCount: 0},
      ],
      10,
    ),
  ).toEqual([['a', 'b'], ['c', 'c'], ['d', 'e'], ['f'], ['g']])
  expect(getGroupIds([], 10)).toEqual([])
})

test('delta intake groups run in order and stop at the deadline after at least one group', async () => {
  const groups = [['a'], ['b'], ['c']]
  const run = async (input: {deadlineAtMs?: number | null; stepMs: number}) => {
    const ran: string[] = []
    let nowMs = 1_000

    const result = await runReviewServingDeltaIntakeGroups({
      deadlineAtMs: input.deadlineAtMs,
      groups,
      nowMs: () => {
        return nowMs
      },
      runGroup: async (group) => {
        ran.push(...group)
        nowMs += input.stepMs

        return group.length * 9
      },
    })

    return {ran, result}
  }

  expect(await run({stepMs: 1_000})).toEqual({
    ran: ['a', 'b', 'c'],
    result: {committedGroupCount: 3, dirtyWorkCount: 27},
  })
  expect(await run({deadlineAtMs: 0, stepMs: 1_000})).toEqual({
    ran: ['a'],
    result: {committedGroupCount: 1, dirtyWorkCount: 9},
  })
  expect(await run({deadlineAtMs: 2_500, stepMs: 1_000})).toEqual({
    ran: ['a', 'b'],
    result: {committedGroupCount: 2, dirtyWorkCount: 18},
  })
})
