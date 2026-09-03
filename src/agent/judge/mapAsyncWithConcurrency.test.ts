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

test('mapAsyncWithConcurrency awaits sibling lanes before rejecting', async () => {
  const completed: number[] = []

  let rejection: unknown = null
  try {
    await mapAsyncWithConcurrency({
      items: [0, 1],
      limit: 2,
      mapItem: async (_item, index) => {
        if (index === 0) {
          throw new Error('lane failed')
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
        completed.push(index)
        return index
      },
    })
  } catch (error) {
    rejection = error
  }

  expect(rejection).toBeInstanceOf(Error)
  expect((rejection as Error).message).toBe('lane failed')
  expect(completed).toEqual([1])
})
