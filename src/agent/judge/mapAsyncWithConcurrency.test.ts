import {expect, test} from 'bun:test'

import {mapAsyncWithConcurrency} from './mapAsyncWithConcurrency.ts'

test('mapAsyncWithConcurrency preserves order and limits concurrency', async () => {
  const state = {active: 0, maxActive: 0}

  const result = await mapAsyncWithConcurrency({
    items: [30, 10, 20, 5],
    limit: 2,
    mapItem: async (delayMs, index) => {
      state.active += 1
      state.maxActive = Math.max(state.maxActive, state.active)
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs)
      })
      state.active -= 1
      return index
    },
  })

  expect(result).toEqual([0, 1, 2, 3])
  expect(state.maxActive).toBe(2)
})
