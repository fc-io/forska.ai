import {expect, test} from 'bun:test'

import {
  getReviewServingDeltaIntakeGroups,
  reviewServingDeltaIntakeMaxDirtyWorkPerTransaction,
  runReviewServingDeltaIntakeGroups,
} from './reviewServingDeltaIntakeGroups.ts'
import {reviewServingDirtyWorkBatchChunkSize} from './reviewServingDirtyWorkService.ts'

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

test('delta intake groups start a new group when the whole next delta does not fit', () => {
  expect(
    getGroupIds(
      [
        {deltaId: 'a', dirtyWorkCount: 4},
        {deltaId: 'b', dirtyWorkCount: 3},
        {deltaId: 'b', dirtyWorkCount: 3},
        {deltaId: 'b', dirtyWorkCount: 3},
        {deltaId: 'c', dirtyWorkCount: 1},
      ],
      10,
    ),
  ).toEqual([['a'], ['b', 'b', 'b', 'c']])
  expect(
    getGroupIds(
      [
        {deltaId: 'a', dirtyWorkCount: 6},
        {deltaId: 'b', dirtyWorkCount: 4},
      ],
      10,
    ),
  ).toEqual([['a', 'b']])
})

test('delta intake groups never exceed the default bound for four-project import deltas', () => {
  const entries = Array.from({length: 500}, (_value, deltaIndex) => {
    return Array.from({length: 4}, () => {
      return {deltaId: `delta-${deltaIndex}`, dirtyWorkCount: 9}
    })
  }).flat()
  const groups = getReviewServingDeltaIntakeGroups({
    entries,
    getDeltaId: (entry) => {
      return entry.deltaId
    },
    getDirtyWorkCount: (entry) => {
      return entry.dirtyWorkCount
    },
  })
  const groupSizes = groups.map((group) => {
    return group.reduce((total, entry) => {
      return total + entry.dirtyWorkCount
    }, 0)
  })

  expect(reviewServingDeltaIntakeMaxDirtyWorkPerTransaction).toBe(reviewServingDirtyWorkBatchChunkSize)
  expect(Math.max(...groupSizes)).toBe(Math.floor(reviewServingDirtyWorkBatchChunkSize / 36) * 36)
  expect(
    groupSizes.reduce((total, size) => {
      return total + size
    }, 0),
  ).toBe(500 * 36)
  expect(groups.flat()).toEqual(entries)
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
